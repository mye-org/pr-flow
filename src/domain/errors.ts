import { flow } from 'fp-ts/lib/function';
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

export type HttpStatusCode =
  | { readonly kind: 'known'; readonly code: Count }
  | { readonly kind: 'unknown' };

export type ErrorCause =
  | { readonly kind: 'present'; readonly detail: Message }
  | { readonly kind: 'none' };

export type ProcessExitCode =
  | { readonly kind: 'code'; readonly value: Count }
  | { readonly kind: 'unknown' };

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
      readonly details: ReadonlyArray<Message>;
    }
  | {
      readonly type: 'GITHUB_API_ERROR';
      readonly message: Message;
      readonly httpStatus: HttpStatusCode;
      readonly cause: ErrorCause;
    }
  | {
      readonly type: 'AGENT_EXECUTION_ERROR';
      readonly message: Message;
      readonly exitCode: ProcessExitCode;
      readonly retryability: Retryability;
    }
  | { readonly type: 'GUARD_ERROR'; readonly guard: GuardError }
  | { readonly type: 'GIT_ERROR'; readonly message: Message };

const formatWipLimitText = (currentWip: number, limit: number) =>
  `WIP limit reached (${String(currentWip)}/${String(limit)} issues currently in progress).`;

function formatWipLimit(e: Extract<GuardError, { readonly type: 'WIP_LIMIT_REACHED' }>) {
  return formatWipLimitText(isoCount.unwrap(e.currentWip), isoCount.unwrap(e.limit));
}

const formatIssueRef = (issueNumber: number) => `#${String(issueNumber)}`;

const joinIssueRefs = (refs: ReadonlyArray<string>) => refs.join(', ');

const wrapBlockedDepsSentence = (list: string) =>
  `Issue is blocked by open dependencies: ${list}.`;

const formatBlockedDepsText = flow(
  RA.map(formatIssueRef),
  joinIssueRefs,
  wrapBlockedDepsSentence,
);

const formatBlockedDeps = flow(
  (e: Extract<GuardError, { readonly type: 'BLOCKED_BY_DEPENDENCIES' }>) => e.blockingIssues,
  RA.map(isoIssueNumber.unwrap),
  formatBlockedDepsText,
);

const formatNotLeafText = (issueNumber: number, issueType: IssueType, subIssueCount: number) =>
  `Issue #${String(issueNumber)} (type=${issueType}, subIssues=${String(subIssueCount)}) is a container, not an executable leaf.`;

function formatNotLeaf(
  e: Extract<GuardError, { readonly type: 'NOT_AN_EXECUTABLE_LEAF' }>,
) {
  return formatNotLeafText(
    isoIssueNumber.unwrap(e.issueNumber),
    e.issueType,
    isoCount.unwrap(e.subIssueCount),
  );
}

const formatPrExistsText = (issueNumber: number, existingPrCount: number) =>
  `Issue #${String(issueNumber)} already has ${String(existingPrCount)} open PR(s) (1-PR-per-issue rule).`;

function formatPrExists(e: Extract<GuardError, { readonly type: 'PR_ALREADY_EXISTS' }>) {
  return formatPrExistsText(isoIssueNumber.unwrap(e.issueNumber), isoCount.unwrap(e.existingPrCount));
}

const formatInvalidStateText = (issueNumber: number, currentStatus: IssueStatus) =>
  `Issue #${String(issueNumber)} is in state '${currentStatus}', which cannot be picked up automatically.`;

function formatInvalidState(
  e: Extract<GuardError, { readonly type: 'INVALID_STATE_FOR_PICKUP' }>,
) {
  return formatInvalidStateText(isoIssueNumber.unwrap(e.issueNumber), e.currentStatus);
}

export function formatGuardError(err: GuardError) {
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
