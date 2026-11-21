import * as E from 'fp-ts/lib/Either';
import { pipe } from 'fp-ts/lib/function';
import * as O from 'fp-ts/lib/Option';
import * as RA from 'fp-ts/lib/ReadonlyArray';
import { describe, expect, it } from 'vitest';
import { isExecutableLeaf, type IssueNode } from '../src/domain/issue.js';
import {
  isoBody,
  isoBranchName,
  isoCount,
  isoIsoTimestamp,
  isoIssueNumber,
  isoLabelName,
  isoMessage,
  isoPrNumber,
  isoTitle,
} from '../src/domain/newtypes.js';
import { checkPickupEligibility } from '../src/machine/guards.js';
import { transitionIssue } from '../src/machine/issueMachine.js';

function makeIssue(overrides: Partial<IssueNode> = {}): IssueNode {
  return {
    number: isoIssueNumber.wrap(42),
    title: isoTitle.wrap('Implement auth middleware'),
    body: isoBody.wrap('Add JWT verification'),
    state: 'open',
    status: 'ready',
    type: 'task',
    labels: [isoLabelName.wrap('type:task'), isoLabelName.wrap('ai-managed')],
    subIssueNumbers: [],
    blockedByNumbers: [],
    blockingNumbers: [],
    linkedPrNumber: O.none,
    parentNumber: O.none,
    updatedAt: isoIsoTimestamp.wrap('2026-11-20T00:00:00Z'),
    ...overrides,
  };
}

describe('isExecutableLeaf', () => {
  it('treats task and bug as executable leaves', () => {
    expect(isExecutableLeaf({ type: 'task', subIssueNumbers: [] })).toBe(true);
    expect(isExecutableLeaf({ type: 'bug', subIssueNumbers: [] })).toBe(true);
  });

  it('treats story with 0 sub-issues as leaf, and story with sub-issues as container', () => {
    expect(isExecutableLeaf({ type: 'story', subIssueNumbers: [] })).toBe(true);
    expect(isExecutableLeaf({ type: 'story', subIssueNumbers: [isoIssueNumber.wrap(101)] })).toBe(false);
  });

  it('never treats epic as an executable leaf', () => {
    expect(isExecutableLeaf({ type: 'epic', subIssueNumbers: [] })).toBe(false);
  });
});

describe('checkPickupEligibility', () => {
  it('allows pickup when all guards pass', () => {
    expect(
      E.isRight(
        checkPickupEligibility({
          issue: makeIssue(),
          wipCount: isoCount.wrap(3),
          wipLimit: isoCount.wrap(4),
          openPrCount: isoCount.wrap(0),
          blockerState: 'all_closed',
          blockingIssues: [],
        }),
      ),
    ).toBe(true);
  });

  it('blocks pickup when WIP limit is reached', () => {
    expect(
      checkPickupEligibility({
        issue: makeIssue(),
        wipCount: isoCount.wrap(4),
        wipLimit: isoCount.wrap(4),
        openPrCount: isoCount.wrap(0),
        blockerState: 'all_closed',
        blockingIssues: [],
      }),
    ).toEqual(
      E.left({ type: 'WIP_LIMIT_REACHED', currentWip: isoCount.wrap(4), limit: isoCount.wrap(4) }),
    );
  });

  it('blocks pickup when open PR already exists (1-PR-per-issue)', () => {
    expect(
      checkPickupEligibility({
        issue: makeIssue(),
        wipCount: isoCount.wrap(1),
        wipLimit: isoCount.wrap(4),
        openPrCount: isoCount.wrap(1),
        blockerState: 'all_closed',
        blockingIssues: [],
      }),
    ).toEqual(
      E.left({
        type: 'PR_ALREADY_EXISTS',
        issueNumber: isoIssueNumber.wrap(42),
        existingPrCount: isoCount.wrap(1),
      }),
    );
  });

  it('blocks pickup for container issues', () => {
    const res = checkPickupEligibility({
      issue: makeIssue({ type: 'epic' }),
      wipCount: isoCount.wrap(0),
      wipLimit: isoCount.wrap(4),
      openPrCount: isoCount.wrap(0),
      blockerState: 'all_closed',
      blockingIssues: [],
    });
    expect(E.isLeft(res)).toBe(true);
    if (E.isLeft(res)) {
      expect(res.left.type).toBe('NOT_AN_EXECUTABLE_LEAF');
    }
  });

  it('blocks pickup when upstream dependencies are open', () => {
    expect(
      checkPickupEligibility({
        issue: makeIssue(),
        wipCount: isoCount.wrap(0),
        wipLimit: isoCount.wrap(4),
        openPrCount: isoCount.wrap(0),
        blockerState: 'has_open',
        blockingIssues: [isoIssueNumber.wrap(10), isoIssueNumber.wrap(11)],
      }),
    ).toEqual(
      E.left({
        type: 'BLOCKED_BY_DEPENDENCIES',
        blockingIssues: [isoIssueNumber.wrap(10), isoIssueNumber.wrap(11)],
      }),
    );
  });
});

describe('issueMachine transitions', () => {
  it('transitions ready -> in_progress -> review_pending -> fixed', () => {
    const claimed = transitionIssue(makeIssue({ status: 'ready' }), {
      type: 'PICKUP_REQUESTED',
      wipCount: isoCount.wrap(1),
      wipLimit: isoCount.wrap(4),
      openPrCount: isoCount.wrap(0),
      leafKind: 'leaf',
      blockerState: 'all_closed',
    });
    expect(claimed.changeKind).toBe('changed');
    expect(claimed.nextStatus).toBe('in_progress');
    expect(claimed.effects).toEqual([
      {
        type: 'SET_STATUS_FIELD',
        issueNumber: isoIssueNumber.wrap(42),
        from: O.some('ready'),
        to: 'in_progress',
      },
    ]);

    const prOpened = transitionIssue(makeIssue({ status: 'in_progress' }), {
      type: 'EXECUTION_SUCCEEDED',
      prNumber: isoPrNumber.wrap(99),
      branch: isoBranchName.wrap('ai/issue-42'),
      summary: isoMessage.wrap('Implemented JWT middleware'),
    });
    expect(prOpened.nextStatus).toBe('review_pending');
    expect(prOpened.effects[0]).toEqual({
      type: 'SET_STATUS_FIELD',
      issueNumber: isoIssueNumber.wrap(42),
      from: O.some('in_progress'),
      to: 'review_pending',
    });

    const merged = transitionIssue(makeIssue({ status: 'review_pending' }), {
      type: 'PR_MERGED',
      prNumber: isoPrNumber.wrap(99),
    });
    expect(merged.nextStatus).toBe('fixed');
    expect(merged.effects).toEqual([
      {
        type: 'SET_STATUS_FIELD',
        issueNumber: isoIssueNumber.wrap(42),
        from: O.some('review_pending'),
        to: 'fixed',
      },
      { type: 'CLOSE_ISSUE', issueNumber: isoIssueNumber.wrap(42) },
    ]);
  });

  it('transitions in_progress -> needs_human on NEEDS_HUMAN_DETECTED', () => {
    const res = transitionIssue(makeIssue({ status: 'in_progress' }), {
      type: 'NEEDS_HUMAN_DETECTED',
      reason: isoMessage.wrap('Missing API specification'),
    });
    expect(res.nextStatus).toBe('needs_human');
    expect(
      pipe(
        res.effects,
        RA.some((e) => e.type === 'ADD_COMMENT'),
      ),
    ).toBe(true);
  });

  it('transitions blocked_dep -> ready on DEPS_RESOLVED', () => {
    expect(
      transitionIssue(makeIssue({ status: 'blocked_dep' }), {
        type: 'DEPS_RESOLVED',
      }).nextStatus,
    ).toBe('ready');
  });

  it('re-queues in_progress -> ready on TRANSIENT_EXECUTION_FAILED when under maxRetries', () => {
    const res = transitionIssue(makeIssue({ status: 'in_progress' }), {
      type: 'TRANSIENT_EXECUTION_FAILED',
      reason: isoMessage.wrap('503 Service Unavailable'),
      retryCount: isoCount.wrap(1),
      maxRetries: isoCount.wrap(3),
    });
    expect(res.nextStatus).toBe('ready');
    expect(res.effects[0]).toEqual({
      type: 'SET_STATUS_FIELD',
      issueNumber: isoIssueNumber.wrap(42),
      from: O.some('in_progress'),
      to: 'ready',
    });
    const commentEffect = res.effects[1];
    expect(commentEffect?.type).toBe('ADD_COMMENT');
    if (commentEffect?.type === 'ADD_COMMENT') {
      expect(isoBody.unwrap(commentEffect.body)).toContain('<!-- pr-flow:retries=2 -->');
    }
  });

  it('escalates in_progress -> needs_human on TRANSIENT_EXECUTION_FAILED when retries exhausted', () => {
    const res = transitionIssue(makeIssue({ status: 'in_progress' }), {
      type: 'TRANSIENT_EXECUTION_FAILED',
      reason: isoMessage.wrap('503 Service Unavailable'),
      retryCount: isoCount.wrap(3),
      maxRetries: isoCount.wrap(3),
    });
    expect(res.nextStatus).toBe('needs_human');
    expect(res.effects[0]).toEqual({
      type: 'SET_STATUS_FIELD',
      issueNumber: isoIssueNumber.wrap(42),
      from: O.some('in_progress'),
      to: 'needs_human',
    });
  });
});
