# `pr-flow` Methodology

## 1. Agile Hierarchy (Leaf Execution + Parent Rollup)

`pr-flow` models work using standard Agile issue types via `type:*` labels:

| Type | Role | Execution |
| --- | --- | --- |
| `type:epic` | Top-level container | Never executed directly; status rolls up from child sub-issues. |
| `type:story` | Container *or* leaf | Container if it has sub-issues; executable leaf if it has **0** sub-issues. |
| `type:task` | Executable leaf | Strict **1 PR per issue** (`ai/issue-<N>`, `Closes #<N>`). |
| `type:bug` | Executable leaf | Strict **1 PR per issue** (`ai/issue-<N>`, `Closes #<N>`). |

### Parent Rollup Precedence
Container `pr-flow-status` is computed deterministically from child sub-issues:
1. Any child `needs-human` → `needs-human`
2. All children `fixed` → `fixed` (and closes parent)
3. Any child `in-progress`, `review-pending`, or `fixed` (partial progress) → `in-progress`
4. Any child `ready` → `ready`
5. Any child `blocked-dep` → `blocked-dep`
6. Otherwise → `backlog`

## 2. WIP Limit & Serialization

- Default `wipLimit: 4` (configurable in `pr-flow.config.yml`).
- Counts **only `in-progress`** issues. `review-pending` is uncapped so human code review never stalls automated pickup of unblocked work.
- All state transitions are serialized via GitHub Actions `concurrency: { group: fsm-dispatcher, cancel-in-progress: false }`.

## 3. Native GitHub Dependencies

`pr-flow` uses GitHub's native REST endpoints:
- `GET/POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues`
- `GET/POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by`
- `GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocking`

## 4. Lazy Branching & Split-Job Security

1. **Job 1 (`claim`)**: Runs deterministic FSM guards (`isExecutableLeaf`, `pr-flow-status == ready`, `allBlockersClosed`, `openPrCount === 0`, `wipCount < wipLimit`) and sets `pr-flow-status` to `in-progress`.
2. **Job 2 (`execute`)**: Runs the AI coding agent + `workspace.verifyCommand` with **zero `issues: write` / `contents: write` permissions**, exporting `changes.patch` + `result.json` as workflow artifacts.
3. **Job 3 (`finalize`)**: Creates `ai/issue-<N>` from latest `main`, applies `changes.patch`, pushes branch, opens 1 PR (`Closes #<N>`, label `ai-managed`), and sets `pr-flow-status` to `review-pending` (or `needs-human` on failure).
4. **Review Follow-Ups & Squash Merge**: Follow-up fixes append commits to `ai/issue-<N>`. Squash & Merge keeps `main` linear (**1 Issue = 1 PR = 1 Commit**).
