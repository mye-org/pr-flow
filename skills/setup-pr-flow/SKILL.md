---
name: setup-pr-flow
description: Bootstrap any target repository with pr-flow GitHub Issue-to-PR automation, labels, config, AGENTS.md, and reusable workflows.
---

# `setup-pr-flow` Interactive Setup Wizard

Use this playbook when bootstrapping `pr-flow` in a target repository.

## Wizard Principles

- **Interactive, one stage at a time:** Confirm detected settings and wait for user input whenever a step needs a choice, manual action, or elevated permission.
- **Recover gracefully on permission errors:** If a GitHub API call fails (e.g., `403 Resource not accessible by integration` on org-level Issue Fields), explain why, give copy-pasteable CLI/Web UI options, and wait for confirmation.
- **Structured prompts:** Use `ask_question` (if available) for multi-choice decisions; otherwise ask concisely in chat.

---

## Stage 1: Inspect Repository & Confirm Configuration

Inspect the target repository (without writing files yet) to detect:
1. **GitHub slug** (`<owner>/<repo>` from `git remote get-url origin`) — warn if `<owner>` is a personal account rather than a GitHub **Organization** (required for `pr-flow-status` Issue Fields).
2. **`pr-flow` workflow source** (`--owner` and `--ref`, default `mye-org/pr-flow#v1`).
3. **Default base branch** (`main` or `master`).
4. **Setup command** (e.g. `npm ci`, `pnpm install --frozen-lockfile`, `pip install -e .[dev]`, `go mod download`, `cargo fetch`).
5. **Verify command** (e.g. `npm run verify`, `npm test`, `pytest`, `go test ./...`, `cargo test`).
6. **WIP limit** (default `4`) and **review mode** (default `changes_requested`).

**Wizard prompt:** Present a compact summary and ask the user to confirm or adjust before generating files.

---

## Stage 2: Generate Local `pr-flow` Files

Run `init` for file generation only (keep GitHub API sync in Stages 3–4 to isolate permission errors):

```bash
npx --yes github:<prFlowOwner>/pr-flow#<prFlowRef> init \
  --owner <prFlowOwner> \
  --ref <prFlowRef> \
  --base-branch <baseBranch> \
  --wip-limit <wipLimit> \
  --setup-command "<SETUP_COMMAND>" \
  --verify-command "<VERIFY_COMMAND>" \
  --review-mode <reviewMode>
```

Generates `pr-flow.config.yml`, `AGENTS.md`, `.agents/skills/pr-flow/SKILL.md`, and `.github/workflows/pr-flow-{implement,review,sync,reconcile}.yml`.

**Wizard prompt:** Ask if the user wants to customize `AGENTS.md` (architecture notes, lint rules, testing constraints) or `pr-flow.config.yml` (custom AI provider, `autoMergeOnApprove`, `mergeMethod` — see `docs/CONFIGURATION.md`), and apply edits before proceeding.

---

## Stage 3: Sync GitHub Labels

```bash
GITHUB_TOKEN=$(gh auth token) npx --yes github:<prFlowOwner>/pr-flow#<prFlowRef> labels sync --repo <owner>/<repo>
```

- **Success:** Report synced labels and proceed to Stage 4.
- **Failure (missing token / `403`):** Explain `issues: write` is required, share the command above for the user to run locally, and ask them to confirm (or skip).

---

## Stage 4: Sync Organization Issue Field (`pr-flow-status`)

`fields sync` checks existence via repo-scoped GraphQL first and only calls the org-admin API if missing:

```bash
GITHUB_TOKEN=$(gh auth token) npx --yes github:<prFlowOwner>/pr-flow#<prFlowRef> fields sync --repo <owner>/<repo>
```

- **Success:** Proceed to Stage 5.
- **HTTP `403`:** Explain the token lacks **organization-admin** permission to create `pr-flow-status`, and ask the user to complete one option:
  1. **Local org-admin CLI:** Run the `fields sync` command above locally.
  2. **GitHub Web UI:** Open `https://github.com/organizations/<owner>/settings/issue-fields` → create a **Single select** field named `pr-flow-status` with options:
     `backlog`, `blocked-dep`, `ready`, `in-progress`, `review-pending`, `fixed`, `needs-human`
- **HTTP `404`:** Explain Issue Fields require a GitHub Organization with Issue Fields enabled, and ask how to proceed.

---

## Stage 5: Secrets, Workflow Permissions & `doctor`

1. **AI Provider Secret (`GEMINI_API_KEY` by default):**
   - Web UI: `https://github.com/<owner>/<repo>/settings/secrets/actions` → `GEMINI_API_KEY`
   - CLI: `gh secret set GEMINI_API_KEY --repo <owner>/<repo>`
2. **Allow Actions to Create/Approve PRs** (prevents `403` in `finalize`):
   - Web UI: `https://github.com/<owner>/<repo>/settings/actions` → check **"Allow GitHub Actions to create and approve pull requests"** → **Save**.
   - CLI:
     ```bash
     gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow -F can_approve_pull_request_reviews=true
     ```
3. **Verify prerequisites with `doctor`** (add `--secret-name` / `--field-name` if customized):
   ```bash
   GITHUB_TOKEN=$(gh auth token) npx --yes github:<prFlowOwner>/pr-flow#<prFlowRef> doctor --repo <owner>/<repo> --owner <prFlowOwner>
   ```
   - Fix all **`[FAIL]`** items before proceeding.
   - **`[WARN]`** items (e.g., private `pr-flow` fork, or token lacking `administration:read` / `secrets:read`) are non-blocking — ask the user to verify them manually if needed.

**Wizard prompt:** Confirm secrets and Actions PR permissions are configured (or deferred until after push).

---

## Stage 6: Commit, Push & Next Steps

1. Show `git status` and summarize files ready to commit.
2. **Ask for confirmation** before committing and pushing to `<baseBranch>`.
3. Present a **Setup Complete** checklist and offer to help author `plan-manifest.yml` (`plan validate` / `plan materialize`).
