import { describe, expect, it } from 'vitest';
import { computeContainerStatus, computeRollupEffects } from '../src/rollup/computeRollup.js';

describe('computeContainerStatus', () => {
  it('prioritizes needs_human over all other statuses', () => {
    expect(
      computeContainerStatus([
        { status: 'fixed' },
        { status: 'in_progress' },
        { status: 'needs_human' },
      ]),
    ).toBe('needs_human');
  });

  it('returns fixed only when all children are fixed', () => {
    expect(computeContainerStatus([{ status: 'fixed' }, { status: 'fixed' }])).toBe('fixed');
  });

  it('returns in_progress when any child is in_progress, review_pending, or partially fixed', () => {
    expect(computeContainerStatus([{ status: 'fixed' }, { status: 'ready' }])).toBe('in_progress');
    expect(computeContainerStatus([{ status: 'review_pending' }, { status: 'backlog' }])).toBe('in_progress');
  });

  it('returns ready when no progress yet and at least one child is ready', () => {
    expect(computeContainerStatus([{ status: 'ready' }, { status: 'blocked_dep' }])).toBe('ready');
  });

  it('returns blocked_dep when all remaining children are blocked or backlog', () => {
    expect(computeContainerStatus([{ status: 'blocked_dep' }, { status: 'backlog' }])).toBe('blocked_dep');
  });
});

describe('computeRollupEffects', () => {
  it('closes an open container when all children become fixed', () => {
    const { targetStatus, effects } = computeRollupEffects(
      { number: 1, status: 'in_progress', state: 'open' },
      [{ status: 'fixed' }, { status: 'fixed' }],
    );
    expect(targetStatus).toBe('fixed');
    expect(effects).toEqual([
      { type: 'SET_STATUS_FIELD', issueNumber: 1, from: 'in_progress', to: 'fixed' },
      { type: 'CLOSE_ISSUE', issueNumber: 1 },
    ]);
  });

  it('reopens a closed container if a child transitions to needs_human', () => {
    const { targetStatus, effects } = computeRollupEffects(
      { number: 1, status: 'fixed', state: 'closed' },
      [{ status: 'fixed' }, { status: 'needs_human' }],
    );
    expect(targetStatus).toBe('needs_human');
    expect(effects).toEqual([
      { type: 'SET_STATUS_FIELD', issueNumber: 1, from: 'fixed', to: 'needs_human' },
      { type: 'REOPEN_ISSUE', issueNumber: 1 },
    ]);
  });
});
