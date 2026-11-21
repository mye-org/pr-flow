import * as E from 'fp-ts/lib/Either';
import { pipe } from 'fp-ts/lib/function';
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

const checkLeaf = (ctx: PickupGuardContext): E.Either<GuardError, PickupGuardContext> =>
  E.fromPredicate(
    (c: PickupGuardContext) => isExecutableLeaf(c.issue),
    (c): GuardError => ({
      type: 'NOT_AN_EXECUTABLE_LEAF',
      issueNumber: c.issue.number,
      issueType: c.issue.type,
      subIssueCount: isoCount.wrap(c.issue.subIssueNumbers.length),
    }),
  )(ctx);

const checkReadyState = (ctx: PickupGuardContext): E.Either<GuardError, PickupGuardContext> =>
  E.fromPredicate(
    (c: PickupGuardContext) => c.issue.status === 'ready',
    (c): GuardError => ({
      type: 'INVALID_STATE_FOR_PICKUP',
      issueNumber: c.issue.number,
      currentStatus: c.issue.status,
    }),
  )(ctx);

const checkBlockers = (ctx: PickupGuardContext): E.Either<GuardError, PickupGuardContext> =>
  E.fromPredicate(
    (c: PickupGuardContext) => c.blockerState === 'all_closed',
    (c): GuardError => ({
      type: 'BLOCKED_BY_DEPENDENCIES',
      blockingIssues: c.blockingIssues,
    }),
  )(ctx);

const checkNoOpenPr = (ctx: PickupGuardContext): E.Either<GuardError, PickupGuardContext> =>
  E.fromPredicate(
    (c: PickupGuardContext) => isoCount.unwrap(c.openPrCount) === 0,
    (c): GuardError => ({
      type: 'PR_ALREADY_EXISTS',
      issueNumber: c.issue.number,
      existingPrCount: c.openPrCount,
    }),
  )(ctx);

const checkWipLimit = (ctx: PickupGuardContext): E.Either<GuardError, PickupGuardContext> =>
  E.fromPredicate(
    (c: PickupGuardContext) => isoCount.unwrap(c.wipCount) < isoCount.unwrap(c.wipLimit),
    (c): GuardError => ({
      type: 'WIP_LIMIT_REACHED',
      currentWip: c.wipCount,
      limit: c.wipLimit,
    }),
  )(ctx);

export function checkPickupEligibility(ctx: PickupGuardContext): E.Either<GuardError, true> {
  return pipe(
    checkLeaf(ctx),
    E.chain(checkReadyState),
    E.chain(checkBlockers),
    E.chain(checkNoOpenPr),
    E.chain(checkWipLimit),
    E.map(() => true as const),
  );
}
