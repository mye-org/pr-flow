import type { IssueNode } from '../../domain/issue.js';

export function buildImplementPrompt(params: {
  issue: IssueNode;
  verifyCommand: string;
  agentsMd?: string;
  resultFilePath: string;
}): string {
  const agentsSection = params.agentsMd
    ? `\n## Repository Instructions (AGENTS.md)\n${params.agentsMd}\n`
    : '';

  return `You are an autonomous software engineer implementing GitHub Issue #${params.issue.number}.

## Issue Details
- **Number:** #${params.issue.number}
- **Title:** ${params.issue.title}
- **Type:** ${params.issue.type}

### Description
${params.issue.body || '(No description provided)'}
${agentsSection}
## Strict Execution Rules
1. Implement the requested changes cleanly in the current working tree.
2. Do NOT run \`git push\`, \`gh\`, or modify git branches. The CI control plane handles branching and PR creation.
3. Run the verification command before finishing:
   \`${params.verifyCommand}\`
4. Write a structured JSON file to \`${params.resultFilePath}\` matching this exact schema:
   - On success:
     \`{"status":"success","summary":"<concise summary of changes>","testsRun":true,"filesChanged":["..."]}\`
   - If requirements are ambiguous, blocked, or impossible without human input:
     \`{"status":"needs_human","summary":"<what was attempted>","reason":"<specific question or blocker for human>","testsRun":false}\`
   - If verification failed and cannot be fixed:
     \`{"status":"failed","summary":"<what failed>","reason":"<error details>","testsRun":true}\`
`;
}

export function buildReviewPrompt(params: {
  issue: IssueNode;
  prNumber: number;
  reviewComments: readonly string[];
  verifyCommand: string;
  agentsMd?: string;
  resultFilePath: string;
}): string {
  const agentsSection = params.agentsMd
    ? `\n## Repository Instructions (AGENTS.md)\n${params.agentsMd}\n`
    : '';

  const commentsBlock =
    params.reviewComments.length > 0
      ? params.reviewComments.join('\n\n')
      : '(No review comments found; inspect recent PR feedback.)';

  return `You are addressing code review feedback on PR #${params.prNumber} for Issue #${params.issue.number}.

## Issue: #${params.issue.number} — ${params.issue.title}
${agentsSection}
## Review Feedback to Address
${commentsBlock}

## Strict Execution Rules
1. Address all requested review changes cleanly in the current working tree.
2. Do NOT run \`git push\`, \`gh\`, or create new branches/PRs.
3. Run the verification command before finishing:
   \`${params.verifyCommand}\`
4. Write a structured JSON file to \`${params.resultFilePath}\`:
   \`{"status":"success","summary":"<summary of review fixes>","testsRun":true,"filesChanged":["..."]}\`
   (or \`"needs_human"\` / \`"failed"\` with \`"reason"\` if blocked).
`;
}
