# AGENTS.md

This repository (**pr-flow**) uses **pr-flow** itself for automated Issue-to-PR delivery.

## Project Commands
- **Setup:** `npm ci`
- **Verify:** `npm run verify` (runs `tsc --noEmit`, `tsup` -> `dist/cli.cjs`, and `vitest run`)

## Architecture & Conventions
- **Domain (`src/domain/`):** Algebraic Data Types (discriminated unions) for issues, events, effects, errors, config, and plan manifests.
- **State Machine (`src/machine/`):** Pure XState v5 lifecycle machine (`issueMachine.ts`) and `fp-ts` pickup guards (`guards.ts`).
- **Interpreter (`src/interpreter/`):** Exhaustive `ts-pattern` effect executor (`executeEffects.ts`) returning `fp-ts` `TaskEither`.
- **Important:** `dist/cli.cjs` is committed for `@v1` GitHub Actions callers. Always run `npm run verify` after modifying `src/` so `dist/cli.cjs` is updated and all tests pass.
- Never run `git push`, `gh`, or create branches/PRs manually; the `pr-flow` control plane handles Git and GitHub mutations.
