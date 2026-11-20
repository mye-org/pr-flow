# `pr-flow` State Machine

The issue lifecycle is modeled as a deterministic **XState v5** machine (`src/machine/issueMachine.ts`) paired with pure **`fp-ts`** guards (`src/machine/guards.ts`) and an exhaustive **`ts-pattern`** effect interpreter (`src/interpreter/executeEffects.ts`).

## States

| State | `pr-flow-status` Field Value | Meaning |
| --- | --- | --- |
| `backlog` | `backlog` | Unrefined or not yet scheduled |
| `blocked_dep` | `blocked-dep` | Blocked by one or more open `blocked_by` issues |
| `ready` | `ready` | Eligible for automated AI pickup |
| `in_progress` | `in-progress` | Claimed by `pr-flow` and actively executing (counts toward WIP) |
| `review_pending` | `review-pending` | PR opened and awaiting human review (uncapped WIP) |
| `fixed` | `fixed` | PR merged and issue closed |
| `needs_human` | `needs-human` | Execution failed or agent requested human clarification |

## Transitions

```text
backlog ──(DEPS_BLOCKED)──────────────▶ blocked_dep
backlog ──(DEPS_RESOLVED)─────────────▶ ready
blocked_dep ──(DEPS_RESOLVED)─────────▶ ready
ready ──(PICKUP_REQUESTED [guards])───▶ in_progress
in_progress ──(EXECUTION_SUCCEEDED)───▶ review_pending
in_progress ──(EXECUTION_FAILED)──────▶ needs_human
in_progress ──(NEEDS_HUMAN_DETECTED)──▶ needs_human
review_pending ──(REVIEW_CHANGES_REQ)─▶ in_progress
review_pending ──(PR_MERGED)──────────▶ fixed
needs_human ──(HUMAN_REQUEUED)────────▶ ready
```

## Pure Guards (`checkPickupEligibility`)

Before claiming an issue, `pr-flow claim` verifies:
1. `isExecutableLeaf(issue)` is `true` (`NOT_AN_EXECUTABLE_LEAF` otherwise)
2. `issue.status === 'ready'` (`INVALID_STATE_FOR_PICKUP` otherwise)
3. All `blocked_by` issues are `closed` (`BLOCKED_BY_DEPENDENCIES` otherwise)
4. Zero open PRs exist for `ai/issue-<N>` (`PR_ALREADY_EXISTS` otherwise)
5. Current `in-progress` count `< wipLimit` (`WIP_LIMIT_REACHED` otherwise)
