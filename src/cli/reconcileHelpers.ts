import * as E from 'fp-ts/lib/Either';
import type { GitHubEffectsPort, GitHubRollupPort, ManagedPrSummary } from '../adapters/github/types.js';
import type { DomainError } from '../domain/errors.js';
import type { IssueNode } from '../domain/issue.js';
import { isoIssueNumber } from '../domain/newtypes.js';
import { executeEffects } from '../interpreter/executeEffects.js';
import { computeRollupEffects } from '../rollup/computeRollup.js';

export function parseIssueNumberFromBranch(headRef: string) {
  const m = /^ai\/issue-(\d+)$/.exec(headRef);
  return m ? Number(m[1]) : null;
}

export function shouldRetryReviewPr(params: {
  readonly pr: ManagedPrSummary;
  readonly linkedIssue: IssueNode | undefined;
  readonly nowMs: number;
  readonly cooldownMs: number;
}) {
  const { pr, linkedIssue, nowMs, cooldownMs } = params;
  if (pr.latestReviewState !== 'CHANGES_REQUESTED' || pr.number <= 0 || pr.issueNumber <= 0) {
    return false;
  }
  if (!linkedIssue || linkedIssue.state !== 'open' || linkedIssue.status !== 'review_pending') {
    return false;
  }

  // If the bot already posted a review-fix comment at or after the latest CHANGES_REQUESTED review, do not re-dispatch.
  if (pr.lastFixCommentAt && pr.latestReviewSubmittedAt) {
    const fixMs = Date.parse(pr.lastFixCommentAt);
    const reviewMs = Date.parse(pr.latestReviewSubmittedAt);
    if (!Number.isNaN(fixMs) && !Number.isNaN(reviewMs) && fixMs >= reviewMs) {
      return false;
    }
  } else if (pr.lastFixCommentAt && !pr.latestReviewSubmittedAt) {
    return false;
  }

  const ageMs = nowMs - Date.parse(pr.updatedAt);
  if (!Number.isNaN(ageMs) && ageMs < cooldownMs) return false;

  return true;
}

export type RollupSyncResult = {
  readonly rolledUp: number;
  readonly containerNumbers: ReadonlySet<number>;
  readonly byNumber: ReadonlyMap<number, IssueNode>;
};

/**
 * Fetches sub-issues for all epic/story candidates and converges container rollups
 * bottom-up (fixed-point passes) so multi-level hierarchies (Epic -> Story -> Task)
 * converge within a single sync/reconcile invocation.
 */
export async function recomputeContainerRollups(
  initialByNumber: ReadonlyMap<number, IssueNode>,
  github: GitHubEffectsPort & GitHubRollupPort,
) {
  let byNumber: ReadonlyMap<number, IssueNode> = new Map(initialByNumber);
  const candidates = Array.from(byNumber.values()).filter(
    (issue) => issue.type === 'epic' || issue.type === 'story',
  );

  const subIssuesByParent = new Map<number, ReadonlyArray<number>>();
  const containerNumbers = new Set<number>();

  for (const candidate of candidates) {
    const num = isoIssueNumber.unwrap(candidate.number);
    const res = await github.listSubIssues(num)();
    if (E.isLeft(res)) {
      return res;
    }
    if (res.right.length > 0) {
      subIssuesByParent.set(num, res.right);
      containerNumbers.add(num);
    }
  }

  // Sort stories before epics so common 3-level hierarchies converge on pass 1
  const orderedParents = Array.from(subIssuesByParent.keys()).sort((a, b) => {
    const aType = byNumber.get(a)?.type === 'epic' ? 1 : 0;
    const bType = byNumber.get(b)?.type === 'epic' ? 1 : 0;
    return aType - bType;
  });

  let rolledUp = 0;
  const maxPasses = Math.max(1, orderedParents.length);

  for (let pass = 0; pass < maxPasses; pass++) {
    let anyChanged = false;

    for (const parentNum of orderedParents) {
      const parent = byNumber.get(parentNum);
      if (!parent) continue;
      const subNums = subIssuesByParent.get(parentNum) ?? [];
      const children = subNums
        .map((n) => byNumber.get(n))
        .filter((n): n is IssueNode => Boolean(n));
      if (children.length === 0) continue;

      const { targetStatus, effects } = computeRollupEffects(parent, children);
      if (effects.length === 0) continue;

      const execRes = await executeEffects(effects, github)();
      if (E.isLeft(execRes)) {
        return execRes;
      }

      const nextState = (() => {
        if (targetStatus === 'fixed') return 'closed' as const;
        return parent.state === 'closed' ? ('open' as const) : parent.state;
      })();

      byNumber = new Map(byNumber).set(parentNum, {
        ...parent,
        status: targetStatus,
        state: nextState,
      });
      rolledUp++;
      anyChanged = true;
    }

    if (!anyChanged) break;
  }

  return E.right<DomainError, RollupSyncResult>({ rolledUp, containerNumbers, byNumber });
}
