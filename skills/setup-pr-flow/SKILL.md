---
name: setup-pr-flow
description: Bootstrap any target repository with pr-flow GitHub Issue-to-PR automation, labels, config, AGENTS.md, and reusable workflows.
---

# `setup-pr-flow` Interactive Setup Wizard

Use this playbook when the user asks to set up or initialize `pr-flow` in a target repository.

## Wizard Principles

- **Act like an interactive wizard:** Guide the user **one stage at a time**. Confirm detected settings and wait for user input whenever a step requires a choice, manual action, or elevated permission.
- **Never dump a raw error and abort:** If a GitHub API call fails due to token/permission limits (e.g., `403 Resource not accessible by integration` on org-level Issue Fields), explain *why* in plain language, give the user clear copy-pasteable options (Web UI or local CLI), and **pause for their confirmation** before moving to the next stage.
- **Use structured prompts when available:** If your environment provides an interactive question tool (e.g. `ask_question`), use it for multi-choice decisions; otherwise ask concisely in chat.

---

## Stage 1: Inspect Repository & Confirm Configuration

Inspect the target repository (without making changes yet) to auto-detect:
1. **GitHub slug** (`<owner>/<repo>` from `git remote get-url origin`).
   - Note whether `<owner>` is a GitHub **Organization**. (GitHub Issue Fields such as `pr-flow-status` are an organization-level feature; if `<owner>` appears to be a personal user account, warn the user before proceeding.)
2. **`pr-flow` workflow source** (`--owner` and `--ref`, e.g. `mingqianye/pr-flow#v1` or `mye-org/pr-flow#v1` if the user specified a fork/org).
3. **Default base branch** (e.g. `main` or `master`).
4. **Setup command** (e.g. `npm ci`, `pnpm install --frozen-lockfile`, `pip install -e .[dev]`, `go mod download`, `cargo fetch`).
5. **Verify command** (e.g. `npm run verify`, `npm test`, `pytest`, `go test ./...`, `cargo test`).
6. **WIP limit** (default `4`) and **review mode** (default `changes_requested`).

**Wizard prompt:** Present the detected values to the user in a compact summary and ask them to confirm or adjust any setting before generating files.

---

## Stage 2: Generate Local `pr-flow` Files

Once the user confirms the Stage 1 settings, run `init` (file generation only — keep GitHub API sync in Stages 3–4 so permission issues are isolated and easy to handle):

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

This generates:
- `pr-flow.config.yml`
- `AGENTS.md`
- `.agents/skills/pr-flow/SKILL.md`
- `.github/workflows/pr-flow-implement.yml`
- `.github/workflows/pr-flow-review.yml`
- `.github/workflows/pr-flow-sync.yml`
- `.github/workflows/pr-flow-reconcile.yml`

**Wizard prompt:** Summarize the generated files and ask if the user wants to customize `AGENTS.md` (e.g., repository architecture notes, lint rules, or testing constraints) or keep the generated default. Apply any requested edits before moving on.

---

## Stage 3: Sync GitHub Labels

Sync the `type:*` and `ai-managed` labels to the target repository:

```bash
GITHUB_TOKEN=$(gh auth token) npx --yes github:<prFlowOwner>/pr-flow#<prFlowRef> labels sync --repo <owner>/<repo>
```

- **If it succeeds:** Report the synced labels and proceed to Stage 4.
- **If it fails** (e.g., missing token or `403`): Explain that repository `issues: write` permission is needed, provide the exact command above for the user to run locally, and ask them to confirm once done (or choose to skip for now).

---

## Stage 4: Sync Organization Issue Field (`pr-flow-status`)

Ensure the `pr-flow-status` Single-Select Issue Field exists in the `<owner>` organization (`fields sync` checks existence via repo-scoped GraphQL first and only calls the org-admin creation API if missing):

```bash
GITHUB_TOKEN=$(gh auth token) npx --yes github:<prFlowOwner>/pr-flow#<prFlowRef> fields sync --repo <owner>/<repo>
```

- **If it succeeds:** Report that `pr-flow-status` is ready in `<owner>` and proceed to Stage 5.
- **If it fails with `403 Resource not accessible by integration` (or similar permission error):**
  - Do **not** abort the wizard. Explain that `pr-flow-status` does not exist yet in `<owner>` and the current environment's GitHub token (such as a VM GitHub App / integration token) does not have **organization-admin** permissions required to create a new org-level Issue Field.
  - Present both remediation options clearly and **wait for the user's response**:
    1. **Option A — Run locally with your org-admin `gh` CLI:**
       ```bash
       GITHUB_TOKEN=$(gh auth token) npx --yes github:<prFlowOwner>/pr-flow#<prFlowRef> fields sync --repo <owner>/<repo>
       ```
    2. **Option B — Create in GitHub Web UI:**
       - Open `https://github.com/organizations/<owner>/settings/issue-fields`
       - Create a **Single select** field named `pr-flow-status` with these exact 7 options:
         `backlog`, `blocked-dep`, `ready`, `in-progress`, `review-pending`, `fixed`, `needs-human`
  - Ask the user to reply once `pr-flow-status` is created (or let you know if they want to defer this step).
- **If it fails with `404`:** Explain that Issue Fields are an organization-level GitHub feature and `<owner>` may be a personal account or have Issue Fields disabled. Ask how they would like to proceed.

---

## Stage 5: Configure Repository Actions Secret

Guide the user to configure the AI provider secret (`GEMINI_API_KEY` by default, or their custom provider secret):
- **GitHub Web UI:** `https://github.com/<owner>/<repo>/settings/secrets/actions` → **New repository secret** → `GEMINI_API_KEY`
- **Or via `gh` CLI locally:** `gh secret set GEMINI_API_KEY --repo <owner>/<repo>`

**Wizard prompt:** Ask the user to confirm once the secret is added (or if they plan to add it right after pushing).

---

## Stage 6: Commit, Push & Next Steps

1. Show `git status` and summarize all ready-to-commit files.
2. **Ask the user for confirmation** before committing and pushing to `<baseBranch>`.
3. Once pushed (or if the user prefers to commit manually), present a concise **Setup Complete** checklist (files, labels, `pr-flow-status` field, `GEMINI_API_KEY` secret) and offer next steps:
   - Authoring a `plan-manifest.yml` from a feature idea or design doc (`pr-flow plan validate` / `pr-flow plan materialize`).

