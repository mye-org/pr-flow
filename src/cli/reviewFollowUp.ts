import * as E from 'fp-ts/Either';
import type { GitHubPort, PrReviewThread } from '../adapters/github/types.js';
import type { AgentResult } from '../domain/issue.js';

export interface ReviewFollowUpResult {
  repliedCount: number;
  resolvedCount: number;
  warnings: string[];
}

export async function replyAndResolveReviewThreads(params: {
  github: GitHubPort;
  branch: string;
  agentResult: AgentResult;
  threads: readonly PrReviewThread[];
}): Promise<ReviewFollowUpResult> {
  const { github, branch, agentResult, threads } = params;
  const replyByThreadId = new Map<string, string>();

  for (const item of agentResult.resolvedComments ?? []) {
    replyByThreadId.set(item.threadId, item.reply);
  }

  let repliedCount = 0;
  let resolvedCount = 0;
  const warnings: string[] = [];

  for (const thread of threads) {
    if (thread.isResolved) continue;

    const specificReply = replyByThreadId.get(thread.threadId);
    const replyBody = specificReply
      ? `${specificReply}\n\n_(Fixed on \`${branch}\`)_`
      : `Applied fix on \`${branch}\`: ${agentResult.summary}`;

    const replyRes = await github.replyToReviewThread(thread.threadId, replyBody)();
    if (E.isLeft(replyRes)) {
      const msg = 'message' in replyRes.left ? replyRes.left.message : JSON.stringify(replyRes.left);
      warnings.push(`Failed to reply to review thread ${thread.threadId}: ${msg}`);
      continue;
    }
    repliedCount++;

    const resolveRes = await github.resolveReviewThread(thread.threadId)();
    if (E.isLeft(resolveRes)) {
      const msg = 'message' in resolveRes.left ? resolveRes.left.message : JSON.stringify(resolveRes.left);
      warnings.push(`Failed to resolve review thread ${thread.threadId}: ${msg}`);
      continue;
    }
    resolvedCount++;
  }

  return { repliedCount, resolvedCount, warnings };
}
