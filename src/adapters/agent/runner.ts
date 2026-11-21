import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as E from 'fp-ts/lib/Either';
import * as O from 'fp-ts/lib/Option';
import type { PrFlowConfig } from '../../domain/config.js';
import type { DomainError } from '../../domain/errors.js';
import { AgentResultSchema, type AgentResult } from '../../domain/issue.js';
import { isoCount, isoMessage } from '../../domain/newtypes.js';
import { buildVerifyFixPrompt } from './prompts.js';

export type AgentRunOutput = {
  result: AgentResult;
  patchPath: string;
  resultPath: string;
  hasChanges: boolean;
};

const TRANSIENT_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
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

export function isTransientAgentError(output: string, timedOut: boolean) {
  if (timedOut) return true;
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(output));
}

const MODEL_UNAVAILABLE_PATTERNS: ReadonlyArray<RegExp> = [
  /ModelNotFoundError/,
  /is no longer available/i,
  /\b404\b/,
];

export function isModelFallbackError(output: string, timedOut: boolean) {
  return (
    isTransientAgentError(output, timedOut) ||
    MODEL_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(output))
  );
}

type ProcessRunResult = {
  readonly ok: boolean;
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
  readonly timedOut: boolean;
};

function runProcess(
  file: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env?: NodeJS.ProcessEnv,
  timeoutMs?: number,
) {
  const res = spawnSync(file, [...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
  });
  const timedOut = res.error !== undefined && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  const stdout = res.stdout;
  const stderr = res.stderr;
  const combined = `${stdout}\n${stderr}`.trim();
  return {
    ok: res.status === 0 && !timedOut,
    status: res.status ?? 1,
    stdout,
    stderr,
    output: timedOut ? `${combined}\n[pr-flow] Command timed out after ${String(timeoutMs ?? 0)}ms`.trim() : combined,
    timedOut,
  };
}

function runShell(
  command: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
  timeoutMs?: number,
) {
  return runProcess('bash', ['-lc', command], cwd, env, timeoutMs);
}

function resetWorkingTree(cwd: string, outputDir: string) {
  try {
    execFileSync('git', ['checkout', '--', '.'], { cwd, stdio: 'pipe' });
    const relOut = path.relative(cwd, outputDir);
    let cleanArgs: ReadonlyArray<string> = ['clean', '-fd', '-e', '.gemini', '-e', '_pr_flow'];
    if (relOut && !relOut.startsWith('..') && !path.isAbsolute(relOut)) {
      cleanArgs = [...cleanArgs, '-e', relOut];
    }
    execFileSync('git', [...cleanArgs], { cwd, stdio: 'pipe' });
  } catch {
    // Best-effort cleanup between model fallback attempts
  }
}

function tryReadResult(resultPath: string) {
  if (!fs.existsSync(resultPath)) return null;
  try {
    const rawJson: unknown = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    const validated = AgentResultSchema.safeParse(rawJson);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

export type GeminiUsageStats = {
  totalTurns?: number;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
}

export type GeminiJsonOutput = {
  response?: string;
  stats?: GeminiUsageStats;
  error?: string;
}

function toFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseGeminiJsonOutput(rawOutput: string) {
  const trimmed = rawOutput.trim();
  if (!trimmed) return null;

  const tryParse = (candidate: string) => {
    try {
      const parsed: unknown = JSON.parse(candidate);
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
  const error = (() => {
    if (typeof obj.error === 'string') return obj.error;
    return typeof errorObj?.message === 'string' ? errorObj.message : undefined;
  })();

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
          typeof m.api === 'object' && m.api !== null
            ? (m.api as Record<string, unknown>)
            : null;
        const tokens =
          typeof m.tokens === 'object' && m.tokens !== null
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

function extractBalancedJsonObjects(text: string) {
  let results: ReadonlyArray<string> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          results = [...results, text.slice(start, i + 1)];
          start = -1;
        }
      }
    }
  }

  return [...results].reverse();
}

export function extractAgentResultFromText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fenced = Array.from(trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi))
    .map((m) => m[1]?.trim() ?? '')
    .filter((s) => s.length > 0)
    .reverse();

  const balanced = extractBalancedJsonObjects(trimmed);

  const candidates: ReadonlyArray<string> = [...fenced, trimmed, ...balanced];

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const validated = AgentResultSchema.safeParse(parsed);
      if (validated.success) return validated.data;
    } catch {
      // Try next candidate
    }
  }
  return null;
}

export function buildGeminiSettings(config: PrFlowConfig) {
  const settings: Record<string, unknown> = {
    model: {
      maxSessionTurns: config.agent.maxSessionTurns,
      compressionThreshold: config.agent.compressionThreshold,
    },
  };

  if (config.agent.thinkingBudget !== undefined) {
    const allModels = Array.from(new Set([config.agent.model, ...config.agent.fallbackModels]));
    settings.modelConfigs = {
      overrides: allModels.map((model) => ({
        match: { model },
        modelConfig: {
          generateContentConfig: {
            thinkingConfig: {
              thinkingBudget: config.agent.thinkingBudget,
            },
          },
        },
      })),
    };
  }

  return settings;
}

export function computeAttemptTimeoutMs(remainingMs: number, remainingModels: number) {
  if (remainingModels <= 1) return Math.max(60_000, remainingMs);
  const reserveForFallbacks = Math.min(5 * 60_000, Math.floor(remainingMs * 0.25));
  return Math.max(60_000, remainingMs - reserveForFallbacks);
}

function logTokenUsage(modelName: string, stats: GeminiUsageStats) {
  const parts = [
    `model=${modelName}`,
    stats.totalTurns !== undefined ? `turns=${String(stats.totalTurns)}` : null,
    stats.inputTokens !== undefined ? `input=${String(stats.inputTokens)}` : null,
    stats.cachedTokens !== undefined ? `cached=${String(stats.cachedTokens)}` : null,
    stats.outputTokens !== undefined ? `output=${String(stats.outputTokens)}` : null,
    stats.thoughtTokens !== undefined && stats.thoughtTokens > 0
      ? `thoughts=${String(stats.thoughtTokens)}`
      : null,
  ].filter(Boolean);
  console.error(`[pr-flow] Agent usage: ${parts.join(' ')}`);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      const line = `- **${modelName}**: turns=${String(stats.totalTurns ?? '?')}, input=${String(stats.inputTokens ?? 0)}, cached=${String(stats.cachedTokens ?? 0)}, output=${String(stats.outputTokens ?? 0)}, thoughts=${String(stats.thoughtTokens ?? 0)}\n`;
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
) {
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
        const parsed: unknown = JSON.parse(previousContent);
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

function invokeAgentWithFallback(params: {
  readonly config: PrFlowConfig;
  readonly prompt: string;
  readonly cwd: string;
  readonly outputDir: string;
  readonly promptPath: string;
  readonly resultPath: string;
  readonly deadlineMs: number;
  readonly resetOnFallback: boolean;
}) {
  const { config, prompt, cwd, outputDir, promptPath, resultPath, deadlineMs, resetOnFallback } = params;
  fs.writeFileSync(promptPath, prompt, 'utf-8');

  const nodeOpts = [process.env.NODE_OPTIONS, '--dns-result-order=ipv4first']
    .filter(Boolean)
    .join(' ');

  const modelsToTry =
    config.agent.provider === 'gemini'
      ? Array.from(new Set([config.agent.model, ...config.agent.fallbackModels]))
      : ['custom'];

  return withTemporaryGeminiSettings(cwd, config, () => {
    let currentResult: AgentResult | null = null;
    let currentLastRun: ProcessRunResult | null = null;

    for (let idx = 0; idx < modelsToTry.length; idx++) {
      const modelName = modelsToTry[idx] ?? 'custom';
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 10_000 && idx > 0) {
        break;
      }

      if (idx > 0) {
        console.error(`[pr-flow] Falling back to model "${modelName}" after error...`);
        if (resetOnFallback) {
          resetWorkingTree(cwd, outputDir);
        }
        if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath);
      }

      const attemptTimeoutMs = computeAttemptTimeoutMs(
        Math.max(60_000, remainingMs),
        modelsToTry.length - idx,
      );

      const env: NodeJS.ProcessEnv = {
        PR_FLOW_PROMPT_FILE: promptPath,
        PR_FLOW_RESULT_FILE: resultPath,
        GEMINI_CLI_TRUST_WORKSPACE: 'true',
        NODE_OPTIONS: nodeOpts,
      };

      const agentRun =
        config.agent.provider === 'gemini'
          ? runProcess(
              'npx',
              ['--yes', '@google/gemini-cli', '--model', modelName, '--yolo', '--output-format', 'json', '-p', prompt],
              cwd,
              env,
              attemptTimeoutMs,
            )
          : runShell(config.agent.command ?? '', cwd, env, attemptTimeoutMs);

      currentLastRun = agentRun;
      const geminiJson =
        config.agent.provider === 'gemini'
          ? (parseGeminiJsonOutput(agentRun.stdout) ?? parseGeminiJsonOutput(agentRun.output))
          : null;
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
}

function collectWorkingTreeContext(cwd: string, outputDir: string) {
  try {
    const relOut = path.relative(cwd, outputDir);
    const excludeArgs = [
      ':(exclude)_pr_flow',
      ':(exclude).gemini',
      ...(relOut && !relOut.startsWith('..') && !path.isAbsolute(relOut)
        ? [`:(exclude)${relOut}`]
        : []),
    ];
    const trackedOut = execFileSync(
      'git',
      ['diff', '--name-only', 'HEAD', '--', '.', ...excludeArgs],
      { cwd, encoding: 'utf-8' },
    );
    const untrackedOut = execFileSync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '--', '.', ...excludeArgs],
      { cwd, encoding: 'utf-8' },
    );
    const changedFiles = Array.from(
      new Set(
        `${trackedOut}\n${untrackedOut}`
          .split('\n')
          .map((f) => f.trim())
          .filter(Boolean),
      ),
    );
    const rawDiff = execFileSync('git', ['diff', 'HEAD', '--', '.', ...excludeArgs], {
      cwd,
      encoding: 'utf-8',
    });
    const MAX_DIFF_CHARS = 12_000;
    const currentDiff =
      rawDiff.length > MAX_DIFF_CHARS
        ? `${rawDiff.slice(0, MAX_DIFF_CHARS)}\n... [diff truncated at ${String(MAX_DIFF_CHARS)} chars]`
        : rawDiff;
    return { changedFiles, currentDiff };
  } catch {
    return { changedFiles: undefined, currentDiff: undefined };
  }
}

function exportChangesPatch(cwd: string, outputDir: string, patchPath: string) {
  try {
    execFileSync('git', ['add', '-A'], { cwd, stdio: 'pipe' });
    const relOut = path.relative(cwd, outputDir);
    if (relOut && !relOut.startsWith('..') && !path.isAbsolute(relOut)) {
      execFileSync('git', ['reset', '-q', '--', relOut], { cwd, stdio: 'pipe' });
    }
    if (fs.existsSync(path.join(cwd, '_pr_flow'))) {
      execFileSync('git', ['reset', '-q', '--', '_pr_flow'], { cwd, stdio: 'pipe' });
    }
    const diff = execFileSync('git', ['diff', '--cached', '--binary'], { cwd, encoding: 'utf-8' });
    fs.writeFileSync(patchPath, diff, 'utf-8');
    return E.right<DomainError, boolean>(diff.trim().length > 0);
  } catch (err) {
    return E.left<DomainError, boolean>({
      type: 'GIT_ERROR',
      message: isoMessage.wrap(`Failed to export changes.patch: ${err instanceof Error ? err.message : String(err)}`),
    });
  }
}

export function runAgentExecution(params: {
  config: PrFlowConfig;
  prompt: string;
  cwd: string;
  outputDir: string;
}) {
  const { config, prompt, cwd, outputDir } = params;
  fs.mkdirSync(outputDir, { recursive: true });

  const promptPath = path.join(outputDir, 'prompt.md');
  const resultPath = path.join(outputDir, 'result.json');
  const patchPath = path.join(outputDir, 'changes.patch');

  if (config.workspace.setupCommand.trim().length > 0) {
    const setup = runShell(config.workspace.setupCommand, cwd);
    if (!setup.ok) {
      return E.left<DomainError, AgentRunOutput>({
        type: 'AGENT_EXECUTION_ERROR',
        message: isoMessage.wrap(`Workspace setupCommand failed: ${setup.output}`),
        exitCode: O.some(isoCount.wrap(setup.status)),
        retryability: O.none,
      });
    }
  }

  const deadlineMs = Date.now() + config.agent.timeoutMinutes * 60_000;

  const { parsedResult, lastRun } = invokeAgentWithFallback({
    config,
    prompt,
    cwd,
    outputDir,
    promptPath,
    resultPath,
    deadlineMs,
    resetOnFallback: true,
  });

  if (lastRun && !lastRun.ok && !parsedResult) {
    const retryable = isTransientAgentError(lastRun.output, lastRun.timedOut);
    return E.left<DomainError, AgentRunOutput>({
      type: 'AGENT_EXECUTION_ERROR',
      message: isoMessage.wrap(`Agent CLI exited with code ${String(lastRun.status)}: ${lastRun.output.slice(-1500)}`),
      exitCode: O.some(isoCount.wrap(lastRun.status)),
      retryability: O.some(retryable ? 'retryable' : 'fatal'),
    });
  }

  // Preserve explicit agent-reported non-success outcomes (e.g., needs_human) without overwriting them via verifyCommand
  if (parsedResult && parsedResult.status !== 'success') {
    fs.writeFileSync(resultPath, JSON.stringify(parsedResult, null, 2), 'utf-8');
    fs.writeFileSync(patchPath, '', 'utf-8');
    return E.right<DomainError, AgentRunOutput>({
      result: parsedResult,
      patchPath,
      resultPath,
      hasChanges: false,
    });
  }

  let latestResult: AgentResult | null = parsedResult;
  let verify = runShell(config.workspace.verifyCommand, cwd);
  let verifyFixAttempt = 0;
  const maxVerifyRetries = config.agent.maxVerifyRetries;

  while (!verify.ok && verifyFixAttempt < maxVerifyRetries) {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 10_000) {
      console.error('[pr-flow] Stopping verify-fix loop: execution timeout reached.');
      break;
    }

    verifyFixAttempt++;
    console.error(
      `[pr-flow] verifyCommand (${config.workspace.verifyCommand}) failed; starting fix attempt ${String(verifyFixAttempt)}/${String(maxVerifyRetries)}...`,
    );

    const { changedFiles, currentDiff } = collectWorkingTreeContext(cwd, outputDir);
    const fixPrompt = buildVerifyFixPrompt({
      verifyCommand: config.workspace.verifyCommand,
      verifyOutput: verify.output.slice(-8000),
      attempt: verifyFixAttempt,
      maxAttempts: maxVerifyRetries,
      resultFilePath: resultPath,
      changedFiles,
      currentDiff,
      previousResolvedComments: latestResult?.resolvedComments,
    });

    if (fs.existsSync(resultPath)) {
      fs.unlinkSync(resultPath);
    }

    const fixRun = invokeAgentWithFallback({
      config,
      prompt: fixPrompt,
      cwd,
      outputDir,
      promptPath,
      resultPath,
      deadlineMs,
      resetOnFallback: false,
    });

    if (fixRun.parsedResult?.status === 'needs_human') {
      const patchExport = exportChangesPatch(cwd, outputDir, patchPath);
      if (E.isLeft(patchExport)) return patchExport;
      fs.writeFileSync(resultPath, JSON.stringify(fixRun.parsedResult, null, 2), 'utf-8');
      return E.right<DomainError, AgentRunOutput>({
        result: fixRun.parsedResult,
        patchPath,
        resultPath,
        hasChanges: patchExport.right,
      });
    }

    if (fixRun.lastRun && !fixRun.lastRun.ok && !fixRun.parsedResult) {
      console.error('[pr-flow] Verify-fix agent invocation failed; stopping fix loop.');
      break;
    }

    if (fixRun.parsedResult) {
      const preservedResolved =
        fixRun.parsedResult.resolvedComments ?? latestResult?.resolvedComments;
      latestResult = {
        ...fixRun.parsedResult,
        ...(preservedResolved ? { resolvedComments: preservedResolved } : {}),
      };
    }

    verify = runShell(config.workspace.verifyCommand, cwd);
  }

  const patchExport = exportChangesPatch(cwd, outputDir, patchPath);
  if (E.isLeft(patchExport)) {
    return patchExport;
  }

  if (!verify.ok) {
    const failedResult: AgentResult = {
      status: 'failed',
      summary: latestResult?.summary ?? 'Agent changes failed verification',
      reason: `verifyCommand (${config.workspace.verifyCommand}) failed after ${String(verifyFixAttempt)} fix attempt(s):\n${verify.output.slice(-1500)}`,
      testsRun: true,
      ...(latestResult?.filesChanged ? { filesChanged: latestResult.filesChanged } : {}),
      ...(latestResult?.resolvedComments ? { resolvedComments: latestResult.resolvedComments } : {}),
    };
    fs.writeFileSync(resultPath, JSON.stringify(failedResult, null, 2), 'utf-8');
    return E.right<DomainError, AgentRunOutput>({
      result: failedResult,
      patchPath,
      resultPath,
      hasChanges: patchExport.right,
    });
  }

  const finalResult: AgentResult = latestResult ?? {
    status: 'success',
    summary: 'Implemented changes and passed verification.',
    testsRun: true,
  };
  fs.writeFileSync(resultPath, JSON.stringify(finalResult, null, 2), 'utf-8');

  return E.right<DomainError, AgentRunOutput>({
    result: finalResult,
    patchPath,
    resultPath,
    hasChanges: patchExport.right,
  });
}
