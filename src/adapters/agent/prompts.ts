import type { IssueNode } from '../../domain/issue.js';
import { isoBody, isoIssueNumber, isoTitle } from '../../domain/newtypes.js';
import type { PrReviewThread } from '../github/types.js';

function formatAgentsSection(agentsMd?: string) {
  return agentsMd ? `\n## Repository Instructions (AGENTS.md)\n${agentsMd.trim()}\n` : '';
}

function formatRepoFilesSection(repoFiles?: ReadonlyArray<string>) {
  if (!repoFiles || repoFiles.length === 0) return '';
  return `\n## Repository File Tree\n\`\`\`\n${repoFiles.join('\n')}\n\`\`\`\n`;
}

export function buildImplementPrompt(params: {
  readonly issue: IssueNode;
  readonly verifyCommand: string;
  readonly agentsMd?: string;
  readonly resultFilePath: string;
  readonly repoFiles?: ReadonlyArray<string>;
}) {
  const agentsSection = formatAgentsSection(params.agentsMd);
  const repoFilesSection = formatRepoFilesSection(params.repoFiles);
  const issueBody = isoBody.unwrap(params.issue.body);

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
- **Number:** #${String(isoIssueNumber.unwrap(params.issue.number))}
- **Title:** ${isoTitle.unwrap(params.issue.title)}
- **Type:** ${params.issue.type}

### Description
${issueBody.length > 0 ? issueBody : '(No description provided)'}
`;
}

export function buildReviewPrompt(params: {
  readonly issue: IssueNode;
  readonly prNumber: number;
  readonly reviewComments: ReadonlyArray<string>;
  readonly reviewThreads?: ReadonlyArray<PrReviewThread>;
  readonly verifyCommand: string;
  readonly agentsMd?: string;
  readonly resultFilePath: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly prDiff?: string;
}) {
  const agentsSection = formatAgentsSection(params.agentsMd);
  const threads = params.reviewThreads ?? [];
  const threadsBlock =
    threads.length > 0
      ? threads
          .map((t) => {
            const loc = t.line !== null ? `${t.path}:${String(t.line)}` : t.path;
            const msgs = t.comments
              .map((c) => `  - **${c.author}**: ${c.body}`)
              .join('\n');
            return `- **Thread ID:** \`${t.threadId}\` | **Location:** \`${loc}\`\n${msgs}`;
          })
          .join('\n\n')
      : '';

  const generalBlock =
    params.reviewComments.length > 0 ? params.reviewComments.join('\n\n') : '';

  const feedbackSections: ReadonlyArray<string> = [
    ...(threadsBlock ? [`### Unresolved Inline Review Threads\n${threadsBlock}`] : []),
    ...(generalBlock ? [`### General PR & Review Comments\n${generalBlock}`] : []),
  ];
  const commentsBlock =
    feedbackSections.length > 0
      ? feedbackSections.join('\n\n')
      : '(No unresolved review comments found; inspect recent PR feedback.)';

  const resolvedCommentsInstruction =
    threads.length > 0
      ? `\n   - Include \`"resolvedComments"\` with one entry per addressed inline review thread using its exact \`threadId\` and a concise \`reply\` explaining what was fixed:\n     \`{"status":"success","summary":"<summary of review fixes>","testsRun":true,"filesChanged":["..."],"resolvedComments":[{"threadId":"<Thread ID>","reply":"<what was fixed>"}]}\``
      : `\n   \`{"status":"success","summary":"<summary of review fixes>","testsRun":true,"filesChanged":["..."]}\``;

  const changedFilesSection =
    params.changedFiles && params.changedFiles.length > 0
      ? `\n## Changed Files on PR #${String(params.prNumber)}\n\`\`\`\n${params.changedFiles.join('\n')}\n\`\`\`\n`
      : '';

  const diffSection =
    params.prDiff && params.prDiff.trim().length > 0
      ? `\n## Current PR Diff\n\`\`\`diff\n${params.prDiff.trim()}\n\`\`\`\n`
      : '';

  const rawBody = isoBody.unwrap(params.issue.body);
  const issueBodySection =
    rawBody.trim().length > 0
      ? `\n### Original Issue Description\n${rawBody.trim()}\n`
      : '';

  return `You are addressing code review feedback on a pull request.
${agentsSection}
## Strict Execution Rules
1. Address all requested review changes cleanly in the current working tree.
2. Do NOT run \`git push\`, \`gh\`, or create new branches/PRs.
3. Minimize exploratory tool calls: use the provided Changed Files and Current PR Diff directly.
4. While iterating, run targeted tests if needed; run the full verification command once before finishing:
   \`${params.verifyCommand}\`
5. Write a structured JSON file to \`${params.resultFilePath}\` (or output it as your final JSON response):${resolvedCommentsInstruction}
   (or \`"needs_human"\` / \`"failed"\` with \`"reason"\` if blocked).

## Issue: #${String(isoIssueNumber.unwrap(params.issue.number))} — ${isoTitle.unwrap(params.issue.title)}
## PR: #${String(params.prNumber)}
${issueBodySection}${changedFilesSection}${diffSection}
## Review Feedback to Address
${commentsBlock}
`;
}
