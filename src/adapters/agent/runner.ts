import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as E from 'fp-ts/Either';
import type { PrFlowConfig } from '../../domain/config.js';
import type { DomainError } from '../../domain/errors.js';
import { AgentResultSchema, type AgentResult } from '../../domain/issue.js';

export interface AgentRunOutput {
  result: AgentResult;
  patchPath: string;
  resultPath: string;
  hasChanges: boolean;
}

const TRANSIENT_ERROR_PATTERNS: readonly RegExp[] = [
  /\b503\b/,
  /\b429\b/,
  /Service Unavailable/i,
  /UNAVAILABLE/,
  /RESOURCE_EXHAUSTED/,
  /Too Many Requests/i,
  /high demand/i,
  /fetch failed/i,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /EAI_AGAIN/,
];

export function isTransientAgentError(output: string, timedOut: boolean): boolean {
  if (timedOut) return true;
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(output));
}

const MODEL_UNAVAILABLE_PATTERNS: readonly RegExp[] = [
  /ModelNotFoundError/,
  /is no longer available/i,
  /\b404\b/,
];

export function isModelFallbackError(output: string, timedOut: boolean): boolean {
  return (
    isTransientAgentError(output, timedOut) ||
    MODEL_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(output))
  );
}

function runShell(
  command: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
  timeoutMs?: number,
): { ok: boolean; status: number; output: string; timedOut: boolean } {
  const res = spawnSync('bash', ['-lc', command], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
  });
  const timedOut = res.error !== undefined && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim();
  return {
    ok: res.status === 0 && !timedOut,
    status: res.status ?? 1,
    output: timedOut ? `${output}\n[pr-flow] Command timed out after ${timeoutMs}ms`.trim() : output,
    timedOut,
  };
}

function resetWorkingTree(cwd: string, outputDir: string): void {
  try {
    execSync('git checkout -- .', { cwd, stdio: 'pipe' });
    const relOut = path.relative(cwd, outputDir);
    const excludeArg =
      relOut && !relOut.startsWith('..') && !path.isAbsolute(relOut)
        ? `-e ${JSON.stringify(relOut)}`
        : '';
    execSync(`git clean -fd ${excludeArg}`, { cwd, stdio: 'pipe' });
  } catch {
    // Best-effort cleanup between model fallback attempts
  }
}

function tryReadResult(resultPath: string): AgentResult | null {
  if (!fs.existsSync(resultPath)) return null;
  try {
    const rawJson = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    const validated = AgentResultSchema.safeParse(rawJson);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

export interface GeminiUsageStats {
  totalTurns?: number;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
}

export interface GeminiJsonOutput {
  response?: string;
  stats?: GeminiUsageStats;
  error?: string;
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseGeminiJsonOutput(rawOutput: string): GeminiJsonOutput | null {
  const trimmed = rawOutput.trim();
  if (!trimmed) return null;

  const tryParse = (candidate: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(candidate);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  let obj = tryParse(trimmed);
  if (!obj) {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      obj = tryParse(trimmed.slice(firstBrace, lastBrace + 1));
    }
  }
  if (!obj) return null;

  const response = typeof obj.response === 'string' ? obj.response : undefined;
  const errorObj =
    typeof obj.error === 'object' && obj.error !== null
      ? (obj.error as Record<string, unknown>)
      : null;
  const error =
    typeof obj.error === 'string'
      ? obj.error
      : typeof errorObj?.message === 'string'
        ? errorObj.message
        : undefined;

  let stats: GeminiUsageStats | undefined;
  const rawStats =
    typeof obj.stats === 'object' && obj.stats !== null
      ? (obj.stats as Record<string, unknown>)
      : null;
  if (rawStats) {
    let inputTokens = 0;
    let cachedTokens = 0;
    let outputTokens = 0;
    let thoughtTokens = 0;
    let totalTurns = 0;
    let hasModelStats = false;

    const models =
      typeof rawStats.models === 'object' && rawStats.models !== null
        ? (rawStats.models as Record<string, Record<string, unknown>>)
        : null;
    if (models) {
      for (const m of Object.values(models)) {
        const api =
          typeof m?.api === 'object' && m.api !== null
            ? (m.api as Record<string, unknown>)
            : null;
        const tokens =
          typeof m?.tokens === 'object' && m.tokens !== null
            ? (m.tokens as Record<string, unknown>)
            : null;
        if (api || tokens) hasModelStats = true;
        totalTurns += toFiniteNumber(api?.totalRequests) ?? 0;
        inputTokens += toFiniteNumber(tokens?.prompt) ?? toFiniteNumber(tokens?.input) ?? 0;
        cachedTokens += toFiniteNumber(tokens?.cached) ?? 0;
        outputTokens += toFiniteNumber(tokens?.candidates) ?? toFiniteNumber(tokens?.output) ?? 0;
        thoughtTokens += toFiniteNumber(tokens?.thoughts) ?? 0;
      }
    }

    const tools =
      typeof rawStats.tools === 'object' && rawStats.tools !== null
        ? (rawStats.tools as Record<string, unknown>)
        : null;
    const totalCalls = toFiniteNumber(tools?.totalCalls);
    if (!hasModelStats && totalCalls !== undefined) {
      totalTurns = totalCalls;
    }

    if (hasModelStats || totalCalls !== undefined) {
      stats = {
        totalTurns,
        inputTokens,
        cachedTokens,
        outputTokens,
        thoughtTokens,
      };
    }
  }

  return { response, stats, error };
}

export function extractAgentResultFromText(text: string): AgentResult | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const candidates: string[] = [trimmed];
  const fencedMatches = trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const m of fencedMatches) {
    if (m[1]) candidates.unshift(m[1].trim());
  }

  const lastOpen = trimmed.lastIndexOf('{');
  const lastClose = trimmed.lastIndexOf('}');
  if (lastOpen >= 0 && lastClose > lastOpen) {
    candidates.push(trimmed.slice(lastOpen, lastClose + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const validated = AgentResultSchema.safeParse(parsed);
      if (validated.success) return validated.data;
    } catch {
      // Try next candidate
    }
  }
  return null;
}

export function buildGeminiSettings(config: PrFlowConfig): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    model: {
      maxSessionTurns: config.agent.maxSessionTurns,
      compressionThreshold: config.agent.compressionThreshold,
    },
  };

  if (config.agent.thinkingBudget !== undefined) {
    settings.modelConfigs = {
      overrides: [
        {
          match: { model: config.agent.model },
          modelConfig: {
            generateContentConfig: {
              thinkingConfig: {
                thinkingBudget: config.agent.thinkingBudget,
              },
            },
          },
        },
      ],
    };
  }

  return settings;
}

export function computeAttemptTimeoutMs(remainingMs: number, remainingModels: number): number {
  if (remainingModels <= 1) return Math.max(60_000, remainingMs);
  const reserveForFallbacks = Math.min(5 * 60_000, Math.floor(remainingMs * 0.25));
  return Math.max(60_000, remainingMs - reserveForFallbacks);
}

function logTokenUsage(modelName: string, stats: GeminiUsageStats): void {
  const parts = [
    `model=${modelName}`,
    stats.totalTurns !== undefined ? `turns=${stats.totalTurns}` : null,
    stats.inputTokens !== undefined ? `input=${stats.inputTokens}` : null,
    stats.cachedTokens !== undefined ? `cached=${stats.cachedTokens}` : null,
    stats.outputTokens !== undefined ? `output=${stats.outputTokens}` : null,
    stats.thoughtTokens !== undefined && stats.thoughtTokens > 0
      ? `thoughts=${stats.thoughtTokens}`
      : null,
  ].filter(Boolean);
  console.error(`[pr-flow] Agent usage: ${parts.join(' ')}`);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      const line = `- **${modelName}**: turns=${stats.totalTurns ?? '?'}, input=${stats.inputTokens ?? 0}, cached=${stats.cachedTokens ?? 0}, output=${stats.outputTokens ?? 0}, thoughts=${stats.thoughtTokens ?? 0}\n`;
      fs.appendFileSync(summaryPath, line, 'utf-8');
    } catch {
      // Best-effort CI step summary logging
    }
  }
}

function withTemporaryGeminiSettings<T>(
  cwd: string,
  config: PrFlowConfig,
  fn: () => T,
): T {
  if (config.agent.provider !== 'gemini') {
    return fn();
  }

  const geminiDir = path.join(cwd, '.gemini');
  const settingsPath = path.join(geminiDir, 'settings.json');
  const dirExisted = fs.existsSync(geminiDir);
  const fileExisted = fs.existsSync(settingsPath);
  const previousContent = fileExisted ? fs.readFileSync(settingsPath, 'utf-8') : null;

  try {
    fs.mkdirSync(geminiDir, { recursive: true });
    let merged: Record<string, unknown> = {};
    if (previousContent) {
      try {
        const parsed = JSON.parse(previousContent);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          merged = parsed as Record<string, unknown>;
        }
      } catch {
        // Ignore malformed existing settings
      }
    }
    const generated = buildGeminiSettings(config);
    const nextSettings = {
      ...merged,
      ...generated,
      model: {
        ...(typeof merged.model === 'object' && merged.model !== null
          ? (merged.model as Record<string, unknown>)
          : {}),
        ...(generated.model as Record<string, unknown>),
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(nextSettings, null, 2), 'utf-8');
    return fn();
  } finally {
    try {
      if (fileExisted && previousContent !== null) {
        fs.writeFileSync(settingsPath, previousContent, 'utf-8');
      } else if (fs.existsSync(settingsPath)) {
        fs.unlinkSync(settingsPath);
      }
      if (!dirExisted && fs.existsSync(geminiDir)) {
        const remaining = fs.readdirSync(geminiDir);
        if (remaining.length === 0) {
          fs.rmdirSync(geminiDir);
        }
      }
    } catch {
      // Best-effort cleanup
    }
  }
}

export function runAgentExecution(params: {
  config: PrFlowConfig;
  prompt: string;
  cwd: string;
  outputDir: string;
}): E.Either<DomainError, AgentRunOutput> {
  const { config, prompt, cwd, outputDir } = params;
  fs.mkdirSync(outputDir, { recursive: true });

  const promptPath = path.join(outputDir, 'prompt.md');
  const resultPath = path.join(outputDir, 'result.json');
  const patchPath = path.join(outputDir, 'changes.patch');
  fs.writeFileSync(promptPath, prompt, 'utf-8');

  if (config.workspace.setupCommand.trim().length > 0) {
    const setup = runShell(config.workspace.setupCommand, cwd);
    if (!setup.ok) {
      return E.left({
        type: 'AGENT_EXECUTION_ERROR',
        message: `Workspace setupCommand failed: ${setup.output}`,
        exitCode: setup.status,
      });
    }
  }

  const nodeOpts = [process.env.NODE_OPTIONS, '--dns-result-order=ipv4first']
    .filter(Boolean)
    .join(' ');

  const modelsToTry =
    config.agent.provider === 'gemini'
      ? Array.from(new Set([config.agent.model, ...config.agent.fallbackModels]))
      : ['custom'];

  const deadlineMs = Date.now() + config.agent.timeoutMinutes * 60_000;

  const { parsedResult, lastRun } = withTemporaryGeminiSettings(cwd, config, () => {
    let currentResult: AgentResult | null = null;
    let currentLastRun: { ok: boolean; status: number; output: string; timedOut: boolean } | null =
      null;

    for (let idx = 0; idx < modelsToTry.length; idx++) {
      const modelName = modelsToTry[idx]!;
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 10_000 && idx > 0) {
        break;
      }

      if (idx > 0) {
        console.error(`[pr-flow] Falling back to model "${modelName}" after error...`);
        resetWorkingTree(cwd, outputDir);
        if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath);
      }

      const attemptTimeoutMs = computeAttemptTimeoutMs(
        Math.max(60_000, remainingMs),
        modelsToTry.length - idx,
      );

      const agentCommand =
        config.agent.provider === 'gemini'
          ? `npx --yes @google/gemini-cli --model ${modelName} --yolo --output-format json -p "$(cat ${JSON.stringify(promptPath)})"`
          : config.agent.command!;

      const agentRun = runShell(
        agentCommand,
        cwd,
        {
          PR_FLOW_PROMPT_FILE: promptPath,
          PR_FLOW_RESULT_FILE: resultPath,
          GEMINI_CLI_TRUST_WORKSPACE: 'true',
          NODE_OPTIONS: nodeOpts,
        },
        attemptTimeoutMs,
      );

      currentLastRun = agentRun;
      const geminiJson =
        config.agent.provider === 'gemini' ? parseGeminiJsonOutput(agentRun.output) : null;
      if (geminiJson?.stats) {
        logTokenUsage(modelName, geminiJson.stats);
      }

      currentResult = tryReadResult(resultPath);
      if (!currentResult && geminiJson?.response) {
        currentResult = extractAgentResultFromText(geminiJson.response);
        if (currentResult) {
          fs.writeFileSync(resultPath, JSON.stringify(currentResult, null, 2), 'utf-8');
        }
      }

      if (agentRun.ok || currentResult) {
        break;
      }

      if (agentRun.output.length > 0) {
        console.error(
          `--- Agent CLI Output (model=${modelName}) ---\n${agentRun.output}\n--- End Agent CLI Output ---`,
        );
      }

      if (!isModelFallbackError(agentRun.output, agentRun.timedOut)) {
        break;
      }
    }

    return { parsedResult: currentResult, lastRun: currentLastRun };
  });

  if (lastRun && !lastRun.ok && !parsedResult) {
    const retryable = isTransientAgentError(lastRun.output, lastRun.timedOut);
    return E.left({
      type: 'AGENT_EXECUTION_ERROR',
      message: `Agent CLI exited with code ${lastRun.status}: ${lastRun.output.slice(-1500)}`,
      exitCode: lastRun.status,
      retryable,
    });
  }

  // Run deterministic workspace.verifyCommand regardless of agent claims
  const verify = runShell(config.workspace.verifyCommand, cwd);
  if (!verify.ok) {
    const fallback: AgentResult = {
      status: 'failed',
      summary: parsedResult?.summary ?? 'Agent changes failed verification',
      reason: `verifyCommand (${config.workspace.verifyCommand}) failed:\n${verify.output.slice(-1500)}`,
      testsRun: true,
    };
    fs.writeFileSync(resultPath, JSON.stringify(fallback, null, 2), 'utf-8');
    return E.right({
      result: fallback,
      patchPath,
      resultPath,
      hasChanges: false,
    });
  }

  const finalResult: AgentResult = parsedResult ?? {
    status: 'success',
    summary: 'Implemented changes and passed verification.',
    testsRun: true,
  };
  fs.writeFileSync(resultPath, JSON.stringify(finalResult, null, 2), 'utf-8');

  // Stage untracked files (excluding outputDir and _pr_flow) and export full git diff into changes.patch
  try {
    execSync('git add -A', { cwd, stdio: 'pipe' });
    const relOut = path.relative(cwd, outputDir);
    if (relOut && !relOut.startsWith('..') && !path.isAbsolute(relOut)) {
      execSync(`git reset -q -- ${JSON.stringify(relOut)}`, { cwd, stdio: 'pipe' });
    }
    if (fs.existsSync(path.join(cwd, '_pr_flow'))) {
      execSync('git reset -q -- _pr_flow', { cwd, stdio: 'pipe' });
    }
    const diff = execSync('git diff --cached --binary', { cwd, encoding: 'utf-8' });
    fs.writeFileSync(patchPath, diff, 'utf-8');
    return E.right({
      result: finalResult,
      patchPath,
      resultPath,
      hasChanges: diff.trim().length > 0,
    });
  } catch (err) {
    return E.left({
      type: 'GIT_ERROR',
      message: `Failed to export changes.patch: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
