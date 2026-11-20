import * as fs from 'node:fs';
import * as path from 'node:path';

export interface InitOptions {
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

export interface InitResult {
  written: string[];
  skipped: string[];
}

function writeIfAllowed(filePath: string, content: string, force: boolean, result: InitResult): void {
  if (fs.existsSync(filePath) && !force) {
    result.skipped.push(filePath);
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  result.written.push(filePath);
}

export function generateInitFiles(opts: InitOptions): InitResult {
  const result: InitResult = { written: [], skipped: [] };
  const usesPrefix = `${opts.prFlowOwner}/pr-flow/.github/workflows`;

  const configContent = `version: 1
wipLimit: ${opts.wipLimit}
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

triggers:
  reviewMode: ${opts.reviewMode}
  autoPickup: true
`;

  const agentsMdContent = `# AGENTS.md

This repository uses **pr-flow** for automated Issue-to-PR delivery.

## Project Commands
- **Setup:** \`${opts.setupCommand || '(none)'}\`
- **Verify:** \`${opts.verifyCommand}\`

## Conventions
- Keep changes minimal, well-tested, and scoped strictly to the assigned GitHub issue.
- Always run \`${opts.verifyCommand}\` before writing \`result.json\`.
- Never run \`git push\`, \`gh\`, or create branches/PRs manually; the \`pr-flow\` control plane handles Git and GitHub mutations.
`;

  const implementWorkflow = `name: pr-flow Implement

on:
  issues:
    types: [labeled, reopened]
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
      github.event.label.name == 'status:ready'
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

  writeIfAllowed(path.join(opts.targetDir, 'pr-flow.config.yml'), configContent, opts.force, result);
  writeIfAllowed(path.join(opts.targetDir, 'AGENTS.md'), agentsMdContent, opts.force, result);
  writeIfAllowed(
    path.join(opts.targetDir, '.github/workflows/pr-flow-implement.yml'),
    implementWorkflow,
    opts.force,
    result,
  );
  writeIfAllowed(
    path.join(opts.targetDir, '.github/workflows/pr-flow-review.yml'),
    reviewWorkflow,
    opts.force,
    result,
  );
  writeIfAllowed(
    path.join(opts.targetDir, '.github/workflows/pr-flow-sync.yml'),
    syncWorkflow,
    opts.force,
    result,
  );
  writeIfAllowed(
    path.join(opts.targetDir, '.github/workflows/pr-flow-reconcile.yml'),
    reconcileWorkflow,
    opts.force,
    result,
  );

  return result;
}
