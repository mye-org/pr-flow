import * as E from 'fp-ts/lib/Either';
import type { GitHubPort, PrReviewThread } from '../adapters/github/types.js';
import type { AgentResult } from '../domain/issue.js';
import { isoMessage } from '../domain/newtypes.js';

export type ReviewFollowUpResult = {
  readonly repliedCount: number;
  readonly resolvedCount: number;
  readonly warnings: ReadonlyArray<string>;
};

export async function replyAndResolveReviewThreads(params: {
  readonly github: GitHubPort;
  readonly branch: string;
  readonly agentResult: AgentResult;
  readonly threads: ReadonlyArray<PrReviewThread>;
}) {
  const { github, branch, agentResult, threads } = params;
  const replyByThreadId = new Map<string, string>();

  for (const item of agentResult.resolvedComments ?? []) {
    replyByThreadId.set(item.threadId, item.reply);
  }

  let repliedCount = 0;
  let resolvedCount = 0;
  let warnings: ReadonlyArray<string> = [];

  for (const thread of threads) {
    if (thread.isResolved) continue;

    const specificReply = replyByThreadId.get(thread.threadId);
    const replyBody = specificReply
      ? `${specificReply}\n\n_(Fixed on \`${branch}\`)_`
      : `Applied fix on \`${branch}\`: ${agentResult.summary}`;

    const replyRes = await github.replyToReviewThread(thread.threadId, replyBody)();
    if (E.isLeft(replyRes)) {
      const msg =
        'message' in replyRes.left
          ? isoMessage.unwrap(replyRes.left.message)
          : JSON.stringify(replyRes.left);
      warnings = [...warnings, `Failed to reply to review thread ${thread.threadId}: ${msg}`];
      continue;
    }
    repliedCount++;

    const resolveRes = await github.resolveReviewThread(thread.threadId)();
    if (E.isLeft(resolveRes)) {
      const msg =
        'message' in resolveRes.left
          ? isoMessage.unwrap(resolveRes.left.message)
          : JSON.stringify(resolveRes.left);
      warnings = [...warnings, `Failed to resolve review thread ${thread.threadId}: ${msg}`];
      continue;
    }
    resolvedCount++;
  }

  return { repliedCount, resolvedCount, warnings };
}
