# Configuration & CLI Reference

## `pr-flow.config.yml`

Schema defined in [`src/domain/config.ts`](../src/domain/config.ts).

| Key | Type / Values | Default | Description |
| --- | --- | --- | --- |
| `version` | `1` | *(required)* | Config schema version |
| `wipLimit` | `int >= 1` | `4` | Max concurrent executable leaf `in-progress` issues |
| `baseBranch` | `string` | `'main'` | Target branch for PRs and diff calculation |
| `statusFieldName` | `string` | `'pr-flow-status'` | Organization Single-Select Issue Field name |
| `workspace.setupCommand` | `string` | `''` | Dependency install command run before execution |
| `workspace.verifyCommand` | `string` | *(required)* | Verification command (typecheck, lint, test) |
| `agent.provider` | `'gemini' \| 'custom'` | `'gemini'` | Agent runtime (`custom` requires `agent.command`) |
| `agent.model` | `string` | `'gemini-3.8-flash'` | Primary Gemini model (`init` defaults to `gemini-3.8-flash`) |
| `agent.fallbackModels` | `string[]` | `[]` | Ordered fallback models on transient/404 errors |
| `agent.command` | `string` | — | Shell command when `provider: custom` (`PR_FLOW_PROMPT_FILE` & `PR_FLOW_RESULT_FILE` env vars are provided) |
| `agent.maxRetries` | `int >= 0` | `3` | Max transient-error re-queues across CI runs |
| `agent.maxVerifyRetries` | `int >= 0` | `10` | Max in-job verify-and-fix iterations |
| `agent.timeoutMinutes` | `int >= 1` | `20` | Overall agent execution budget per run |
| `agent.maxSessionTurns` | `int >= 1` | `25` | Gemini CLI `model.maxSessionTurns` |
| `agent.compressionThreshold` | `0.05..0.95` | `0.2` | Gemini CLI `model.compressionThreshold` |
| `agent.thinkingBudget` | `int >= 0` | — | Optional Gemini `thinkingConfig.thinkingBudget` |
| `triggers.reviewMode` | `'changes_requested' \| 'comment' \| 'both'` | `'changes_requested'` | PR feedback events that trigger follow-ups |
| `triggers.autoPickup` | `boolean` | `true` | Allow `reconcile` to auto-dispatch `ready` issues and stale `CHANGES_REQUESTED` PRs |
| `triggers.autoMergeOnApprove` | `boolean` | `true` | Auto-merge `ai-managed` PRs on approval |
| `triggers.mergeMethod` | `'squash' \| 'merge' \| 'rebase'` | `'squash'` | Merge strategy used by `pr-flow merge` |

## User-Facing CLI Commands

| Command | Purpose |
| --- | --- |
| `pr-flow init` | Generate `pr-flow.config.yml`, `AGENTS.md`, `.agents/skills/pr-flow/SKILL.md`, and workflows (`--sync-labels`, `--create-custom-field`, `--force`, `--skip-checks`) |
| `pr-flow doctor` | Check `pr-flow` visibility, Actions PR permissions, `pr-flow-status` Issue Field, labels, and Actions secret (`--field-name`, `--secret-name`) |
| `pr-flow labels sync` | Idempotently create/update `type:*` and `ai-managed` labels |
| `pr-flow fields sync` | Idempotently create the `pr-flow-status` organization Issue Field |
| `pr-flow status set --issue <N> --status <S>` | Set `pr-flow-status` (`backlog\|blocked-dep\|ready\|in-progress\|review-pending\|fixed\|needs-human`) |
| `pr-flow plan validate --file <path>` | Validate `plan-manifest.yml` schema and DAG |
| `pr-flow plan materialize --file <path>` | Create GitHub issues, sub-issue links, and `blocked_by` dependencies |
| `pr-flow reconcile` | Unblock `blocked-dep` issues, recompute rollups, and dispatch ready work / pending review fixes (`--cooldown-minutes`) |

*(Internal workflow commands used by reusable GitHub Actions: `claim`, `execute`, `finalize`, `merge`, `sync`.)*
