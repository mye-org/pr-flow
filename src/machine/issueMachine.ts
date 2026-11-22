import { flow } from 'fp-ts/lib/function';
import { assign, setup, transition } from 'xstate';
import type { Effect } from '../domain/effects.js';
import type { IssueEvent } from '../domain/events.js';
import type { IssueNode, IssueStatus } from '../domain/issue.js';
import {
  type Body,
  isoBody,
  isoBranchName,
  isoCount,
  isoMessage,
  isoPrNumber,
  type IssueNumber,
  type Message,
} from '../domain/newtypes.js';

export type IssueMachineContext = {
  readonly issueNumber: IssueNumber;
  readonly effects: ReadonlyArray<Effect>;
};

function appendEffect(effects: ReadonlyArray<Effect>, next: Effect) {
  return [...effects, next];
}

const hasPickupCapacity = (
  e: Extract<IssueEvent, { readonly type: 'PICKUP_REQUESTED' }>,
) =>
  e.leafKind === 'leaf' &&
  e.blockerState === 'all_closed' &&
  isoCount.unwrap(e.openPrCount) === 0 &&
  isoCount.unwrap(e.wipCount) < isoCount.unwrap(e.wipLimit);

const canPickupEvent = (event: IssueEvent) =>
  event.type === 'PICKUP_REQUESTED' ? hasPickupCapacity(event) : false;

const canRetryEvent = (event: IssueEvent) =>
  event.type === 'TRANSIENT_EXECUTION_FAILED'
    ? isoCount.unwrap(event.retryCount) < isoCount.unwrap(event.maxRetries)
    : false;

const appendCommentEffect = (context: IssueMachineContext, body: Body) => ({
  effects: appendEffect(context.effects, {
    type: 'ADD_COMMENT',
    issueNumber: context.issueNumber,
    body,
  }),
});

const formatLabeledDetail = (headline: string, label: string, detail: string) =>
  `${headline}\n\n**${label}:** ${detail}`;

const buildLabeledBody = (headline: string, label: string, detail: Message) =>
  flow(
    isoMessage.unwrap,
    (detailText) => formatLabeledDetail(headline, label, detailText),
    isoBody.wrap,
  )(detail);

const buildBodyWithReason = (headline: string, reason: Message) =>
  buildLabeledBody(headline, 'Reason', reason);

const formatPrOpenedHeadline = (prNumber: number, branch: string) =>
  `PR #${String(prNumber)} opened on branch \`${branch}\`.`;

function buildPrOpenedHeadline(
  event: Extract<IssueEvent, { readonly type: 'EXECUTION_SUCCEEDED' }>,
) {
  return formatPrOpenedHeadline(
    isoPrNumber.unwrap(event.prNumber),
    isoBranchName.unwrap(event.branch),
  );
}

function buildPrOpenedBody(
  event: Extract<IssueEvent, { readonly type: 'EXECUTION_SUCCEEDED' }>,
) {
  return buildLabeledBody(buildPrOpenedHeadline(event), 'Summary', event.summary);
}

const buildExecutionFailedBody = (
  event: Extract<IssueEvent, { readonly type: 'EXECUTION_FAILED' }>,
) =>
  buildBodyWithReason(
    'Automated execution failed and requires human intervention.',
    event.reason,
  );

const formatTransientRetryHeadline = (attempt: number, maxRetries: number) =>
  `<!-- pr-flow:retries=${String(attempt)} -->\nTransient agent API error (attempt ${String(attempt)}/${String(maxRetries)}); re-queued \`pr-flow-status\` to \`ready\` for automatic retry.`;

function buildTransientRetryHeadline(
  event: Extract<IssueEvent, { readonly type: 'TRANSIENT_EXECUTION_FAILED' }>,
) {
  return formatTransientRetryHeadline(
    isoCount.unwrap(event.retryCount) + 1,
    isoCount.unwrap(event.maxRetries),
  );
}

function buildTransientRetryBody(
  event: Extract<IssueEvent, { readonly type: 'TRANSIENT_EXECUTION_FAILED' }>,
) {
  return buildBodyWithReason(buildTransientRetryHeadline(event), event.reason);
}

const formatTransientExhaustedHeadline = (maxRetries: number) =>
  `Automated execution failed after ${String(maxRetries)} transient retries and requires human intervention.`;

function buildTransientExhaustedHeadline(
  event: Extract<IssueEvent, { readonly type: 'TRANSIENT_EXECUTION_FAILED' }>,
) {
  return formatTransientExhaustedHeadline(isoCount.unwrap(event.maxRetries));
}

function buildTransientExhaustedBody(
  event: Extract<IssueEvent, { readonly type: 'TRANSIENT_EXECUTION_FAILED' }>,
) {
  return buildBodyWithReason(buildTransientExhaustedHeadline(event), event.reason);
}

const buildNeedsHumanBody = (
  event: Extract<IssueEvent, { readonly type: 'NEEDS_HUMAN_DETECTED' }>,
) => buildBodyWithReason('AI agent requested human clarification.', event.reason);

const formatReviewTransientRetryHeadline = (attempt: number, maxRetries: number) =>
  `<!-- pr-flow:retries=${String(attempt)} -->\nTransient agent API error during review follow-up (attempt ${String(attempt)}/${String(maxRetries)}); keeping \`pr-flow-status\` in \`review-pending\`.`;

function buildReviewTransientRetryHeadline(
  event: Extract<IssueEvent, { readonly type: 'TRANSIENT_EXECUTION_FAILED' }>,
) {
  return formatReviewTransientRetryHeadline(
    isoCount.unwrap(event.retryCount) + 1,
    isoCount.unwrap(event.maxRetries),
  );
}

function buildReviewTransientRetryBody(
  event: Extract<IssueEvent, { readonly type: 'TRANSIENT_EXECUTION_FAILED' }>,
) {
  return buildBodyWithReason(buildReviewTransientRetryHeadline(event), event.reason);
}

const formatReviewTransientExhaustedHeadline = (maxRetries: number) =>
  `Review follow-up failed after ${String(maxRetries)} transient retries.`;

function buildReviewTransientExhaustedHeadline(
  event: Extract<IssueEvent, { readonly type: 'TRANSIENT_EXECUTION_FAILED' }>,
) {
  return formatReviewTransientExhaustedHeadline(isoCount.unwrap(event.maxRetries));
}

function buildReviewTransientExhaustedBody(
  event: Extract<IssueEvent, { readonly type: 'TRANSIENT_EXECUTION_FAILED' }>,
) {
  return buildBodyWithReason(buildReviewTransientExhaustedHeadline(event), event.reason);
}

const buildReviewFailedBody = (
  event: Extract<IssueEvent, { readonly type: 'EXECUTION_FAILED' }>,
) => buildBodyWithReason('Review follow-up failed.', event.reason);

const buildReviewNeedsHumanBody = (
  event: Extract<IssueEvent, { readonly type: 'NEEDS_HUMAN_DETECTED' }>,
) => buildBodyWithReason('Review follow-up requested human intervention.', event.reason);

export const issueMachine = setup({
  types: {
    context: {} as IssueMachineContext,
    events: {} as IssueEvent,
    input: {} as { readonly issueNumber: IssueNumber },
  },
  guards: {
    canPickup: ({ event }) => canPickupEvent(event),
    canRetry: ({ event }) => canRetryEvent(event),
  },
  actions: {
    emitStatusFieldSet: assign(({ context }, params: { readonly from: IssueStatus; readonly to: IssueStatus }) => ({
      effects: appendEffect(context.effects, {
        type: 'SET_STATUS_FIELD',
        issueNumber: context.issueNumber,
        transition: { kind: 'transition', from: params.from, to: params.to },
      }),
    })),
    emitComment: assign(({ context }, params: { readonly body: Body }) =>
      appendCommentEffect(context, params.body),
    ),
    emitCloseIssue: assign(({ context }) => ({
      effects: appendEffect(context.effects, {
        type: 'CLOSE_ISSUE',
        issueNumber: context.issueNumber,
      }),
    })),
    emitReopenIssue: assign(({ context }) => ({
      effects: appendEffect(context.effects, {
        type: 'REOPEN_ISSUE',
        issueNumber: context.issueNumber,
      }),
    })),
  },
}).createMachine({
  id: 'issueLifecycle',
  initial: 'backlog',
  context: ({ input }) => ({
    issueNumber: input.issueNumber,
    effects: [],
  }),
  states: {
    backlog: {
      on: {
        DEPS_BLOCKED: {
          target: 'blocked_dep',
          actions: { type: 'emitStatusFieldSet', params: { from: 'backlog', to: 'blocked_dep' } },
        },
        DEPS_RESOLVED: {
          target: 'ready',
          actions: { type: 'emitStatusFieldSet', params: { from: 'backlog', to: 'ready' } },
        },
      },
    },
    blocked_dep: {
      on: {
        DEPS_RESOLVED: {
          target: 'ready',
          actions: [
            { type: 'emitStatusFieldSet', params: { from: 'blocked_dep', to: 'ready' } },
            {
              type: 'emitComment',
              params: {
                body: isoBody.wrap(
                  'All upstream dependencies are closed. Issue `pr-flow-status` is now `ready`.',
                ),
              },
            },
          ],
        },
      },
    },
    ready: {
      on: {
        DEPS_BLOCKED: {
          target: 'blocked_dep',
          actions: [
            { type: 'emitStatusFieldSet', params: { from: 'ready', to: 'blocked_dep' } },
          ],
        },
        PICKUP_REQUESTED: {
          guard: 'canPickup',
          target: 'in_progress',
          actions: { type: 'emitStatusFieldSet', params: { from: 'ready', to: 'in_progress' } },
        },
        PR_MERGED: {
          target: 'fixed',
          actions: [
            { type: 'emitStatusFieldSet', params: { from: 'ready', to: 'fixed' } },
            { type: 'emitCloseIssue' },
          ],
        },
      },
    },
    in_progress: {
      on: {
        EXECUTION_SUCCEEDED: {
          target: 'review_pending',
          actions: [
            { type: 'emitStatusFieldSet', params: { from: 'in_progress', to: 'review_pending' } },
            assign(({ context, event }) => appendCommentEffect(context, buildPrOpenedBody(event))),
          ],
        },
        EXECUTION_FAILED: {
          target: 'needs_human',
          actions: [
            { type: 'emitStatusFieldSet', params: { from: 'in_progress', to: 'needs_human' } },
            assign(({ context, event }) =>
              appendCommentEffect(context, buildExecutionFailedBody(event)),
            ),
          ],
        },
        TRANSIENT_EXECUTION_FAILED: [
          {
            guard: 'canRetry',
            target: 'ready',
            actions: [
              { type: 'emitStatusFieldSet', params: { from: 'in_progress', to: 'ready' } },
              assign(({ context, event }) =>
                appendCommentEffect(context, buildTransientRetryBody(event)),
              ),
            ],
          },
          {
            target: 'needs_human',
            actions: [
              { type: 'emitStatusFieldSet', params: { from: 'in_progress', to: 'needs_human' } },
              assign(({ context, event }) =>
                appendCommentEffect(context, buildTransientExhaustedBody(event)),
              ),
            ],
          },
        ],
        NEEDS_HUMAN_DETECTED: {
          target: 'needs_human',
          actions: [
            { type: 'emitStatusFieldSet', params: { from: 'in_progress', to: 'needs_human' } },
            assign(({ context, event }) => appendCommentEffect(context, buildNeedsHumanBody(event))),
          ],
        },
        PR_MERGED: {
          target: 'fixed',
          actions: [
            { type: 'emitStatusFieldSet', params: { from: 'in_progress', to: 'fixed' } },
            { type: 'emitCloseIssue' },
          ],
        },
      },
    },
    review_pending: {
      on: {
        REVIEW_CHANGES_REQUESTED: {
          target: 'in_progress',
          actions: { type: 'emitStatusFieldSet', params: { from: 'review_pending', to: 'in_progress' } },
        },
        PR_MERGED: {
          target: 'fixed',
          actions: [
            { type: 'emitStatusFieldSet', params: { from: 'review_pending', to: 'fixed' } },
            { type: 'emitCloseIssue' },
          ],
        },
        TRANSIENT_EXECUTION_FAILED: [
          {
            guard: 'canRetry',
            target: 'review_pending',
            actions: assign(({ context, event }) =>
              appendCommentEffect(context, buildReviewTransientRetryBody(event)),
            ),
          },
          {
            target: 'needs_human',
            actions: [
              { type: 'emitStatusFieldSet', params: { from: 'review_pending', to: 'needs_human' } },
              assign(({ context, event }) =>
                appendCommentEffect(context, buildReviewTransientExhaustedBody(event)),
              ),
            ],
          },
        ],
        EXECUTION_FAILED: {
          target: 'needs_human',
          actions: [
            { type: 'emitStatusFieldSet', params: { from: 'review_pending', to: 'needs_human' } },
            assign(({ context, event }) =>
              appendCommentEffect(context, buildReviewFailedBody(event)),
            ),
          ],
        },
        NEEDS_HUMAN_DETECTED: {
          target: 'needs_human',
          actions: [
            { type: 'emitStatusFieldSet', params: { from: 'review_pending', to: 'needs_human' } },
            assign(({ context, event }) =>
              appendCommentEffect(context, buildReviewNeedsHumanBody(event)),
            ),
          ],
        },
      },
    },
    needs_human: {
      on: {
        HUMAN_REQUEUED: {
          target: 'ready',
          actions: { type: 'emitStatusFieldSet', params: { from: 'needs_human', to: 'ready' } },
        },
        DEPS_BLOCKED: {
          target: 'blocked_dep',
          actions: { type: 'emitStatusFieldSet', params: { from: 'needs_human', to: 'blocked_dep' } },
        },
        PR_MERGED: {
          target: 'fixed',
          actions: [
            { type: 'emitStatusFieldSet', params: { from: 'needs_human', to: 'fixed' } },
            { type: 'emitCloseIssue' },
          ],
        },
      },
    },
    fixed: {
      on: {
        HUMAN_REQUEUED: {
          target: 'ready',
          actions: [
            { type: 'emitReopenIssue' },
            { type: 'emitStatusFieldSet', params: { from: 'fixed', to: 'ready' } },
          ],
        },
      },
    },
  },
});

export type TransitionChangeKind = 'changed' | 'unchanged';

export type TransitionResult = {
  readonly previousStatus: IssueStatus;
  readonly nextStatus: IssueStatus;
  readonly changeKind: TransitionChangeKind;
  readonly effects: ReadonlyArray<Effect>;
};

const toTransitionResult = (
  previousStatus: IssueStatus,
  nextSnapshot: { readonly value: IssueStatus; readonly context: IssueMachineContext },
) => ({
  previousStatus,
  nextStatus: nextSnapshot.value,
  changeKind: nextSnapshot.value !== previousStatus ? 'changed' : 'unchanged',
  effects: nextSnapshot.context.effects,
});

export function transitionIssue(
  issue: Pick<IssueNode, 'number' | 'status'>,
  event: IssueEvent,
) {
  return toTransitionResult(
    issue.status,
    transition(
      issueMachine,
      issueMachine.resolveState({
        value: issue.status,
        context: { issueNumber: issue.number, effects: [] },
      }),
      event,
    )[0],
  );
}
