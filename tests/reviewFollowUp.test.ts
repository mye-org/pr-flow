import * as TE from 'fp-ts/lib/TaskEither';
import { match } from 'ts-pattern';
import { describe, expect, it, vi } from 'vitest';
import { buildReviewPrompt } from '../src/adapters/agent/prompts.js';
import type { GitHubPort, PrReviewThread } from '../src/adapters/github/types.js';
import { replyAndResolveReviewThreads } from '../src/cli/reviewFollowUp.js';
import { AgentResultSchema, type IssueNode } from '../src/domain/issue.js';
import {
  isoCount,
  isoBody,
  isoIsoTimestamp,
  isoIssueNumber,
  isoLabelName,
  isoMessage,
  isoPrNumber,
  isoTitle,
} from '../src/domain/newtypes.js';

function createMockGithub(overrides: Partial<GitHubPort> = {}) {
  return {
    getIssue: vi.fn(),
    listAllIssues: vi.fn(),
    createIssue: vi.fn(),
    closeIssue: vi.fn(),
    reopenIssue: vi.fn(),
    updateIssueStatus: vi.fn(),
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
    getPullRequest: vi.fn(),
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
    listPrReviewers: vi.fn(),
    requestReviewers: vi.fn(),
    ...overrides,
  };
}

const sampleIssue: IssueNode = {
  number: isoIssueNumber.wrap(12),
  content: {
    title: isoTitle.wrap('Handle edge cases in parser'),
    body: isoBody.wrap('Fix null input handling'),
    labels: [isoLabelName.wrap('type:bug'), isoLabelName.wrap('ai-managed')],
  },
  state: 'open',
  status: 'review_pending',
  type: 'bug',
  subIssueNumbers: [],
  blockedByNumbers: [],
  blockingNumbers: [],
  links: {
    linkedPr: { kind: 'linked', prNumber: isoPrNumber.wrap(34) },
    parent: { kind: 'root' },
  },
  lastUpdatedAt: isoIsoTimestamp.wrap('2026-01-01T00:00:00Z'),
};

const firstThread: PrReviewThread = {
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
};

const secondThread: PrReviewThread = {
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
};

const sampleThreads = [firstThread, secondThread] as const satisfies ReadonlyArray<PrReviewThread>;

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
    match(parsed)
      .with({ success: true }, ({ data }) => {
        expect(data.resolvedComments).toHaveLength(1);
      })
      .with({ success: false }, () => {
        expect.unreachable('Expected parsed success');
      })
      .exhaustive();
  });
});

describe('buildReviewPrompt', () => {
  it('formats unresolved review threads with thread IDs and requests resolvedComments', () => {
    const prompt = buildReviewPrompt({
      issue: sampleIssue,
      prNumber: 34,
      reviewComments: ['[Review CHANGES_REQUESTED by alice]: Please address the inline comments.'],
      reviewThreads: sampleThreads,
      execution: {
        verifyCommand: 'npm test',
        resultFilePath: '/tmp/result.json',
      },
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

    expect(
      await replyAndResolveReviewThreads({
        github: createMockGithub({ replyToReviewThread, resolveReviewThread }),
        branch: 'ai/issue-12',
        agentResult: {
          status: 'success',
          summary: 'Added empty string guard and unit test.',
          testsRun: true,
          resolvedComments: [
            { threadId: 'PRRT_thread_1', reply: 'Added an early return when input is empty.' },
          ],
        },
        threads: sampleThreads,
      }),
    ).toEqual({
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

    expect(
      await replyAndResolveReviewThreads({
        github: createMockGithub({ replyToReviewThread, resolveReviewThread }),
        branch: 'ai/issue-12',
        agentResult: { status: 'success', summary: 'Fixed' },
        threads: [{ ...firstThread, isResolved: true }, secondThread],
      }),
    ).toEqual({ repliedCount: 1, resolvedCount: 1, warnings: [] });
    expect(replyToReviewThread).toHaveBeenCalledTimes(1);
    expect(resolveReviewThread).toHaveBeenCalledWith('PRRT_thread_2');
  });

  it('records warnings and continues if replying or resolving fails for a thread', async () => {
    const resolveReviewThread = vi.fn().mockReturnValue(TE.right(undefined));
    const res = await replyAndResolveReviewThreads({
      github: createMockGithub({
        replyToReviewThread: vi
          .fn()
          .mockReturnValueOnce(
            TE.left({
              type: 'GITHUB_API_ERROR',
              message: isoMessage.wrap('Not found'),
              httpStatus: { kind: 'known', code: isoCount.wrap(404) },
              cause: { kind: 'none' },
            }),
          )
          .mockReturnValueOnce(TE.right(undefined)),
        resolveReviewThread,
      }),
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
