# Setup Guide

## Option A: AI-Driven Setup

In your target repository, ask your AI coding assistant:

> *"Use `pr-flow` (`github.com/mingqianye/pr-flow`) to set up the GitHub infrastructure."*

The AI assistant will follow [`skills/setup-pr-flow/SKILL.md`](../skills/setup-pr-flow/SKILL.md).

## Option B: CLI Bootstrap

1. Run `pr-flow init`:
   ```bash
   npx --yes github:mingqianye/pr-flow#v1 init \
     --owner mingqianye \
     --ref v1 \
     --base-branch main \
     --wip-limit 4 \
     --setup-command "npm ci" \
     --verify-command "npm test" \
     --sync-labels \
     --repo <owner>/<repo>
   ```
2. Review the generated files:
   - `pr-flow.config.yml`
   - `AGENTS.md`
   - `.github/workflows/pr-flow-implement.yml`
   - `.github/workflows/pr-flow-review.yml`
   - `.github/workflows/pr-flow-sync.yml`
   - `.github/workflows/pr-flow-reconcile.yml`
3. Add `GEMINI_API_KEY` in **Repository Settings → Secrets and variables → Actions**.
4. Commit and push to `main`.
