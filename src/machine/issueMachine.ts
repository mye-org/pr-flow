import { assign, getNextSnapshot, setup } from 'xstate';
import type { Effect } from '../domain/effects.js';
import type { IssueEvent } from '../domain/events.js';
import type { IssueNode, IssueStatus } from '../domain/issue.js';

export interface IssueMachineContext {
  issueNumber: number;
  effects: Effect[];
}

function appendEffect(effects: Effect[], next: Effect): Effect[] {
  return [...effects, next];
}

export const issueMachine = setup({
  types: {
    context: {} as IssueMachineContext,
    events: {} as IssueEvent,
    input: {} as { issueNumber: number },
  },
  guards: {
    canPickup: ({ event }) => {
      if (event.type !== 'PICKUP_REQUESTED') return false;
      return (
        event.isLeaf &&
        event.allBlockersClosed &&
        event.openPrCount === 0 &&
        event.wipCount < event.wipLimit
      );
    },
    canRetry: ({ event }) => {
      if (event.type !== 'TRANSIENT_EXECUTION_FAILED') return false;
      return event.retryCount < event.maxRetries;
    },
  },
  actions: {
    emitLabelSwap: assign(({ context }, params: { from: IssueStatus; to: IssueStatus }) => ({
      effects: appendEffect(context.effects, {
        type: 'SWAP_STATUS_LABEL',
        issueNumber: context.issueNumber,
        from: params.from,
        to: params.to,
      }),
    })),
    emitComment: assign(({ context }, params: { body: string }) => ({
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
          actions: { type: 'emitLabelSwap', params: { from: 'backlog', to: 'blocked_dep' } },
        },
        DEPS_RESOLVED: {
          target: 'ready',
          actions: { type: 'emitLabelSwap', params: { from: 'backlog', to: 'ready' } },
        },
      },
    },
    blocked_dep: {
      on: {
        DEPS_RESOLVED: {
          target: 'ready',
          actions: [
            { type: 'emitLabelSwap', params: { from: 'blocked_dep', to: 'ready' } },
            {
              type: 'emitComment',
              params: { body: 'All upstream dependencies are closed. Issue is now `status:ready`.' },
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
            { type: 'emitLabelSwap', params: { from: 'ready', to: 'blocked_dep' } },
          ],
        },
        PICKUP_REQUESTED: {
          guard: 'canPickup',
          target: 'in_progress',
          actions: { type: 'emitLabelSwap', params: { from: 'ready', to: 'in_progress' } },
        },
      },
    },
    in_progress: {
      on: {
        EXECUTION_SUCCEEDED: {
          target: 'review_pending',
          actions: [
            { type: 'emitLabelSwap', params: { from: 'in_progress', to: 'review_pending' } },
            assign(({ context, event }) => ({
              effects: appendEffect(context.effects, {
                type: 'ADD_COMMENT',
                issueNumber: context.issueNumber,
                body: `PR #${event.prNumber} opened on branch \`${event.branch}\`.\n\n**Summary:** ${event.summary}`,
              }),
            })),
          ],
        },
        EXECUTION_FAILED: {
          target: 'needs_human',
          actions: [
            { type: 'emitLabelSwap', params: { from: 'in_progress', to: 'needs_human' } },
            assign(({ context, event }) => ({
              effects: appendEffect(context.effects, {
                type: 'ADD_COMMENT',
                issueNumber: context.issueNumber,
                body: `Automated execution failed and requires human intervention.\n\n**Reason:** ${event.reason}`,
              }),
            })),
          ],
        },
        TRANSIENT_EXECUTION_FAILED: [
          {
            guard: 'canRetry',
            target: 'ready',
            actions: [
              { type: 'emitLabelSwap', params: { from: 'in_progress', to: 'ready' } },
              assign(({ context, event }) => ({
                effects: appendEffect(context.effects, {
                  type: 'ADD_COMMENT',
                  issueNumber: context.issueNumber,
                  body: `<!-- pr-flow:retries=${event.retryCount + 1} -->\nTransient agent API error (attempt ${event.retryCount + 1}/${event.maxRetries}); re-queued to \`status:ready\` for automatic retry.\n\n**Reason:** ${event.reason}`,
                }),
              })),
            ],
          },
          {
            target: 'needs_human',
            actions: [
              { type: 'emitLabelSwap', params: { from: 'in_progress', to: 'needs_human' } },
              assign(({ context, event }) => ({
                effects: appendEffect(context.effects, {
                  type: 'ADD_COMMENT',
                  issueNumber: context.issueNumber,
                  body: `Automated execution failed after ${event.maxRetries} transient retries and requires human intervention.\n\n**Reason:** ${event.reason}`,
                }),
              })),
            ],
          },
        ],
        NEEDS_HUMAN_DETECTED: {
          target: 'needs_human',
          actions: [
            { type: 'emitLabelSwap', params: { from: 'in_progress', to: 'needs_human' } },
            assign(({ context, event }) => ({
              effects: appendEffect(context.effects, {
                type: 'ADD_COMMENT',
                issueNumber: context.issueNumber,
                body: `AI agent requested human clarification.\n\n**Reason:** ${event.reason}`,
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
          actions: { type: 'emitLabelSwap', params: { from: 'review_pending', to: 'in_progress' } },
        },
        PR_MERGED: {
          target: 'fixed',
          actions: [
            { type: 'emitLabelSwap', params: { from: 'review_pending', to: 'fixed' } },
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
                body: `<!-- pr-flow:retries=${event.retryCount + 1} -->\nTransient agent API error during review follow-up (attempt ${event.retryCount + 1}/${event.maxRetries}); keeping in \`status:review-pending\`.\n\n**Reason:** ${event.reason}`,
              }),
            })),
          },
          {
            target: 'needs_human',
            actions: [
              { type: 'emitLabelSwap', params: { from: 'review_pending', to: 'needs_human' } },
              assign(({ context, event }) => ({
                effects: appendEffect(context.effects, {
                  type: 'ADD_COMMENT',
                  issueNumber: context.issueNumber,
                  body: `Review follow-up failed after ${event.maxRetries} transient retries.\n\n**Reason:** ${event.reason}`,
                }),
              })),
            ],
          },
        ],
        EXECUTION_FAILED: {
          target: 'needs_human',
          actions: [
            { type: 'emitLabelSwap', params: { from: 'review_pending', to: 'needs_human' } },
            assign(({ context, event }) => ({
              effects: appendEffect(context.effects, {
                type: 'ADD_COMMENT',
                issueNumber: context.issueNumber,
                body: `Review follow-up failed.\n\n**Reason:** ${event.reason}`,
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
          actions: { type: 'emitLabelSwap', params: { from: 'needs_human', to: 'ready' } },
        },
        DEPS_BLOCKED: {
          target: 'blocked_dep',
          actions: { type: 'emitLabelSwap', params: { from: 'needs_human', to: 'blocked_dep' } },
        },
      },
    },
    fixed: {
      on: {
        HUMAN_REQUEUED: {
          target: 'ready',
          actions: [
            { type: 'emitReopenIssue' },
            { type: 'emitLabelSwap', params: { from: 'fixed', to: 'ready' } },
          ],
        },
      },
    },
  },
});

export interface TransitionResult {
  previousStatus: IssueStatus;
  nextStatus: IssueStatus;
  changed: boolean;
  effects: Effect[];
}

export function transitionIssue(
  issue: Pick<IssueNode, 'number' | 'status'>,
  event: IssueEvent,
): TransitionResult {
  const currentSnapshot = issueMachine.resolveState({
    value: issue.status,
    context: {
      issueNumber: issue.number,
      effects: [],
    },
  });

  const nextSnapshot = getNextSnapshot(issueMachine, currentSnapshot, event);
  const nextStatus = nextSnapshot.value as IssueStatus;
  const changed = nextStatus !== issue.status;

  return {
    previousStatus: issue.status,
    nextStatus,
    changed,
    effects: nextSnapshot.context.effects,
  };
}
