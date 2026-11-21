# `pr-flow`

> A **public, self-contained, project-agnostic** GitHub workflow engine and Agile Issue-to-PR state machine.

`pr-flow` separates the **deterministic Control Plane** (TypeScript + XState v5 + `fp-ts` + `ts-pattern`) from the **AI Execution Plane** (headless Gemini CLI or custom coding agent). In any target repository, an AI agent can simply follow [`skills/setup-pr-flow/SKILL.md`](./skills/setup-pr-flow/SKILL.md) or run `pr-flow init` to bootstrap the full Issue-to-PR automation pipeline.

## Core Principles

1. **Control Plane vs. Execution Plane Separation:** Deterministic TypeScript owns all issue status transitions, dependency guards, WIP limits, and PR creation. The AI coding agent has **zero `issues: write` permission** and only writes code + a structured `result.json`.
2. **Project-Agnostic:** `pr-flow` makes zero assumptions about your language, package manager, test runner, or AI CLI. Configure those declaratively in `pr-flow.config.yml` and `AGENTS.md`.
3. **Declarative & Type-Safe:** Domain states, events, guard failures, and side effects are modeled as Algebraic Data Types, processed via XState v5, composed with `fp-ts` (`Either` / `TaskEither`), and exhaustively matched with `ts-pattern`.
4. **Human Sovereignty:** Humans can freely edit labels, priorities, and dependencies at any time. Deterministic safety guards run right before automated AI pickup.

## Quick Start

> **Prerequisite:** Your target repository must be in a **GitHub Organization** (Issue Fields are an org-level feature, and `--create-custom-field` requires org-admin permissions).

1. In your target repository, run:
   ```bash
   GITHUB_TOKEN=$(gh auth token) npx --yes github:mye-org/pr-flow#v1 init \
     --setup-command "npm ci" \
     --verify-command "npm test" \
     --sync-labels \
     --create-custom-field \
     --repo <owner>/<repo>
   ```
2. Add `GEMINI_API_KEY` to your repository's GitHub Actions secrets.
3. Set the `pr-flow-status` Issue Field on an executable leaf issue (`type:task`, `type:bug`, or leaf `type:story`) to `ready` to trigger automated implementation.

## Documentation

- [Methodology](./docs/METHODOLOGY.md) — Agile hierarchy, leaf execution, WIP limits, and lazy branching
- [State Machine](./docs/STATE_MACHINE.md) — XState v5 lifecycle, guards, and effect interpreter
- [Design to Issues](./docs/DESIGN_TO_ISSUES.md) — Converting design docs into `plan-manifest.yml` and GitHub sub-issue DAGs
- [Setup Guide](./docs/SETUP_GUIDE.md) — Manual and AI-driven bootstrapping instructions
- [AI Setup Skill](./skills/setup-pr-flow/SKILL.md) — Executable playbook for AI coding assistants

## Development

```bash
npm install
npm run verify
```
