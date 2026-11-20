import { match } from 'ts-pattern';
import type { Effect } from '../domain/effects.js';
import type { IssueNode, IssueStatus } from '../domain/issue.js';

/**
 * Pure rollup status computation for container issues (Epics and non-leaf Stories).
 * Priority order:
 *   1. Any child `needs_human` -> `needs_human`
 *   2. All children `fixed` -> `fixed`
 *   3. Any child `in_progress` or `review_pending` or `fixed` (partial progress) -> `in_progress`
 *   4. Any child `ready` -> `ready`
 *   5. Any child `blocked_dep` -> `blocked_dep`
 *   6. Otherwise -> `backlog`
 */
export function computeContainerStatus(children: readonly Pick<IssueNode, 'status'>[]): IssueStatus {
  if (children.length === 0) {
    return 'backlog';
  }

  const statuses = children.map((c) => c.status);

  if (statuses.some((s) => s === 'needs_human')) {
    return 'needs_human';
  }

  if (statuses.every((s) => s === 'fixed')) {
    return 'fixed';
  }

  if (statuses.some((s) => s === 'in_progress' || s === 'review_pending' || s === 'fixed')) {
    return 'in_progress';
  }

  if (statuses.some((s) => s === 'ready')) {
    return 'ready';
  }

  if (statuses.some((s) => s === 'blocked_dep')) {
    return 'blocked_dep';
  }

  return 'backlog';
}

export function computeRollupEffects(
  parent: Pick<IssueNode, 'number' | 'status' | 'state'>,
  children: readonly Pick<IssueNode, 'status'>[],
): { targetStatus: IssueStatus; effects: Effect[] } {
  const targetStatus = computeContainerStatus(children);
  const effects: Effect[] = [];

  if (targetStatus !== parent.status) {
    effects.push({
      type: 'SWAP_STATUS_LABEL',
      issueNumber: parent.number,
      from: parent.status,
      to: targetStatus,
    });
  }

  match(targetStatus)
    .with('fixed', () => {
      if (parent.state === 'open') {
        effects.push({ type: 'CLOSE_ISSUE', issueNumber: parent.number });
      }
    })
    .with('backlog', 'blocked_dep', 'ready', 'in_progress', 'review_pending', 'needs_human', () => {
      if (parent.state === 'closed') {
        effects.push({ type: 'REOPEN_ISSUE', issueNumber: parent.number });
      }
    })
    .exhaustive();

  return { targetStatus, effects };
}
