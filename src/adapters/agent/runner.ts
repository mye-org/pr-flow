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

  const perModelTimeoutMs = Math.max(
    5 * 60_000,
    Math.floor((config.agent.timeoutMinutes * 60_000) / modelsToTry.length),
  );

  let parsedResult: AgentResult | null = null;
  let lastRun: { ok: boolean; status: number; output: string; timedOut: boolean } | null = null;

  for (let idx = 0; idx < modelsToTry.length; idx++) {
    const modelName = modelsToTry[idx]!;
    if (idx > 0) {
      console.error(`[pr-flow] Falling back to model "${modelName}" after error...`);
      resetWorkingTree(cwd, outputDir);
      if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath);
    }

    const agentCommand =
      config.agent.provider === 'gemini'
        ? `npx --yes @google/gemini-cli --model ${modelName} --yolo -p "$(cat ${JSON.stringify(promptPath)})"`
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
      perModelTimeoutMs,
    );

    lastRun = agentRun;
    parsedResult = tryReadResult(resultPath);

    if (agentRun.ok || parsedResult) {
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

  // Stage untracked files (excluding outputDir) and export full git diff into changes.patch
  try {
    execSync('git add -A', { cwd, stdio: 'pipe' });
    const relOut = path.relative(cwd, outputDir);
    if (relOut && !relOut.startsWith('..') && !path.isAbsolute(relOut)) {
      execSync(`git reset -- ${JSON.stringify(relOut)}`, { cwd, stdio: 'pipe' });
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
