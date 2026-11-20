---
name: setup-pr-flow
description: Bootstrap any target repository with pr-flow GitHub Issue-to-PR automation, labels, config, AGENTS.md, and reusable workflows.
---

# `setup-pr-flow` Playbook

Use this playbook when the user asks to *"Use `pr-flow` to set up the GitHub infrastructure"* in a target repository.

## Step 1: Inspect the Target Repository

Determine the target repository's:
1. **Default branch** (e.g., `main` or `master`).
2. **Setup command** (e.g., `npm ci`, `pnpm install --frozen-lockfile`, `pip install -e .[dev]`, `go mod download`, `cargo fetch`).
3. **Verify command** (e.g., `npm run verify`, `pytest`, `go test ./...`, `cargo test`).
4. **GitHub slug** (`<owner>/<repo>` from `git remote get-url origin`).

## Step 2: Run `pr-flow init`

Run the bundled CLI (or via `npx github:mingqianye/pr-flow#v1`):

```bash
npx --yes github:mingqianye/pr-flow#v1 init \
  --owner mingqianye \
  --ref v1 \
  --base-branch main \
  --wip-limit 4 \
  --setup-command "<SETUP_COMMAND>" \
  --verify-command "<VERIFY_COMMAND>"
```

This generates:
- `pr-flow.config.yml`
- `AGENTS.md`
- `.github/workflows/pr-flow-implement.yml`
- `.github/workflows/pr-flow-review.yml`
- `.github/workflows/pr-flow-sync.yml`
- `.github/workflows/pr-flow-reconcile.yml`

## Step 3: Customize `AGENTS.md`

Update `AGENTS.md` with any repository-specific architectural conventions, directory layouts, or testing rules that the AI coding agent should follow during automated issue execution.

## Step 4: Sync GitHub Labels

Ensure all `status:*`, `type:*`, `priority:*`, and `ai-managed` labels exist in the target repository:

```bash
GITHUB_TOKEN=$(gh auth token) npx --yes github:mingqianye/pr-flow#v1 labels sync --repo <owner>/<repo>
```

## Step 5: Verify & Remind About Secrets

1. Commit and push the generated files to the target repository's default branch.
2. Remind the user to add `GEMINI_API_KEY` (or their custom agent secret) under **Settings → Secrets and variables → Actions** in GitHub.
3. Optionally, if the user has a design document, convert it into `plan-manifest.yml` (see `templates/plan-manifest.example.yml`) and run `pr-flow plan materialize --file plan-manifest.yml`.
