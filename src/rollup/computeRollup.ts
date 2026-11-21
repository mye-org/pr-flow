import { pipe } from 'fp-ts/lib/function';
import * as O from 'fp-ts/lib/Option';
import * as RA from 'fp-ts/lib/ReadonlyArray';
import { match } from 'ts-pattern';
import type { Effect } from '../domain/effects.js';
import type { IssueNode, IssueStatus } from '../domain/issue.js';

const computeNonEmptyStatus = (statuses: ReadonlyArray<IssueStatus>) =>
  match(statuses)
    .when(RA.some((s) => s === 'needs_human'), () => 'needs_human' as const)
    .when(RA.every((s) => s === 'fixed'), () => 'fixed' as const)
    .when(
      RA.some((s) => s === 'in_progress' || s === 'review_pending' || s === 'fixed'),
      () => 'in_progress' as const,
    )
    .when(RA.some((s) => s === 'ready'), () => 'ready' as const)
    .when(RA.some((s) => s === 'blocked_dep'), () => 'blocked_dep' as const)
    .otherwise(() => 'backlog' as const);

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
export function computeContainerStatus(children: ReadonlyArray<Pick<IssueNode, 'status'>>) {
  return match(children.length === 0)
    .with(true, () => 'backlog' as const)
    .with(false, () =>
      pipe(
        children,
        RA.map((c) => c.status),
        computeNonEmptyStatus,
      ),
    )
    .exhaustive();
}

const buildStatusEffects = (
  parent: Pick<IssueNode, 'number' | 'status'>,
  targetStatus: IssueStatus,
) =>
  match(targetStatus !== parent.status)
    .with(true, () =>
      [
        {
          type: 'SET_STATUS_FIELD',
          issueNumber: parent.number,
          from: O.some(parent.status),
          to: targetStatus,
        },
      ] satisfies ReadonlyArray<Effect>,
    )
    .with(false, () => [] satisfies ReadonlyArray<Effect>)
    .exhaustive();

const buildLifecycleEffects = (
  parent: Pick<IssueNode, 'number' | 'state'>,
  targetStatus: IssueStatus,
) =>
  match([targetStatus, parent.state] as const)
    .with(['fixed', 'open'], () =>
      [{ type: 'CLOSE_ISSUE', issueNumber: parent.number }] satisfies ReadonlyArray<Effect>,
    )
    .with(
      ['backlog', 'closed'],
      ['blocked_dep', 'closed'],
      ['ready', 'closed'],
      ['in_progress', 'closed'],
      ['review_pending', 'closed'],
      ['needs_human', 'closed'],
      () => [{ type: 'REOPEN_ISSUE', issueNumber: parent.number }] satisfies ReadonlyArray<Effect>,
    )
    .otherwise(() => [] satisfies ReadonlyArray<Effect>);

export function computeRollupEffects(
  parent: Pick<IssueNode, 'number' | 'status' | 'state'>,
  children: ReadonlyArray<Pick<IssueNode, 'status'>>,
) {
  return pipe(computeContainerStatus(children), (targetStatus) => ({
    targetStatus,
    effects: [
      ...buildStatusEffects(parent, targetStatus),
      ...buildLifecycleEffects(parent, targetStatus),
    ] satisfies ReadonlyArray<Effect>,
  }));
}
