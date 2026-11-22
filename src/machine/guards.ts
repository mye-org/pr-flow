import * as E from 'fp-ts/lib/Either';
import { flow } from 'fp-ts/lib/function';
import type { GuardError } from '../domain/errors.js';
import type { BlockerState } from '../domain/events.js';
import { isExecutableLeaf, type IssueNode } from '../domain/issue.js';
import { type Count, isoCount, type IssueNumber } from '../domain/newtypes.js';

export type PickupGuardContext = {
  readonly issue: IssueNode;
  readonly wipCount: Count;
  readonly wipLimit: Count;
  readonly openPrCount: Count;
  readonly blockerState: BlockerState;
  readonly blockingIssues: ReadonlyArray<IssueNumber>;
};

const subIssueCountOf = (issue: IssueNode) => isoCount.wrap(issue.subIssueNumbers.length);

const checkLeaf = (ctx: PickupGuardContext) =>
  E.fromPredicate<PickupGuardContext, GuardError>(
    (c) => isExecutableLeaf(c.issue),
    (c) => ({
      type: 'NOT_AN_EXECUTABLE_LEAF',
      issueNumber: c.issue.number,
      issueType: c.issue.type,
      subIssueCount: subIssueCountOf(c.issue),
    }),
  )(ctx);

const checkReadyState = (ctx: PickupGuardContext) =>
  E.fromPredicate<PickupGuardContext, GuardError>(
    (c) => c.issue.status === 'ready',
    (c) => ({
      type: 'INVALID_STATE_FOR_PICKUP',
      issueNumber: c.issue.number,
      currentStatus: c.issue.status,
    }),
  )(ctx);

const checkBlockers = (ctx: PickupGuardContext) =>
  E.fromPredicate<PickupGuardContext, GuardError>(
    (c) => c.blockerState === 'all_closed',
    (c) => ({
      type: 'BLOCKED_BY_DEPENDENCIES',
      blockingIssues: c.blockingIssues,
    }),
  )(ctx);

const checkNoOpenPr = (ctx: PickupGuardContext) =>
  E.fromPredicate<PickupGuardContext, GuardError>(
    (c) => isoCount.unwrap(c.openPrCount) === 0,
    (c) => ({
      type: 'PR_ALREADY_EXISTS',
      issueNumber: c.issue.number,
      existingPrCount: c.openPrCount,
    }),
  )(ctx);

const checkWipLimit = (ctx: PickupGuardContext) =>
  E.fromPredicate<PickupGuardContext, GuardError>(
    (c) => isoCount.unwrap(c.wipCount) < isoCount.unwrap(c.wipLimit),
    (c) => ({
      type: 'WIP_LIMIT_REACHED',
      currentWip: c.wipCount,
      limit: c.wipLimit,
    }),
  )(ctx);

export const checkPickupEligibility = flow(
  checkLeaf,
  E.flatMap(checkReadyState),
  E.flatMap(checkBlockers),
  E.flatMap(checkNoOpenPr),
  E.flatMap(checkWipLimit),
  E.map(() => 'eligible' as const),
);
