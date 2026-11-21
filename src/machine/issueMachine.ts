import * as O from 'fp-ts/lib/Option';
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
        from: O.some(params.from),
        to: params.to,
      }),
    })),
    emitComment: assign(({ context }, params: { readonly body: Body }) => ({
      effects: appendEffect(context.effects, {
        type: 'ADD_COMMENT',
        issueNumber: context.issueNumber,
        body: params.body,
      }),
    })),
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
      },
    },
    in_progress: {
      on: {
        EXECUTION_SUCCEEDED: {
          target: 'review_pending',
          actions: [
            { type: 'emitStatusFieldSet', params: { from: 'in_progress', to: 'review_pending' } },
            assign(({ context, event }) => ({
              effects: appendEffect(context.effects, {
                type: 'ADD_COMMENT',
                issueNumber: context.issueNumber,
                body: isoBody.wrap(
                  `PR #${String(isoPrNumber.unwrap(event.prNumber))} opened on branch \`${isoBranchName.unwrap(event.branch)}\`.\n\n**Summary:** ${isoMessage.unwrap(event.summary)}`,
                ),
              }),
            })),
          ],
        },
        EXECUTION_FAILED: {
          target: 'needs_human',
          actions: [
            { type: 'emitStatusFieldSet', params: { from: 'in_progress', to: 'needs_human' } },
            assign(({ context, event }) => ({
              effects: appendEffect(context.effects, {
                type: 'ADD_COMMENT',
                issueNumber: context.issueNumber,
                body: isoBody.wrap(
                  `Automated execution failed and requires human intervention.\n\n**Reason:** ${isoMessage.unwrap(event.reason)}`,
                ),
              }),
            })),
          ],
        },
        TRANSIENT_EXECUTION_FAILED: [
          {
            guard: 'canRetry',
            target: 'ready',
            actions: [
              { type: 'emitStatusFieldSet', params: { from: 'in_progress', to: 'ready' } },
              assign(({ context, event }) => ({
                effects: appendEffect(context.effects, {
                  type: 'ADD_COMMENT',
                  issueNumber: context.issueNumber,
                  body: isoBody.wrap(
                    `<!-- pr-flow:retries=${String(isoCount.unwrap(event.retryCount) + 1)} -->\nTransient agent API error (attempt ${String(isoCount.unwrap(event.retryCount) + 1)}/${String(isoCount.unwrap(event.maxRetries))}); re-queued \`pr-flow-status\` to \`ready\` for automatic retry.\n\n**Reason:** ${isoMessage.unwrap(event.reason)}`,
                  ),
                }),
              })),
            ],
          },
          {
            target: 'needs_human',
            actions: [
              { type: 'emitStatusFieldSet', params: { from: 'in_progress', to: 'needs_human' } },
              assign(({ context, event }) => ({
                effects: appendEffect(context.effects, {
                  type: 'ADD_COMMENT',
                  issueNumber: context.issueNumber,
                  body: isoBody.wrap(
                    `Automated execution failed after ${String(isoCount.unwrap(event.maxRetries))} transient retries and requires human intervention.\n\n**Reason:** ${isoMessage.unwrap(event.reason)}`,
                  ),
                }),
              })),
            ],
          },
        ],
        NEEDS_HUMAN_DETECTED: {
          target: 'needs_human',
          actions: [
            { type: 'emitStatusFieldSet', params: { from: 'in_progress', to: 'needs_human' } },
            assign(({ context, event }) => ({
              effects: appendEffect(context.effects, {
                type: 'ADD_COMMENT',
                issueNumber: context.issueNumber,
                body: isoBody.wrap(
                  `AI agent requested human clarification.\n\n**Reason:** ${isoMessage.unwrap(event.reason)}`,
                ),
              }),
            })),
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
            actions: assign(({ context, event }) => ({
              effects: appendEffect(context.effects, {
                type: 'ADD_COMMENT',
                issueNumber: context.issueNumber,
                body: isoBody.wrap(
                  `<!-- pr-flow:retries=${String(isoCount.unwrap(event.retryCount) + 1)} -->\nTransient agent API error during review follow-up (attempt ${String(isoCount.unwrap(event.retryCount) + 1)}/${String(isoCount.unwrap(event.maxRetries))}); keeping \`pr-flow-status\` in \`review-pending\`.\n\n**Reason:** ${isoMessage.unwrap(event.reason)}`,
                ),
              }),
            })),
          },
          {
            target: 'needs_human',
            actions: [
              { type: 'emitStatusFieldSet', params: { from: 'review_pending', to: 'needs_human' } },
              assign(({ context, event }) => ({
                effects: appendEffect(context.effects, {
                  type: 'ADD_COMMENT',
                  issueNumber: context.issueNumber,
                  body: isoBody.wrap(
                    `Review follow-up failed after ${String(isoCount.unwrap(event.maxRetries))} transient retries.\n\n**Reason:** ${isoMessage.unwrap(event.reason)}`,
                  ),
                }),
              })),
            ],
          },
        ],
        EXECUTION_FAILED: {
          target: 'needs_human',
          actions: [
            { type: 'emitStatusFieldSet', params: { from: 'review_pending', to: 'needs_human' } },
            assign(({ context, event }) => ({
              effects: appendEffect(context.effects, {
                type: 'ADD_COMMENT',
                issueNumber: context.issueNumber,
                body: isoBody.wrap(
                  `Review follow-up failed.\n\n**Reason:** ${isoMessage.unwrap(event.reason)}`,
                ),
              }),
            })),
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
