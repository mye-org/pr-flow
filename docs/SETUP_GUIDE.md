# Setup Guide

## Prerequisites

- Your target repository must belong to a **GitHub Organization** (`pr-flow-status` is an organization-level Single-Select Issue Field).
- Creating `pr-flow-status` (`--create-custom-field` or `pr-flow fields sync`) requires a `GITHUB_TOKEN` with **organization admin** permissions.

## Option A: AI-Driven Interactive Setup Wizard

In your target repository, ask your AI coding assistant:

> *"Use `pr-flow` (`github.com/mye-org/pr-flow`) to set up the GitHub infrastructure."*

The assistant follows [`skills/setup-pr-flow/SKILL.md`](../skills/setup-pr-flow/SKILL.md) to detect repo settings, generate files, sync labels and `pr-flow-status` (falling back to guided manual steps on `403`), configure secrets/permissions, and run `pr-flow doctor`.

## Option B: Manual CLI Bootstrap

1. **Generate files and sync GitHub resources:**
   ```bash
   GITHUB_TOKEN=$(gh auth token) npx --yes github:mye-org/pr-flow#v1 init \
     --base-branch main \
     --wip-limit 4 \
     --setup-command "npm ci" \
     --verify-command "npm test" \
     --sync-labels \
     --create-custom-field \
     --repo <owner>/<repo>
   ```
   *(If `--create-custom-field` returns HTTP `403`, create `pr-flow-status` in `https://github.com/organizations/<owner>/settings/issue-fields` with options `backlog`, `blocked-dep`, `ready`, `in-progress`, `review-pending`, `fixed`, `needs-human`.)*
2. **Add AI provider secret** (`GEMINI_API_KEY` by default):
   ```bash
   gh secret set GEMINI_API_KEY --repo <owner>/<repo>
   ```
3. **Allow GitHub Actions to create/approve PRs:**
   ```bash
   gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow -F can_approve_pull_request_reviews=true
   ```
4. **Verify prerequisites:**
   ```bash
   GITHUB_TOKEN=$(gh auth token) npx --yes github:mye-org/pr-flow#v1 doctor --repo <owner>/<repo>
   ```
5. Review `pr-flow.config.yml` and `AGENTS.md` (see [Configuration & CLI](./CONFIGURATION.md)), then commit and push to `main`.
