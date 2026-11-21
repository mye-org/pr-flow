import * as fs from 'node:fs';
import * as path from 'node:path';

export type InitOptions = {
  targetDir: string;
  prFlowOwner: string;
  prFlowRef: string;
  baseBranch: string;
  wipLimit: number;
  setupCommand: string;
  verifyCommand: string;
  reviewMode: 'changes_requested' | 'comment' | 'both';
  force: boolean;
}

export type InitResult = {
  readonly written: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
};

function writeIfAllowed(filePath: string, content: string, force: boolean, result: InitResult) {
  if (fs.existsSync(filePath) && !force) {
    return { written: result.written, skipped: [...result.skipped, filePath] };
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return { written: [...result.written, filePath], skipped: result.skipped };
}

export function generateInitFiles(opts: InitOptions) {
  let result: InitResult = { written: [], skipped: [] };
  const usesPrefix = `${opts.prFlowOwner}/pr-flow/.github/workflows`;

  const configContent = `version: 1
wipLimit: ${String(opts.wipLimit)}
baseBranch: ${opts.baseBranch}

workspace:
  setupCommand: ${JSON.stringify(opts.setupCommand)}
  verifyCommand: ${JSON.stringify(opts.verifyCommand)}

agent:
  provider: gemini
  model: gemini-3.8-flash
  fallbackModels:
    - gemini-3-flash-preview
    - gemini-3.5-flash-lite
  maxRetries: 3
  timeoutMinutes: 20
  maxSessionTurns: 25
  compressionThreshold: 0.2

triggers:
  reviewMode: ${opts.reviewMode}
  autoPickup: true
  autoMergeOnApprove: true
  mergeMethod: squash
statusFieldName: pr-flow-status
`;

  const agentsMdContent = `# AGENTS.md

This repository uses **pr-flow** for automated Issue-to-PR delivery.

## Project Commands
- **Setup:** \`${opts.setupCommand || '(none)'}\`
- **Verify:** \`${opts.verifyCommand}\`

## For Interactive Agents (IDE / Chat)
Read and follow [\`.agents/skills/pr-flow/SKILL.md\`](./.agents/skills/pr-flow/SKILL.md) whenever planning features, managing issues, or reviewing PRs:
- **Plan & Decompose:** Author \`plan-manifest.yml\`, validate with \`pr-flow plan validate\`, and materialize with \`pr-flow plan materialize\`.
- **Lifecycle Status:** Issues are tracked via the \`pr-flow-status\` organization Issue Field (\`backlog\`, \`blocked-dep\`, \`ready\`, \`in-progress\`, \`review-pending\`, \`fixed\`, \`needs-human\`).
- **Triage & Review:** Diagnose \`needs-human\` issues and review \`ai/issue-<N>\` PRs via \`gh pr review\`.
- **Never** run \`git push\`, \`gh pr create\`, or open manual branches for AI-managed tasks.

## For CI Execution Agents
- Keep changes minimal, well-tested, and scoped strictly to the assigned GitHub issue.
- Always run \`${opts.verifyCommand}\` before writing \`result.json\`.
- Never run \`git push\`, \`gh\`, or create branches/PRs manually; the \`pr-flow\` control plane handles Git and GitHub mutations.
`;

  const implementWorkflow = `name: pr-flow Implement

on:
  issues:
    types: [field_added, reopened]
  workflow_dispatch:
    inputs:
      issue_number:
        description: 'Issue number to implement'
        required: true
        type: number

concurrency:
  group: fsm-implement-\${{ github.event.issue.number || inputs.issue_number }}
  cancel-in-progress: false

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  implement:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      github.event.action == 'reopened' ||
      github.event.action == 'field_added'
    uses: ${usesPrefix}/reusable-implement.yml@${opts.prFlowRef}
    with:
      issue_number: \${{ github.event_name == 'workflow_dispatch' && fromJSON(inputs.issue_number) || github.event.issue.number }}
    secrets:
      GEMINI_API_KEY: \${{ secrets.GEMINI_API_KEY }}
`;

  const reviewWorkflow = `name: pr-flow Review Follow-up

on:
  pull_request_review:
    types: [submitted]
  workflow_dispatch:
    inputs:
      pr_number:
        description: 'PR number to address review feedback on'
        required: true
        type: number

concurrency:
  group: pr-flow-review-\${{ github.event.pull_request.number || inputs.pr_number }}
  cancel-in-progress: false

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  review:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event.review.state == 'changes_requested' &&
      contains(github.event.pull_request.labels.*.name, 'ai-managed'))
    uses: ${usesPrefix}/reusable-review.yml@${opts.prFlowRef}
    with:
      pr_number: \${{ github.event_name == 'workflow_dispatch' && fromJSON(inputs.pr_number) || github.event.pull_request.number }}
    secrets:
      GEMINI_API_KEY: \${{ secrets.GEMINI_API_KEY }}

  merge:
    if: >-
      github.event_name == 'pull_request_review' &&
      github.event.review.state == 'approved' &&
      contains(github.event.pull_request.labels.*.name, 'ai-managed')
    uses: ${usesPrefix}/reusable-merge.yml@${opts.prFlowRef}
    with:
      pr_number: \${{ github.event.pull_request.number }}
`;

  const syncWorkflow = `name: pr-flow Sync

on:
  issues:
    types: [closed, reopened, labeled, unlabeled]
  pull_request:
    types: [closed]

concurrency:
  group: fsm-sync
  cancel-in-progress: false

permissions:
  contents: read
  issues: write
  pull-requests: read

jobs:
  sync:
    uses: ${usesPrefix}/reusable-sync.yml@${opts.prFlowRef}
    with:
      issue_number: \${{ github.event.issue.number || 0 }}
      pr_number: \${{ github.event.pull_request.number || 0 }}
      pr_merged: \${{ github.event.pull_request.merged || false }}
`;

  const reconcileWorkflow = `name: pr-flow Reconcile

on:
  schedule:
    - cron: '*/30 * * * *'
  workflow_dispatch:

concurrency:
  group: fsm-dispatcher
  cancel-in-progress: false

permissions:
  actions: write
  contents: read
  issues: write
  pull-requests: read

jobs:
  reconcile:
    uses: ${usesPrefix}/reusable-reconcile.yml@${opts.prFlowRef}
`;

  const skillMdContent = `---
name: pr-flow
description: Plan, materialize, and develop features using pr-flow's Agile Issue-to-PR state machine, YAML DAG manifests, and automated CI workflows.
---
# \`pr-flow\` Agent Skill

Use this skill to develop features in any repository governed by \`pr-flow\`.

## Core Architecture & Safety Rules

1. **Deterministic Control Plane vs. AI Execution Plane**:
   - The TypeScript + XState v5 control plane owns all \`pr-flow-status\` Issue Field transitions, dependency checks, WIP limits, branching, and PR creation.
   - The AI coding agent runs in an isolated CI container with **no GitHub write tokens**. It only modifies local code and outputs a structured \`result.json\`.
2. **Cardinal Rule for Interactive Agents**:
   - **Never run \`git push\`, \`gh pr create\`, or make manual branches** for AI-managed tasks.
   - All code generation is requested via issues, executed in CI, and delivered via \`ai/issue-<N>\` PRs opened by \`pr-flow[bot]\`.
   - Your role in the IDE/chat is **Agile Planner, Spec Author, and Review Partner**.

---

## Feature Planning & Spec Decomposition

### 1. Author \`plan-manifest.yml\`
- \`type:epic\`: Top-level strategic container (never executed directly; status rolls up from children).
- \`type:story\`: Container if it has sub-issues; executable leaf if it has **0** sub-issues.
- \`type:task\` / \`type:bug\`: Executable leaf (**1 issue = 1 PR = 1 commit** on \`main\`).
- Use \`blockedBy: [id1, id2]\` to form a Directed Acyclic Graph (DAG) with no cycles or dangling IDs.
- \`pr-flow plan materialize\` automatically appends **Development Standards** (declarative programming style, TypeScript type-driven development, functional programming style) to every created issue description.

\`\`\`yaml
version: 1
epic:
  id: epic-feature
  title: "Epic: Feature Name"
  body: "Overall goal and architecture."

issues:
  - id: story-foundation
    title: "Story: Core Domain Foundation"
    body: "Container story."
    type: story

  - id: task-domain-types
    title: "Implement domain types"
    body: |
      ## Acceptance Criteria
      - Define interfaces and unit tests.
    type: task
    parentId: story-foundation
\`\`\`

### 2. Validate & Materialize
\`\`\`bash
npx --yes github:${opts.prFlowOwner}/pr-flow#${opts.prFlowRef} plan validate --file plan-manifest.yml
GITHUB_TOKEN=$(gh auth token) npx --yes github:${opts.prFlowOwner}/pr-flow#${opts.prFlowRef} plan materialize --file plan-manifest.yml --repo <owner>/<repo>
\`\`\`

---

## Lifecycle, WIP Limits & Rollup

Issues use the \`pr-flow-status\` organization Single-Select Issue Field with values:
\`backlog\`, \`blocked-dep\`, \`ready\`, \`in-progress\`, \`review-pending\`, \`fixed\`, \`needs-human\`.

- **Triggering execution:** Setting \`pr-flow-status\` to \`ready\` on an unblocked leaf task triggers \`pr-flow-implement.yml\` (or run \`gh workflow run pr-flow-implement.yml -f issue_number=<NUMBER>\`).
- **WIP limit:** Only \`in-progress\` issues count toward \`wipLimit\` (default: ${String(opts.wipLimit)}). \`review-pending\` is **uncapped** so code review never blocks new work.
- **Parent rollup precedence:** Container status rolls up automatically from children in strict order:
  1. Any child \`needs-human\` → \`needs-human\`
  2. All children \`fixed\` → \`fixed\` (and closes parent)
  3. Any child \`in-progress\`, \`review-pending\`, or \`fixed\` → \`in-progress\`
  4. Any child \`ready\` → \`ready\`
  5. Any child \`blocked-dep\` → \`blocked-dep\`
  6. Otherwise → \`backlog\`
- **Manual reconciliation:** Run \`GITHUB_TOKEN=$(gh auth token) npx --yes github:${opts.prFlowOwner}/pr-flow#${opts.prFlowRef} reconcile --repo <owner>/<repo>\` to unblock downstream issues, compute rollups, and dispatch ready work immediately.

---

## Triaging \`needs-human\` & Reviewing PRs

1. **Diagnose & re-queue \`needs-human\`**:
   - Inspect comments and failed workflow logs:
     - \`gh issue view <NUMBER> --comments\`
     - \`gh run list --workflow=pr-flow-implement.yml\`
     - \`gh run view <RUN_ID> --log-failed\`
   - Clarify acceptance criteria on the issue, then set \`pr-flow-status\` back to \`ready\`:
     \`\`\`bash
     GITHUB_TOKEN=$(gh auth token) npx --yes github:${opts.prFlowOwner}/pr-flow#${opts.prFlowRef} status set --issue <NUMBER> --status ready --repo <owner>/<repo>
     \`\`\`
2. **Review \`ai/issue-<N>\` PRs**:
   - Inspect diff: \`gh pr diff <PR_NUMBER>\`
   - Request changes (triggers \`pr-flow-review.yml\`): \`gh pr review <PR_NUMBER> --request-changes --body "..."\`
   - Approve & auto-merge: \`gh pr review <PR_NUMBER> --approve --body "LGTM!"\`
`;

  result = writeIfAllowed(path.join(opts.targetDir, 'pr-flow.config.yml'), configContent, opts.force, result);
  result = writeIfAllowed(path.join(opts.targetDir, 'AGENTS.md'), agentsMdContent, opts.force, result);
  result = writeIfAllowed(
    path.join(opts.targetDir, '.agents/skills/pr-flow/SKILL.md'),
    skillMdContent,
    opts.force,
    result,
  );
  result = writeIfAllowed(
    path.join(opts.targetDir, '.github/workflows/pr-flow-implement.yml'),
    implementWorkflow,
    opts.force,
    result,
  );
  result = writeIfAllowed(
    path.join(opts.targetDir, '.github/workflows/pr-flow-review.yml'),
    reviewWorkflow,
    opts.force,
    result,
  );
  result = writeIfAllowed(
    path.join(opts.targetDir, '.github/workflows/pr-flow-sync.yml'),
    syncWorkflow,
    opts.force,
    result,
  );
  result = writeIfAllowed(
    path.join(opts.targetDir, '.github/workflows/pr-flow-reconcile.yml'),
    reconcileWorkflow,
    opts.force,
    result,
  );

  return result;
}
