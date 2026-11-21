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

  it('returns null when JSON does not match AgentResultSchema', () => {
    expect(extractAgentResultFromText('{"foo":"bar"}')).toBeNull();
  });
});

describe('buildGeminiSettings', () => {
  it('builds settings with maxSessionTurns, compressionThreshold, and optional thinkingBudget', () => {
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
          fallbackModels: [],
          maxRetries: 3,
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
        ],
      },
    });
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
