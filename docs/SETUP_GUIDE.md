# Setup Guide

## Prerequisites

- Your target repository must belong to a **GitHub Organization** (GitHub Issue Fields such as `pr-flow-status` are an organization-level feature).
- Creating the `pr-flow-status` field (`--create-custom-field` or `pr-flow fields sync`) requires a `GITHUB_TOKEN` with **organization admin** permissions.

## Option A: AI-Driven Interactive Setup Wizard

In your target repository, ask your AI coding assistant:

> *"Use `pr-flow` (`github.com/mingqianye/pr-flow`) to set up the GitHub infrastructure."*

The AI assistant will follow [`skills/setup-pr-flow/SKILL.md`](../skills/setup-pr-flow/SKILL.md) as an **interactive setup wizard**:
- Confirms detected repository settings (`baseBranch`, `setupCommand`, `verifyCommand`, `wipLimit`, `reviewMode`) before generating files.
- Guides you through customizing `AGENTS.md` and syncing labels.
- If the agent's token lacks org-admin permissions for `pr-flow-status` (`403 Resource not accessible by integration`), pauses and walks you through creating the field via local `gh` CLI or GitHub Organization Settings.
- Guides you through adding `GEMINI_API_KEY` and committing/pushing the generated files.

## Option B: CLI Bootstrap

1. Run `pr-flow init`:
   ```bash
   GITHUB_TOKEN=$(gh auth token) npx --yes github:mingqianye/pr-flow#v1 init \
     --owner mingqianye \
     --ref v1 \
     --base-branch main \
     --wip-limit 4 \
     --setup-command "npm ci" \
     --verify-command "npm test" \
     --sync-labels \
     --create-custom-field \
     --repo <owner>/<repo>
   ```
2. Review the generated files:
   - `pr-flow.config.yml`
   - `AGENTS.md`
   - `.agents/skills/pr-flow/SKILL.md`
   - `.github/workflows/pr-flow-implement.yml`
   - `.github/workflows/pr-flow-review.yml`
   - `.github/workflows/pr-flow-sync.yml`
   - `.github/workflows/pr-flow-reconcile.yml`
3. Add `GEMINI_API_KEY` in **Repository Settings → Secrets and variables → Actions**.
4. Commit and push to `main`.
