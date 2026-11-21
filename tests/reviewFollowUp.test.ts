import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { describe, expect, it, vi } from 'vitest';
import { buildReviewPrompt } from '../src/adapters/agent/prompts.js';
import type { GitHubPort, PrReviewThread } from '../src/adapters/github/types.js';
import { replyAndResolveReviewThreads } from '../src/cli/reviewFollowUp.js';
import { AgentResultSchema, type AgentResult, type IssueNode } from '../src/domain/issue.js';

function createMockGithub(overrides: Partial<GitHubPort> = {}): GitHubPort {
  return {
    getIssue: vi.fn(),
    listAllIssues: vi.fn(),
    createIssue: vi.fn(),
    closeIssue: vi.fn(),
    reopenIssue: vi.fn(),
    setIssueStatus: vi.fn(),
    ensureStatusField: vi.fn(),
    addLabels: vi.fn(),
    removeLabel: vi.fn(),
    addComment: vi.fn(),
    listIssueComments: vi.fn(),
    ensureLabels: vi.fn(),
    dispatchWorkflow: vi.fn(),
    listSubIssues: vi.fn(),
    addSubIssue: vi.fn(),
    listBlockedBy: vi.fn(),
    listBlocking: vi.fn(),
    addBlockedBy: vi.fn(),
    listOpenPrsForIssue: vi.fn(),
    listOpenAiManagedPrs: vi.fn(),
    createPullRequest: vi.fn(),
    mergePullRequest: vi.fn(),
    checkSetupPrerequisites: vi.fn(),
    addPrComment: vi.fn(),
    getPrReviewComments: vi.fn(),
    getPrReviewThreads: vi.fn(),
    getPrReviewFeedback: vi.fn(),
    replyToReviewThread: vi.fn(),
    resolveReviewThread: vi.fn(),
    ...overrides,
  };
}

const sampleIssue: IssueNode = {
  number: 12,
  title: 'Handle edge cases in parser',
  body: 'Fix null input handling',
  state: 'open',
  status: 'review_pending',
  type: 'bug',
  labels: ['type:bug', 'ai-managed'],
  subIssueNumbers: [],
  blockedByNumbers: [],
  blockingNumbers: [],
  linkedPrNumber: 34,
  parentNumber: null,
  updatedAt: '2026-01-01T00:00:00Z',
};

const sampleThreads: PrReviewThread[] = [
  {
    threadId: 'PRRT_thread_1',
    isResolved: false,
    isOutdated: false,
    path: 'src/parser.ts',
    line: 42,
    comments: [
      {
        id: 'PRRC_1',
        databaseId: 101,
        author: 'alice',
        body: 'Please guard against empty strings here.',
      },
    ],
  },
  {
    threadId: 'PRRT_thread_2',
    isResolved: false,
    isOutdated: false,
    path: 'tests/parser.test.ts',
    line: 15,
    comments: [
      {
        id: 'PRRC_2',
        databaseId: 102,
        author: 'bob',
        body: 'Add a unit test for empty input.',
      },
    ],
  },
];

describe('AgentResultSchema', () => {
  it('accepts optional resolvedComments array', () => {
    const parsed = AgentResultSchema.safeParse({
      status: 'success',
      summary: 'Fixed parser and added test',
      testsRun: true,
      filesChanged: ['src/parser.ts', 'tests/parser.test.ts'],
      resolvedComments: [
        { threadId: 'PRRT_thread_1', reply: 'Added empty string guard in parse().' },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.resolvedComments).toHaveLength(1);
    }
  });
});

describe('buildReviewPrompt', () => {
  it('formats unresolved review threads with thread IDs and requests resolvedComments', () => {
    const prompt = buildReviewPrompt({
      issue: sampleIssue,
      prNumber: 34,
      reviewComments: ['[Review CHANGES_REQUESTED by alice]: Please address the inline comments.'],
      reviewThreads: sampleThreads,
      verifyCommand: 'npm test',
      resultFilePath: '/tmp/result.json',
    });

    expect(prompt).toContain('PRRT_thread_1');
    expect(prompt).toContain('src/parser.ts:42');
    expect(prompt).toContain('Please guard against empty strings here.');
    expect(prompt).toContain('PRRT_thread_2');
    expect(prompt).toContain('resolvedComments');
    expect(prompt).toContain('Please address the inline comments.');
  });
});

describe('replyAndResolveReviewThreads', () => {
  it('replies with thread-specific fix explanations and resolves each unresolved thread', async () => {
    const replyToReviewThread = vi.fn().mockReturnValue(TE.right(undefined));
    const resolveReviewThread = vi.fn().mockReturnValue(TE.right(undefined));
    const github = createMockGithub({ replyToReviewThread, resolveReviewThread });

    const agentResult: AgentResult = {
      status: 'success',
      summary: 'Added empty string guard and unit test.',
      testsRun: true,
      resolvedComments: [
        { threadId: 'PRRT_thread_1', reply: 'Added an early return when input is empty.' },
      ],
    };

    const res = await replyAndResolveReviewThreads({
      github,
      branch: 'ai/issue-12',
      agentResult,
      threads: sampleThreads,
    });

    expect(res).toEqual({
      repliedCount: 2,
      resolvedCount: 2,
      warnings: [],
    });

    expect(replyToReviewThread).toHaveBeenNthCalledWith(
      1,
      'PRRT_thread_1',
      'Added an early return when input is empty.\n\n_(Fixed on `ai/issue-12`)_',
    );
    expect(replyToReviewThread).toHaveBeenNthCalledWith(
      2,
      'PRRT_thread_2',
      'Applied fix on `ai/issue-12`: Added empty string guard and unit test.',
    );
    expect(resolveReviewThread).toHaveBeenNthCalledWith(1, 'PRRT_thread_1');
    expect(resolveReviewThread).toHaveBeenNthCalledWith(2, 'PRRT_thread_2');
  });

  it('skips already-resolved threads', async () => {
    const replyToReviewThread = vi.fn().mockReturnValue(TE.right(undefined));
    const resolveReviewThread = vi.fn().mockReturnValue(TE.right(undefined));
    const github = createMockGithub({ replyToReviewThread, resolveReviewThread });

    const res = await replyAndResolveReviewThreads({
      github,
      branch: 'ai/issue-12',
      agentResult: { status: 'success', summary: 'Fixed' },
      threads: [{ ...sampleThreads[0]!, isResolved: true }, sampleThreads[1]!],
    });

    expect(res).toEqual({ repliedCount: 1, resolvedCount: 1, warnings: [] });
    expect(replyToReviewThread).toHaveBeenCalledTimes(1);
    expect(resolveReviewThread).toHaveBeenCalledWith('PRRT_thread_2');
  });

  it('records warnings and continues if replying or resolving fails for a thread', async () => {
    const replyToReviewThread = vi
      .fn()
      .mockReturnValueOnce(TE.left({ type: 'GITHUB_API_ERROR', message: 'Not found' }))
      .mockReturnValueOnce(TE.right(undefined));
    const resolveReviewThread = vi.fn().mockReturnValue(TE.right(undefined));
    const github = createMockGithub({ replyToReviewThread, resolveReviewThread });

    const res = await replyAndResolveReviewThreads({
      github,
      branch: 'ai/issue-12',
      agentResult: { status: 'success', summary: 'Fixed' },
      threads: sampleThreads,
    });

    expect(res.repliedCount).toBe(1);
    expect(res.resolvedCount).toBe(1);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain('PRRT_thread_1');
    expect(resolveReviewThread).toHaveBeenCalledTimes(1);
    expect(resolveReviewThread).toHaveBeenCalledWith('PRRT_thread_2');
  });
});
