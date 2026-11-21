import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as E from 'fp-ts/lib/Either';
import { pipe } from 'fp-ts/lib/function';
import * as O from 'fp-ts/lib/Option';
import { describe, expect, it } from 'vitest';
import { buildImplementPrompt, buildReviewPrompt } from '../src/adapters/agent/prompts.js';
import {
  buildGeminiSettings,
  computeAttemptTimeoutMs,
  extractAgentResultFromText,
  isModelFallbackError,
  isTransientAgentError,
  parseGeminiJsonOutput,
  runAgentExecution,
} from '../src/adapters/agent/runner.js';
import type { PrFlowConfig } from '../src/domain/config.js';
import type { IssueNode } from '../src/domain/issue.js';
import {
  isoBody,
  isoIsoTimestamp,
  isoIssueNumber,
  isoLabelName,
  isoTitle,
} from '../src/domain/newtypes.js';

describe('isTransientAgentError', () => {
  it('detects 503, 429, UNAVAILABLE, fetch failed, and timeouts as transient', () => {
    expect(isTransientAgentError('Attempt 1 failed with status 503. Service Unavailable', false)).toBe(true);
    expect(isTransientAgentError('status: 429 Too Many Requests', false)).toBe(true);
    expect(isTransientAgentError('TypeError: fetch failed sending request', false)).toBe(true);
    expect(isTransientAgentError('', true)).toBe(true);
  });

  it('does not classify 404 or non-transient code errors as retryable', () => {
    expect(isTransientAgentError('ModelNotFoundError: 404 is no longer available', false)).toBe(false);
    expect(isTransientAgentError('TypeError: Cannot read properties of undefined', false)).toBe(false);
    expect(isTransientAgentError('SyntaxError: Unexpected token', false)).toBe(false);
  });
});

describe('isModelFallbackError', () => {
  it('triggers fallback on transient errors and 404 ModelNotFoundError', () => {
    expect(isModelFallbackError('status 503 Service Unavailable', false)).toBe(true);
    expect(isModelFallbackError('ModelNotFoundError: This model is no longer available', false)).toBe(true);
    expect(isModelFallbackError('code: 404', false)).toBe(true);
    expect(isModelFallbackError('SyntaxError: Unexpected token', false)).toBe(false);
  });
});

describe('parseGeminiJsonOutput', () => {
  it('parses response and aggregated token/turn stats from gemini-cli JSON output', () => {
    const parsed = parseGeminiJsonOutput(
      `Loaded cached credentials.\n${JSON.stringify({
        response: 'Done!\n```json\n{"status":"success","summary":"Added feature","testsRun":true}\n```',
        stats: {
          models: {
            'gemini-3.8-flash': {
              api: { totalRequests: 4 },
              tokens: { prompt: 12000, cached: 8000, candidates: 450, thoughts: 300 },
            },
          },
          tools: { totalCalls: 3 },
        },
      })}`,
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.stats).toEqual({
      totalTurns: 4,
      inputTokens: 12000,
      cachedTokens: 8000,
      outputTokens: 450,
      thoughtTokens: 300,
    });
    expect(parsed?.response).toContain('"status":"success"');
  });

  it('returns null for non-JSON output', () => {
    expect(parseGeminiJsonOutput('plain error text')).toBeNull();
  });
});

describe('extractAgentResultFromText', () => {
  it('extracts valid AgentResult from fenced JSON block', () => {
    expect(
      extractAgentResultFromText(
        'Completed.\n```json\n{"status":"success","summary":"Fixed bug","testsRun":true,"filesChanged":["src/a.ts"]}\n```',
      ),
    ).toEqual({
      status: 'success',
      summary: 'Fixed bug',
      testsRun: true,
      filesChanged: ['src/a.ts'],
    });
  });

  it('extracts unfenced AgentResult with nested resolvedComments objects and braces in strings', () => {
    expect(
      extractAgentResultFromText(
        'All review comments addressed. Final payload: ' +
          '{"status":"success","summary":"Handled {edge} cases","testsRun":true,' +
          '"resolvedComments":[{"threadId":"PRRT_1","reply":"Added guard for {empty} input"}]}',
      ),
    ).toEqual({
      status: 'success',
      summary: 'Handled {edge} cases',
      testsRun: true,
      resolvedComments: [{ threadId: 'PRRT_1', reply: 'Added guard for {empty} input' }],
    });
  });

  it('returns null when JSON does not match AgentResultSchema', () => {
    expect(extractAgentResultFromText('{"foo":"bar"}')).toBeNull();
  });
});

describe('buildGeminiSettings', () => {
  it('builds settings with maxSessionTurns, compressionThreshold, and thinkingBudget for primary and fallback models', () => {
    expect(
      buildGeminiSettings({
        version: 1,
        wipLimit: 4,
        baseBranch: 'main',
        statusFieldName: 'pr-flow-status',
        workspace: { setupCommand: '', verifyCommand: 'npm test' },
        agent: {
          provider: 'gemini',
          model: 'gemini-3.8-flash',
          fallbackModels: ['gemini-3.5-flash-lite'],
          maxRetries: 3,
          maxVerifyRetries: 10,
          timeoutMinutes: 20,
          maxSessionTurns: 20,
          compressionThreshold: 0.2,
          thinkingBudget: 2048,
        },
        triggers: {
          reviewMode: 'changes_requested',
          autoPickup: true,
          autoMergeOnApprove: true,
          mergeMethod: 'squash',
        },
      } satisfies PrFlowConfig),
    ).toEqual({
      model: { maxSessionTurns: 20, compressionThreshold: 0.2 },
      modelConfigs: {
        overrides: [
          {
            match: { model: 'gemini-3.8-flash' },
            modelConfig: {
              generateContentConfig: {
                thinkingConfig: { thinkingBudget: 2048 },
              },
            },
          },
          {
            match: { model: 'gemini-3.5-flash-lite' },
            modelConfig: {
              generateContentConfig: {
                thinkingConfig: { thinkingBudget: 2048 },
              },
            },
          },
        ],
      },
    });
  });
});

describe('runAgentExecution', () => {
  it('preserves needs_human result without overwriting it when verifyCommand fails', () => {
    const tmpDir = pipe(path.join(os.tmpdir(), 'pr-flow-runner-'), (prefix: string) =>
      fs.mkdtempSync(prefix),
    );
    try {
      const res = runAgentExecution({
        config: {
          version: 1,
          wipLimit: 4,
          baseBranch: 'main',
          statusFieldName: 'pr-flow-status',
          workspace: { setupCommand: '', verifyCommand: 'exit 1' },
          agent: {
            provider: 'custom',
            model: 'custom',
            command:
              'printf \'{"status":"needs_human","summary":"Blocked","reason":"Need API spec","testsRun":false}\' > "$PR_FLOW_RESULT_FILE"',
            fallbackModels: [],
            maxRetries: 1,
            maxVerifyRetries: 2,
            timeoutMinutes: 5,
            maxSessionTurns: 10,
            compressionThreshold: 0.2,
          },
          triggers: {
            reviewMode: 'changes_requested',
            autoPickup: true,
            autoMergeOnApprove: true,
            mergeMethod: 'squash',
          },
        },
        prompt: 'Implement feature',
        cwd: tmpDir,
        outputDir: path.join(tmpDir, 'out'),
      });

      expect(E.isRight(res)).toBe(true);
      if (E.isRight(res)) {
        expect(res.right.result.status).toBe('needs_human');
        expect(res.right.result.reason).toBe('Need API spec');
        expect(res.right.hasChanges).toBe(false);
        expect(fs.existsSync(res.right.patchPath)).toBe(true);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('loops verifyCommand failures back to the agent until fixed and preserves resolvedComments', async () => {
    const { execFileSync } = await import('node:child_process');
    const tmpDir = pipe(path.join(os.tmpdir(), 'pr-flow-verify-fix-'), (prefix: string) =>
      fs.mkdtempSync(prefix),
    );
    try {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir, stdio: 'pipe' });
      fs.writeFileSync(path.join(tmpDir, 'app.txt'), 'initial\n', 'utf-8');
      execFileSync('git', ['add', '-A'], { cwd: tmpDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'pipe' });

      // First run writes 'broken\n' and resolvedComments; second run (fix) writes 'fixed\n'
      const agentScript = `
if [ ! -f app.txt ] || grep -q "initial" app.txt; then
  printf 'broken\\n' > app.txt
  printf '{"status":"success","summary":"Initial impl","testsRun":true,"resolvedComments":[{"threadId":"T1","reply":"Fixed"}]}' > "$PR_FLOW_RESULT_FILE"
else
  printf 'fixed\\n' > app.txt
  printf '{"status":"success","summary":"Fixed lint","testsRun":true}' > "$PR_FLOW_RESULT_FILE"
fi
`;

      const res = runAgentExecution({
        config: {
          version: 1,
          wipLimit: 4,
          baseBranch: 'main',
          statusFieldName: 'pr-flow-status',
          workspace: { setupCommand: '', verifyCommand: 'grep -q "^fixed$" app.txt' },
          agent: {
            provider: 'custom',
            model: 'custom',
            command: agentScript,
            fallbackModels: [],
            maxRetries: 1,
            maxVerifyRetries: 3,
            timeoutMinutes: 5,
            maxSessionTurns: 10,
            compressionThreshold: 0.2,
          },
          triggers: {
            reviewMode: 'changes_requested',
            autoPickup: true,
            autoMergeOnApprove: true,
            mergeMethod: 'squash',
          },
        },
        prompt: 'Implement feature',
        cwd: tmpDir,
        outputDir: path.join(tmpDir, 'out'),
      });

      expect(E.isRight(res)).toBe(true);
      if (E.isRight(res)) {
        expect(res.right.result.status).toBe('success');
        expect(res.right.result.summary).toBe('Fixed lint');
        expect(res.right.result.resolvedComments).toEqual([{ threadId: 'T1', reply: 'Fixed' }]);
        expect(res.right.hasChanges).toBe(true);
        const patch = fs.readFileSync(res.right.patchPath, 'utf-8');
        expect(patch).toContain('+fixed');
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exports partial changes.patch when verifyCommand still fails after maxVerifyRetries', async () => {
    const { execFileSync } = await import('node:child_process');
    const tmpDir = pipe(path.join(os.tmpdir(), 'pr-flow-verify-fail-'), (prefix: string) =>
      fs.mkdtempSync(prefix),
    );
    try {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir, stdio: 'pipe' });
      fs.writeFileSync(path.join(tmpDir, 'app.txt'), 'initial\n', 'utf-8');
      execFileSync('git', ['add', '-A'], { cwd: tmpDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'pipe' });

      const agentScript = `
printf 'partial-wip\\n' > app.txt
printf '{"status":"success","summary":"Partial work","testsRun":true}' > "$PR_FLOW_RESULT_FILE"
`;

      const res = runAgentExecution({
        config: {
          version: 1,
          wipLimit: 4,
          baseBranch: 'main',
          statusFieldName: 'pr-flow-status',
          workspace: { setupCommand: '', verifyCommand: 'echo "lint error" >&2 && exit 1' },
          agent: {
            provider: 'custom',
            model: 'custom',
            command: agentScript,
            fallbackModels: [],
            maxRetries: 1,
            maxVerifyRetries: 1,
            timeoutMinutes: 5,
            maxSessionTurns: 10,
            compressionThreshold: 0.2,
          },
          triggers: {
            reviewMode: 'changes_requested',
            autoPickup: true,
            autoMergeOnApprove: true,
            mergeMethod: 'squash',
          },
        },
        prompt: 'Implement feature',
        cwd: tmpDir,
        outputDir: path.join(tmpDir, 'out'),
      });

      expect(E.isRight(res)).toBe(true);
      if (E.isRight(res)) {
        expect(res.right.result.status).toBe('failed');
        expect(res.right.result.reason).toContain('after 1 fix attempt(s)');
        expect(res.right.result.reason).toContain('lint error');
        expect(res.right.hasChanges).toBe(true);
        const patch = fs.readFileSync(res.right.patchPath, 'utf-8');
        expect(patch).toContain('+partial-wip');
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('computeAttemptTimeoutMs', () => {
  it('gives primary model 75% (or reserves max 5m) when fallbacks exist and 100% on last model', () => {
    expect(computeAttemptTimeoutMs(20 * 60_000, 3)).toBe(15 * 60_000);
    expect(computeAttemptTimeoutMs(8 * 60_000, 2)).toBe(6 * 60_000);
    expect(computeAttemptTimeoutMs(10 * 60_000, 1)).toBe(10 * 60_000);
  });
});

describe('prompt construction', () => {
  const sampleIssue: IssueNode = {
    number: isoIssueNumber.wrap(42),
    title: isoTitle.wrap('Optimize agent tokens'),
    body: isoBody.wrap('Reduce unnecessary round-trips.'),
    state: 'open',
    status: 'in_progress',
    type: 'task',
    labels: [isoLabelName.wrap('type:task'), isoLabelName.wrap('ai-managed')],
    subIssueNumbers: [],
    blockedByNumbers: [],
    blockingNumbers: [],
    linkedPrNumber: O.none,
    parentNumber: O.none,
    updatedAt: isoIsoTimestamp.wrap('2026-11-21T00:00:00Z'),
  };

  it('places static instructions before dynamic issue and repo file tree for prefix caching', () => {
    const prompt = buildImplementPrompt({
      issue: sampleIssue,
      verifyCommand: 'npm test',
      agentsMd: 'Keep code clean.',
      resultFilePath: '/tmp/result.json',
      repoFiles: ['src/index.ts', 'tests/index.test.ts'],
    });
    expect(prompt.indexOf('## Repository Instructions (AGENTS.md)')).toBeLessThan(
      prompt.indexOf('## Repository File Tree'),
    );
    expect(prompt.indexOf('## Strict Execution Rules')).toBeLessThan(
      prompt.indexOf('## Issue Details'),
    );
    expect(prompt).toContain('src/index.ts');
  });

  it('includes issue body, changed files, and PR diff in buildReviewPrompt', () => {
    const prompt = buildReviewPrompt({
      issue: sampleIssue,
      prNumber: 99,
      reviewComments: ['[Review CHANGES_REQUESTED]: Please add a test.'],
      verifyCommand: 'npm test',
      resultFilePath: '/tmp/result.json',
      changedFiles: ['src/a.ts'],
      prDiff: 'diff --git a/src/a.ts b/src/a.ts',
    });
    expect(prompt).toContain('Reduce unnecessary round-trips.');
    expect(prompt).toContain('## Changed Files on PR #99');
    expect(prompt).toContain('## Current PR Diff');
    expect(prompt.indexOf('## Strict Execution Rules')).toBeLessThan(
      prompt.indexOf('## Review Feedback to Address'),
    );
  });
});
