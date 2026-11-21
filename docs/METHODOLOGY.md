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
- Counts **only executable leaf `in-progress`** issues (container rollups and `review-pending` are uncapped so parent rollups and human code review never stall automated pickup of unblocked work).
- `claim` jobs are serialized via GitHub Actions `concurrency: { group: fsm-claim, cancel-in-progress: false }` to prevent WIP-limit race conditions while allowing `execute` jobs to run in parallel (`sync` uses `fsm-sync`; `reconcile` uses `fsm-dispatcher`).

## 3. Native GitHub Dependencies

`pr-flow` uses GitHub's native REST endpoints:
- `GET/POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues`
- `GET/POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by`
- `GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocking`

## 4. Lazy Branching & Split-Job Security

1. **Job 1 (`claim`)**: Runs deterministic FSM guards (`isExecutableLeaf`, `pr-flow-status == ready`, `allBlockersClosed`, `openPrCount === 0`, `wipCount < wipLimit`) and sets `pr-flow-status` to `in-progress`.
2. **Job 2 (`execute`)**: Runs with **zero `issues: write` / `contents: write` permissions**, executing `workspace.setupCommand`, the AI agent (with `agent.fallbackModels` + working-tree reset on transient/unavailable model errors), and `workspace.verifyCommand` in an automatic verify-and-fix loop (up to `agent.maxVerifyRetries` attempts), exporting `changes.patch` + `result.json` (plus `review-threads.json` in review mode) as workflow artifacts.
3. **Job 3 (`finalize`)**:
   - **On `success`**: Creates `ai/issue-<N>` from latest `baseBranch`, applies `changes.patch`, pushes the branch, opens 1 PR (`Closes #<N>`, label `ai-managed`), and sets `pr-flow-status` to `review-pending`.
   - **On `retryable`**: Re-queues `pr-flow-status` to `ready` (up to `agent.maxRetries`) or `needs-human` once exhausted.
   - **On `failed` / `needs_human`**: Transitions `pr-flow-status` to `needs-human`, and if `changes.patch` is non-empty, pushes partial commits to `ai/issue-<N>` and opens a **`[WIP]` draft PR** for inspection.
4. **Review Follow-Ups & Merge**: Follow-up fixes append commits to `ai/issue-<N>`, reply to and resolve addressed inline review threads, and re-request `CHANGES_REQUESTED` reviewers. On approval (when `triggers.autoMergeOnApprove: true`), `reusable-merge.yml` merges using `triggers.mergeMethod` (default `squash`, keeping **1 Issue = 1 PR = 1 Commit**).

## 5. Decomposition & Granularity Principles

The **1 leaf issue = 1 PR = 1 commit** rule is a **control-plane invariant** (for deterministic state transitions, clean WIP accounting, and atomic rollbacks)—not a mandate to fracture cohesive features into horizontal micro-tasks upfront.

- **Granularity floor:** Scope each executable leaf to the smallest **cohesive, behaviorally verifiable** increment. If splitting a change forces the issue body to prescribe internal file paths, private signatures, or step-by-step wiring just to bridge PRs, the slice is too small.
- **Contract-scoped specs:** Put system architecture and design context on `type:epic` / parent `type:story` issues (or a checked-in design doc). Keep leaf issue bodies focused on **observable inputs/outputs, boundary contracts, and acceptance criteria** rather than implementation prescriptions.
- **Vertical over horizontal slicing:** Prefer thin vertical tracer bullets (end-to-end minimal behavior, optionally behind a feature flag) over horizontal layer splits (types PR → repository PR → service PR → handler PR) that create dead code and over-specified intermediate contracts.
- **Use leaf `type:story` as an escape hatch:** Because a `type:story` with **0** sub-issues is directly executable, keep a cohesive change as a single leaf story rather than over-decomposing tightly coupled code.
- **Rolling-wave planning & contract-first fan-out:** Avoid materializing deep leaf trees for an entire epic before code lands. Materialize Wave 1 (or a contract/interface PR first for parallel work), then decompose downstream leaves once real types and module boundaries exist on `baseBranch`.

