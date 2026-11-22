import * as E from 'fp-ts/lib/Either';
import * as TE from 'fp-ts/lib/TaskEither';
import { match } from 'ts-pattern';
import { describe, expect, it, vi } from 'vitest';
import type { GitHubPort, ManagedPrSummary } from '../src/adapters/github/types.js';
import {
  parseIssueNumberFromBranch,
  recomputeContainerRollups,
  shouldRetryReviewPr,
} from '../src/cli/reconcileHelpers.js';
import type { IssueNode } from '../src/domain/issue.js';
import {
  isoBody,
  isoIsoTimestamp,
  isoIssueNumber,
  isoLabelName,
  isoTitle,
} from '../src/domain/newtypes.js';

function makeIssue(num: number, overrides: Partial<IssueNode> = {}) {
  return {
    number: isoIssueNumber.wrap(num),
    content: {
      title: isoTitle.wrap(`Issue #${String(num)}`),
      body: isoBody.wrap(''),
      labels: [isoLabelName.wrap('type:task'), isoLabelName.wrap('ai-managed')],
    },
    state: 'open' as const,
    status: 'backlog' as const,
    type: 'task' as const,
    subIssueNumbers: [],
    blockedByNumbers: [],
    blockingNumbers: [],
    links: {
      linkedPr: { kind: 'none' },
      parent: { kind: 'root' },
    },
    lastUpdatedAt: isoIsoTimestamp.wrap('2026-11-20T00:00:00Z'),
    ...overrides,
  } satisfies IssueNode;
}

describe('parseIssueNumberFromBranch', () => {
  it('extracts issue numbers from ai/issue-<N> branches and ignores others', () => {
    expect(parseIssueNumberFromBranch('ai/issue-42')).toBe(42);
    expect(parseIssueNumberFromBranch('feature/other')).toBeNull();
  });
});

describe('shouldRetryReviewPr', () => {
  const basePr: ManagedPrSummary = {
    number: 10,
    headRef: 'ai/issue-5',
    issueNumber: 5,
    updatedAt: '2026-11-20T10:00:00Z',
    latestReviewState: 'CHANGES_REQUESTED',
    latestReviewSubmittedAt: '2026-11-20T10:00:00Z',
    lastFixCommentAt: null,
  };
  const pendingIssue = makeIssue(5, { status: 'review_pending' });
  const nowMs = Date.parse('2026-11-20T11:00:00Z');
  const cooldownMs = 10 * 60_000;

  it('allows retry when CHANGES_REQUESTED has not yet been addressed and cooldown elapsed', () => {
    expect(
      shouldRetryReviewPr({
        pr: basePr,
        linkedIssue: pendingIssue,
        nowMs,
        cooldownMs,
      }),
    ).toBe(true);
  });

  it('skips retry when bot already posted a review-fix comment after the latest CHANGES_REQUESTED review', () => {
    expect(
      shouldRetryReviewPr({
        pr: { ...basePr, lastFixCommentAt: '2026-11-20T10:05:00Z' },
        linkedIssue: pendingIssue,
        nowMs,
        cooldownMs,
      }),
    ).toBe(false);
  });

  it('allows retry when a newer CHANGES_REQUESTED review arrived after a previous fix comment', () => {
    expect(
      shouldRetryReviewPr({
        pr: {
          ...basePr,
          lastFixCommentAt: '2026-11-20T10:05:00Z',
          latestReviewSubmittedAt: '2026-11-20T10:30:00Z',
          updatedAt: '2026-11-20T10:30:00Z',
        },
        linkedIssue: pendingIssue,
        nowMs,
        cooldownMs,
      }),
    ).toBe(true);
  });
});

describe('recomputeContainerRollups', () => {
  it('converges 3-level Epic -> Story -> Task hierarchy in a single pass and identifies container stories', async () => {
    let recordedStatus: ReadonlyArray<readonly [number, string]> = [];
    let closedIssues: ReadonlyArray<number> = [];

    // Deliberately insert Epic before Story to verify bottom-up convergence
    const res = await recomputeContainerRollups(
      new Map<number, IssueNode>([
        [1, makeIssue(1, { type: 'epic', status: 'in_progress' })],
        [2, makeIssue(2, { type: 'story', status: 'in_progress' })],
        [3, makeIssue(3, { type: 'story', status: 'ready' })],
        [4, makeIssue(4, { type: 'task', status: 'fixed', state: 'closed' })],
      ]),
      {
      listSubIssues: vi.fn((num: number) =>
        match(num)
          .with(1, () => TE.right([2]))
          .with(2, () => TE.right([4]))
          .otherwise(() => TE.right([])),
      ),
      updateIssueStatus: vi.fn((num: number, status: string) => {
        recordedStatus = [...recordedStatus, [num, status]];
        return TE.right(undefined);
      }),
      closeIssue: vi.fn((num: number) => {
        closedIssues = [...closedIssues, num];
        return TE.right(undefined);
      }),
      reopenIssue: vi.fn(() => TE.right(undefined)),
    } as Partial<GitHubPort> as GitHubPort);

    expect(E.isRight(res)).toBe(true);
    match(res)
      .with({ _tag: 'Right' }, ({ right }) => {
        expect(right.rolledUp).toBe(2);
        expect(right.containerNumbers.has(1)).toBe(true);
        expect(right.containerNumbers.has(2)).toBe(true);
        expect(right.containerNumbers.has(3)).toBe(false);
        expect(right.byNumber.get(2)?.status).toBe('fixed');
        expect(right.byNumber.get(1)?.status).toBe('fixed');
      })
      .with({ _tag: 'Left' }, () => {
        expect.unreachable('Expected Right');
      })
      .exhaustive();

    expect(recordedStatus).toEqual([
      [2, 'fixed'],
      [1, 'fixed'],
    ]);
    expect(closedIssues).toEqual([2, 1]);
  });
});
