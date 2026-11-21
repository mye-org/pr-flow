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

## Repository Conventions
- Add repository-specific architecture notes, lint rules, or testing constraints here.

> Interactive IDE/chat agents: follow [\`.agents/skills/pr-flow/SKILL.md\`](./.agents/skills/pr-flow/SKILL.md) for planning, triage, and PR review.
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

  const includeIssueComments = opts.reviewMode === 'comment' || opts.reviewMode === 'both';
  const reviewTriggerBlock = includeIssueComments
    ? `on:
  pull_request_review:
    types: [submitted]
  issue_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      pr_number:
        description: 'PR number to address review feedback on'
        required: true
        type: number`
    : `on:
  pull_request_review:
    types: [submitted]
  workflow_dispatch:
    inputs:
      pr_number:
        description: 'PR number to address review feedback on'
        required: true
        type: number`;

  const reviewJobCondition = (() => {
    if (opts.reviewMode === 'changes_requested') {
      return `      github.event_name == 'workflow_dispatch' ||
      (github.event.review.state == 'changes_requested' &&
      contains(github.event.pull_request.labels.*.name, 'ai-managed'))`;
    }
    if (opts.reviewMode === 'comment') {
      return `      github.event_name == 'workflow_dispatch' ||
      (github.event_name == 'pull_request_review' &&
      github.event.review.state == 'commented' &&
      github.event.review.user.type != 'Bot' &&
      contains(github.event.pull_request.labels.*.name, 'ai-managed')) ||
      (github.event_name == 'issue_comment' &&
      github.event.issue.pull_request &&
      github.event.comment.user.type != 'Bot' &&
      contains(github.event.issue.labels.*.name, 'ai-managed'))`;
    }
    return `      github.event_name == 'workflow_dispatch' ||
      (github.event_name == 'pull_request_review' &&
      (github.event.review.state == 'changes_requested' ||
      (github.event.review.state == 'commented' && github.event.review.user.type != 'Bot')) &&
      contains(github.event.pull_request.labels.*.name, 'ai-managed')) ||
      (github.event_name == 'issue_comment' &&
      github.event.issue.pull_request &&
      github.event.comment.user.type != 'Bot' &&
      contains(github.event.issue.labels.*.name, 'ai-managed'))`;
  })();

  const reviewPrExpr = includeIssueComments
    ? `\${{ github.event_name == 'workflow_dispatch' && fromJSON(inputs.pr_number) || github.event.pull_request.number || github.event.issue.number }}`
    : `\${{ github.event_name == 'workflow_dispatch' && fromJSON(inputs.pr_number) || github.event.pull_request.number }}`;

  const reviewConcurrencyExpr = includeIssueComments
    ? `pr-flow-review-\${{ github.event.pull_request.number || github.event.issue.number || inputs.pr_number }}`
    : `pr-flow-review-\${{ github.event.pull_request.number || inputs.pr_number }}`;

  const reviewWorkflow = `name: pr-flow Review Follow-up

${reviewTriggerBlock}

concurrency:
  group: ${reviewConcurrencyExpr}
  cancel-in-progress: false

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  review:
    if: >-
${reviewJobCondition}
    uses: ${usesPrefix}/reusable-review.yml@${opts.prFlowRef}
    with:
      pr_number: ${reviewPrExpr}
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
    types: [closed, reopened, field_added, field_removed]
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

  const reviewTriggerInstruction = (() => {
    if (opts.reviewMode === 'comment') {
      return `   - Request fixes (triggers \`pr-flow-review.yml\` via \`reviewMode: comment\`): \`gh pr comment <PR_NUMBER> --body "..."\` (or submit a review comment via \`gh pr review <PR_NUMBER> --comment --body "..."\`)`;
    }
    if (opts.reviewMode === 'both') {
      return `   - Request fixes (triggers \`pr-flow-review.yml\` via \`reviewMode: both\`): \`gh pr review <PR_NUMBER> --request-changes --body "..."\` (or \`gh pr comment <PR_NUMBER> --body "..."\`)`;
    }
    return `   - Request changes (triggers \`pr-flow-review.yml\`): \`gh pr review <PR_NUMBER> --request-changes --body "..."\``;
  })();

  const skillMdContent = `---
name: pr-flow
description: Plan, materialize, and develop features using pr-flow's Agile Issue-to-PR state machine, YAML DAG manifests, and automated CI workflows.
---
# \`pr-flow\` Agent Skill

Use this skill to plan features, triage issues, and review PRs in any repository governed by \`pr-flow\`.

## Core Rules

1. **Control Plane vs. Execution Plane**:
   - The deterministic TypeScript + XState v5 control plane owns all \`pr-flow-status\` transitions, dependency guards, WIP limits, branching, and PR creation.
   - CI agents run with zero GitHub write tokens and export \`changes.patch\` + \`result.json\`.
2. **Cardinal Rule for Interactive Agents**:
   - **Never run \`git push\`, \`gh pr create\`, or open manual branches** for AI-managed tasks.
   - Your role in the IDE/chat is **Agile Planner, Spec Author, and Review Partner**.

---

## Feature Planning & Spec Decomposition

### 1. Author \`plan-manifest.yml\`
- \`type:epic\`: Optional top-level container (never executed directly; status rolls up from children).
- \`type:story\`: Container if it has sub-issues; executable leaf if it has **0** sub-issues. Stories without \`parentId\` auto-link to \`epic\` when present.
- \`type:task\` / \`type:bug\`: Executable leaf (**1 issue = 1 PR = 1 commit** on \`${opts.baseBranch}\`).
- Optional fields per issue: \`blockedBy: [id1, ...]\` (must form a DAG) and \`labels: [...]\`.
- \`plan materialize\` appends \`## Development Standards\` unless already present in \`body\`.

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

## Lifecycle & Execution

Issues use the \`pr-flow-status\` organization Single-Select Issue Field:
\`backlog\`, \`blocked-dep\`, \`ready\`, \`in-progress\`, \`review-pending\`, \`fixed\`, \`needs-human\`.

- **Trigger execution:** Setting \`pr-flow-status\` to \`ready\` on an unblocked leaf triggers \`pr-flow-implement.yml\` (or dispatch manually: \`gh workflow run pr-flow-implement.yml -f issue_number=<NUMBER>\`).
- **WIP limit:** Only executable leaf \`in-progress\` issues count toward \`wipLimit\` (configured: ${String(opts.wipLimit)}). \`review-pending\` is **uncapped**.
- **Manual reconciliation:** Run \`GITHUB_TOKEN=$(gh auth token) npx --yes github:${opts.prFlowOwner}/pr-flow#${opts.prFlowRef} reconcile --repo <owner>/<repo>\` to unblock downstream tasks, recompute container rollups, and dispatch ready work immediately.

---

## Triaging \`needs-human\` & Reviewing PRs

1. **Diagnose & re-queue \`needs-human\`**:
   - Inspect comments and failed workflow logs:
     - \`gh issue view <NUMBER> --comments\`
     - \`gh run list --workflow=pr-flow-implement.yml\`
     - \`gh run view <RUN_ID> --log-failed\`
   - Check if CI opened a **\`[WIP]\` draft PR** on \`ai/issue-<NUMBER>\` with partial changes (\`gh pr list --head ai/issue-<NUMBER>\`).
     - If you want a fresh run from \`${opts.baseBranch}\`, **close the \`[WIP]\` draft PR first** (\`claim\` blocks pickup with \`PR_ALREADY_EXISTS\` while any PR for \`ai/issue-<NUMBER>\` is open), clarify the issue body, and re-queue:
       \`\`\`bash
       GITHUB_TOKEN=$(gh auth token) npx --yes github:${opts.prFlowOwner}/pr-flow#${opts.prFlowRef} status set --issue <NUMBER> --status ready --repo <owner>/<repo>
       \`\`\`
2. **Review \`ai/issue-<N>\` PRs**:
   - Inspect diff: \`gh pr diff <PR_NUMBER>\`
${reviewTriggerInstruction}
     - On review follow-up, \`pr-flow\` commits fixes to \`ai/issue-<N>\`, replies to and resolves addressed inline threads, and re-requests reviewers.
   - Approve & merge: \`gh pr review <PR_NUMBER> --approve --body "LGTM!"\` (auto-merges if \`triggers.autoMergeOnApprove: true\` in \`pr-flow.config.yml\`).
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
