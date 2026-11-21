import { pipe } from 'fp-ts/lib/function';
import type * as O from 'fp-ts/lib/Option';
import * as RA from 'fp-ts/lib/ReadonlyArray';
import { match } from 'ts-pattern';
import type { IssueStatus, IssueType } from './issue.js';
import {
  type Count,
  isoCount,
  isoIssueNumber,
  isoMessage,
  type IssueNumber,
  type Message,
} from './newtypes.js';

export type Retryability = 'retryable' | 'fatal';

export type GuardError =
  | { readonly type: 'WIP_LIMIT_REACHED'; readonly currentWip: Count; readonly limit: Count }
  | { readonly type: 'BLOCKED_BY_DEPENDENCIES'; readonly blockingIssues: ReadonlyArray<IssueNumber> }
  | {
      readonly type: 'NOT_AN_EXECUTABLE_LEAF';
      readonly issueNumber: IssueNumber;
      readonly issueType: IssueType;
      readonly subIssueCount: Count;
    }
  | {
      readonly type: 'PR_ALREADY_EXISTS';
      readonly issueNumber: IssueNumber;
      readonly existingPrCount: Count;
    }
  | {
      readonly type: 'INVALID_STATE_FOR_PICKUP';
      readonly issueNumber: IssueNumber;
      readonly currentStatus: IssueStatus;
    };

export type DomainError =
  | { readonly type: 'CONFIG_ERROR'; readonly message: Message }
  | {
      readonly type: 'PLAN_VALIDATION_ERROR';
      readonly message: Message;
      readonly details: O.Option<ReadonlyArray<Message>>;
    }
  | {
      readonly type: 'GITHUB_API_ERROR';
      readonly message: Message;
      readonly status: O.Option<Count>;
      readonly cause: O.Option<Message>;
    }
  | {
      readonly type: 'AGENT_EXECUTION_ERROR';
      readonly message: Message;
      readonly exitCode: O.Option<Count>;
      readonly retryability: O.Option<Retryability>;
    }
  | { readonly type: 'GUARD_ERROR'; readonly guard: GuardError }
  | { readonly type: 'GIT_ERROR'; readonly message: Message };

const formatWipLimit = (e: Extract<GuardError, { readonly type: 'WIP_LIMIT_REACHED' }>): string =>
  `WIP limit reached (${String(isoCount.unwrap(e.currentWip))}/${String(isoCount.unwrap(e.limit))} issues currently in progress).`;

const formatBlockedDeps = (
  e: Extract<GuardError, { readonly type: 'BLOCKED_BY_DEPENDENCIES' }>,
): string =>
  `Issue is blocked by open dependencies: ${pipe(
    e.blockingIssues,
    RA.map((n) => `#${String(isoIssueNumber.unwrap(n))}`),
  ).join(', ')}.`;

const formatNotLeaf = (
  e: Extract<GuardError, { readonly type: 'NOT_AN_EXECUTABLE_LEAF' }>,
): string =>
  `Issue #${String(isoIssueNumber.unwrap(e.issueNumber))} (type=${e.issueType}, subIssues=${String(isoCount.unwrap(e.subIssueCount))}) is a container, not an executable leaf.`;

const formatPrExists = (e: Extract<GuardError, { readonly type: 'PR_ALREADY_EXISTS' }>): string =>
  `Issue #${String(isoIssueNumber.unwrap(e.issueNumber))} already has ${String(isoCount.unwrap(e.existingPrCount))} open PR(s) (1-PR-per-issue rule).`;

const formatInvalidState = (
  e: Extract<GuardError, { readonly type: 'INVALID_STATE_FOR_PICKUP' }>,
): string =>
  `Issue #${String(isoIssueNumber.unwrap(e.issueNumber))} is in state '${e.currentStatus}', which cannot be picked up automatically.`;

export function formatGuardError(err: GuardError): Message {
  return isoMessage.wrap(
    match(err)
      .with({ type: 'WIP_LIMIT_REACHED' }, formatWipLimit)
      .with({ type: 'BLOCKED_BY_DEPENDENCIES' }, formatBlockedDeps)
      .with({ type: 'NOT_AN_EXECUTABLE_LEAF' }, formatNotLeaf)
      .with({ type: 'PR_ALREADY_EXISTS' }, formatPrExists)
      .with({ type: 'INVALID_STATE_FOR_PICKUP' }, formatInvalidState)
      .exhaustive(),
  );
}
