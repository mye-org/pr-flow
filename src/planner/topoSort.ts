import type { PlanIssueNode, PlanManifest } from '../domain/plan.js';

/**
 * Topologically sorts plan issues so that:
 * 1. Parent issues are created before their children.
 * 2. Blocking issues are ordered before the issues they block.
 */
export function topoSortPlan(manifest: PlanManifest): PlanIssueNode[] {
  const byId = new Map<string, PlanIssueNode>();
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const issue of manifest.issues) {
    byId.set(issue.id, issue);
    inDegree.set(issue.id, 0);
    adj.set(issue.id, []);
  }

  const addEdge = (from: string, to: string) => {
    if (!byId.has(from) || !byId.has(to) || from === to) return;
    const list = adj.get(from);
    if (list && !list.includes(to)) {
      list.push(to);
      inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
    }
  };

  for (const issue of manifest.issues) {
    if (issue.parentId && byId.has(issue.parentId)) {
      addEdge(issue.parentId, issue.id);
    }
    for (const dep of issue.blockedBy) {
      addEdge(dep, issue.id);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }

  const sorted: PlanIssueNode[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const node = byId.get(current);
    if (node) sorted.push(node);

    for (const next of adj.get(current) ?? []) {
      const nextDeg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, nextDeg);
      if (nextDeg === 0) {
        queue.push(next);
      }
    }
  }

  return sorted;
}
