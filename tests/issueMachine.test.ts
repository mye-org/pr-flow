import * as E from 'fp-ts/Either';
import { describe, expect, it } from 'vitest';
import { isExecutableLeaf, type IssueNode } from '../src/domain/issue.js';
import { checkPickupEligibility } from '../src/machine/guards.js';
import { transitionIssue } from '../src/machine/issueMachine.js';

function makeIssue(overrides: Partial<IssueNode> = {}): IssueNode {
  return {
    number: 42,
    title: 'Implement auth middleware',
    body: 'Add JWT verification',
    state: 'open',
    status: 'ready',
    type: 'task',
    priority: 'p1',
    labels: ['type:task', 'status:ready', 'priority:p1'],
    subIssueNumbers: [],
    blockedByNumbers: [],
    blockingNumbers: [],
    linkedPrNumber: null,
    parentNumber: null,
    updatedAt: '2026-11-20T00:00:00Z',
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
    expect(isExecutableLeaf({ type: 'story', subIssueNumbers: [101] })).toBe(false);
  });

  it('never treats epic as an executable leaf', () => {
    expect(isExecutableLeaf({ type: 'epic', subIssueNumbers: [] })).toBe(false);
  });
});

describe('checkPickupEligibility', () => {
  it('allows pickup when all guards pass', () => {
    const res = checkPickupEligibility({
      issue: makeIssue(),
      wipCount: 3,
      wipLimit: 4,
      openPrCount: 0,
      allBlockersClosed: true,
      blockingIssues: [],
    });
    expect(E.isRight(res)).toBe(true);
  });

  it('blocks pickup when WIP limit is reached', () => {
    const res = checkPickupEligibility({
      issue: makeIssue(),
      wipCount: 4,
      wipLimit: 4,
      openPrCount: 0,
      allBlockersClosed: true,
      blockingIssues: [],
    });
    expect(res).toEqual(E.left({ type: 'WIP_LIMIT_REACHED', currentWip: 4, limit: 4 }));
  });

  it('blocks pickup when open PR already exists (1-PR-per-issue)', () => {
    const res = checkPickupEligibility({
      issue: makeIssue(),
      wipCount: 1,
      wipLimit: 4,
      openPrCount: 1,
      allBlockersClosed: true,
      blockingIssues: [],
    });
    expect(res).toEqual(E.left({ type: 'PR_ALREADY_EXISTS', issueNumber: 42, existingPrCount: 1 }));
  });

  it('blocks pickup for container issues', () => {
    const res = checkPickupEligibility({
      issue: makeIssue({ type: 'epic' }),
      wipCount: 0,
      wipLimit: 4,
      openPrCount: 0,
      allBlockersClosed: true,
      blockingIssues: [],
    });
    expect(E.isLeft(res)).toBe(true);
    if (E.isLeft(res)) {
      expect(res.left.type).toBe('NOT_AN_EXECUTABLE_LEAF');
    }
  });

  it('blocks pickup when upstream dependencies are open', () => {
    const res = checkPickupEligibility({
      issue: makeIssue(),
      wipCount: 0,
      wipLimit: 4,
      openPrCount: 0,
      allBlockersClosed: false,
      blockingIssues: [10, 11],
    });
    expect(res).toEqual(E.left({ type: 'BLOCKED_BY_DEPENDENCIES', blockingIssues: [10, 11] }));
  });
});

describe('issueMachine transitions', () => {
  it('transitions ready -> in_progress -> review_pending -> fixed', () => {
    const readyIssue = makeIssue({ status: 'ready' });
    const claimed = transitionIssue(readyIssue, {
      type: 'PICKUP_REQUESTED',
      wipCount: 1,
      wipLimit: 4,
      openPrCount: 0,
      isLeaf: true,
      allBlockersClosed: true,
    });
    expect(claimed.changed).toBe(true);
    expect(claimed.nextStatus).toBe('in_progress');
    expect(claimed.effects).toEqual([
      { type: 'SWAP_STATUS_LABEL', issueNumber: 42, from: 'ready', to: 'in_progress' },
    ]);

    const prOpened = transitionIssue(
      makeIssue({ status: 'in_progress' }),
      {
        type: 'EXECUTION_SUCCEEDED',
        prNumber: 99,
        branch: 'ai/issue-42',
        summary: 'Implemented JWT middleware',
      },
    );
    expect(prOpened.nextStatus).toBe('review_pending');
    expect(prOpened.effects[0]).toEqual({
      type: 'SWAP_STATUS_LABEL',
      issueNumber: 42,
      from: 'in_progress',
      to: 'review_pending',
    });

    const merged = transitionIssue(
      makeIssue({ status: 'review_pending' }),
      { type: 'PR_MERGED', prNumber: 99 },
    );
    expect(merged.nextStatus).toBe('fixed');
    expect(merged.effects).toEqual([
      { type: 'SWAP_STATUS_LABEL', issueNumber: 42, from: 'review_pending', to: 'fixed' },
      { type: 'CLOSE_ISSUE', issueNumber: 42 },
    ]);
  });

  it('transitions in_progress -> needs_human on NEEDS_HUMAN_DETECTED', () => {
    const res = transitionIssue(makeIssue({ status: 'in_progress' }), {
      type: 'NEEDS_HUMAN_DETECTED',
      reason: 'Missing API specification',
    });
    expect(res.nextStatus).toBe('needs_human');
    expect(res.effects.some((e) => e.type === 'ADD_COMMENT')).toBe(true);
  });

  it('transitions blocked_dep -> ready on DEPS_RESOLVED', () => {
    const res = transitionIssue(makeIssue({ status: 'blocked_dep' }), {
      type: 'DEPS_RESOLVED',
    });
    expect(res.nextStatus).toBe('ready');
  });
});
