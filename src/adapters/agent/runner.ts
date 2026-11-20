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

function runShell(command: string, cwd: string, env?: NodeJS.ProcessEnv): { ok: boolean; status: number; output: string } {
  const res = spawnSync('bash', ['-lc', command], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim();
  return {
    ok: res.status === 0,
    status: res.status ?? 1,
    output,
  };
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

  let agentCommand: string;
  if (config.agent.provider === 'gemini') {
    const escapedPromptPath = JSON.stringify(promptPath);
    agentCommand = `npx --yes @google/gemini-cli --model ${config.agent.model} --yolo -p "$(cat ${escapedPromptPath})"`;
  } else {
    agentCommand = config.agent.command!;
  }

  const agentRun = runShell(agentCommand, cwd, {
    PR_FLOW_PROMPT_FILE: promptPath,
    PR_FLOW_RESULT_FILE: resultPath,
    GEMINI_CLI_TRUST_WORKSPACE: 'true',
  });

  // Always check if result.json was written
  let parsedResult: AgentResult | null = null;
  if (fs.existsSync(resultPath)) {
    try {
      const rawJson = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
      const validated = AgentResultSchema.safeParse(rawJson);
      if (validated.success) {
        parsedResult = validated.data;
      }
    } catch {
      // Fall through to fallback handling
    }
  }

  if (!agentRun.ok && !parsedResult) {
    return E.left({
      type: 'AGENT_EXECUTION_ERROR',
      message: `Agent CLI exited with code ${agentRun.status}: ${agentRun.output.slice(-1500)}`,
      exitCode: agentRun.status,
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
