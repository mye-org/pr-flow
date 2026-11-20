import * as E from 'fp-ts/Either';
import type { GuardError } from '../domain/errors.js';
import { isExecutableLeaf, type IssueNode } from '../domain/issue.js';

export interface PickupGuardContext {
  issue: IssueNode;
  wipCount: number;
  wipLimit: number;
  openPrCount: number;
  allBlockersClosed: boolean;
  blockingIssues: number[];
}

export function checkPickupEligibility(ctx: PickupGuardContext): E.Either<GuardError, true> {
  if (!isExecutableLeaf(ctx.issue)) {
    return E.left({
      type: 'NOT_AN_EXECUTABLE_LEAF',
      issueNumber: ctx.issue.number,
      issueType: ctx.issue.type,
      subIssueCount: ctx.issue.subIssueNumbers.length,
    });
  }

  if (ctx.issue.status !== 'ready') {
    return E.left({
      type: 'INVALID_STATE_FOR_PICKUP',
      issueNumber: ctx.issue.number,
      currentStatus: ctx.issue.status,
    });
  }

  if (!ctx.allBlockersClosed) {
    return E.left({
      type: 'BLOCKED_BY_DEPENDENCIES',
      blockingIssues: ctx.blockingIssues,
    });
  }

  if (ctx.openPrCount > 0) {
    return E.left({
      type: 'PR_ALREADY_EXISTS',
      issueNumber: ctx.issue.number,
      existingPrCount: ctx.openPrCount,
    });
  }

  if (ctx.wipCount >= ctx.wipLimit) {
    return E.left({
      type: 'WIP_LIMIT_REACHED',
      currentWip: ctx.wipCount,
      limit: ctx.wipLimit,
    });
  }

  return E.right(true);
}
