import type { IssueNode } from '../../domain/issue.js';

function formatAgentsSection(agentsMd?: string): string {
  return agentsMd ? `\n## Repository Instructions (AGENTS.md)\n${agentsMd.trim()}\n` : '';
}

function formatRepoFilesSection(repoFiles?: readonly string[]): string {
  if (!repoFiles || repoFiles.length === 0) return '';
  return `\n## Repository File Tree\n\`\`\`\n${repoFiles.join('\n')}\n\`\`\`\n`;
}

export function buildImplementPrompt(params: {
  issue: IssueNode;
  verifyCommand: string;
  agentsMd?: string;
  resultFilePath: string;
  repoFiles?: readonly string[];
}): string {
  const agentsSection = formatAgentsSection(params.agentsMd);
  const repoFilesSection = formatRepoFilesSection(params.repoFiles);

  return `You are an autonomous software engineer implementing a GitHub issue.
${agentsSection}
## Strict Execution Rules
1. Implement the requested changes cleanly in the current working tree.
2. Do NOT run \`git push\`, \`gh\`, or modify git branches. The CI control plane handles branching and PR creation.
3. Minimize exploratory tool calls: use the provided Repository File Tree to open only the relevant files directly.
4. While iterating, run targeted tests if needed; run the full verification command once before finishing:
   \`${params.verifyCommand}\`
5. Write a structured JSON file to \`${params.resultFilePath}\` (or output it as your final JSON response) matching this exact schema:
   - On success:
     \`{"status":"success","summary":"<concise summary of changes>","testsRun":true,"filesChanged":["..."]}\`
   - If requirements are ambiguous, blocked, or impossible without human input:
     \`{"status":"needs_human","summary":"<what was attempted>","reason":"<specific question or blocker for human>","testsRun":false}\`
   - If verification failed and cannot be fixed:
     \`{"status":"failed","summary":"<what failed>","reason":"<error details>","testsRun":true}\`
${repoFilesSection}
## Issue Details
- **Number:** #${params.issue.number}
- **Title:** ${params.issue.title}
- **Type:** ${params.issue.type}

### Description
${params.issue.body || '(No description provided)'}
`;
}

export function buildReviewPrompt(params: {
  issue: IssueNode;
  prNumber: number;
  reviewComments: readonly string[];
  verifyCommand: string;
  agentsMd?: string;
  resultFilePath: string;
  changedFiles?: readonly string[];
  prDiff?: string;
}): string {
  const agentsSection = formatAgentsSection(params.agentsMd);

  const commentsBlock =
    params.reviewComments.length > 0
      ? params.reviewComments.join('\n\n')
      : '(No unresolved review comments found; inspect recent PR feedback.)';

  const changedFilesSection =
    params.changedFiles && params.changedFiles.length > 0
      ? `\n## Changed Files on PR #${params.prNumber}\n\`\`\`\n${params.changedFiles.join('\n')}\n\`\`\`\n`
      : '';

  const diffSection =
    params.prDiff && params.prDiff.trim().length > 0
      ? `\n## Current PR Diff\n\`\`\`diff\n${params.prDiff.trim()}\n\`\`\`\n`
      : '';

  const issueBodySection =
    params.issue.body && params.issue.body.trim().length > 0
      ? `\n### Original Issue Description\n${params.issue.body.trim()}\n`
      : '';

  return `You are addressing code review feedback on a pull request.
${agentsSection}
## Strict Execution Rules
1. Address all requested review changes cleanly in the current working tree.
2. Do NOT run \`git push\`, \`gh\`, or create new branches/PRs.
3. Minimize exploratory tool calls: use the provided Changed Files and Current PR Diff directly.
4. While iterating, run targeted tests if needed; run the full verification command once before finishing:
   \`${params.verifyCommand}\`
5. Write a structured JSON file to \`${params.resultFilePath}\` (or output it as your final JSON response):
   \`{"status":"success","summary":"<summary of review fixes>","testsRun":true,"filesChanged":["..."]}\`
   (or \`"needs_human"\` / \`"failed"\` with \`"reason"\` if blocked).

## Issue: #${params.issue.number} — ${params.issue.title}
## PR: #${params.prNumber}
${issueBodySection}${changedFilesSection}${diffSection}
## Review Feedback to Address
${commentsBlock}
`;
}
