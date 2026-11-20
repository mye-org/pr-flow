import * as E from 'fp-ts/Either';
import type { DomainError } from '../domain/errors.js';
import type { PlanManifest } from '../domain/plan.js';

export function validatePlanDag(manifest: PlanManifest): E.Either<DomainError, PlanManifest> {
  const errors: string[] = [];
  const allIds = new Set<string>();

  if (manifest.epic) {
    allIds.add(manifest.epic.id);
  }

  for (const issue of manifest.issues) {
    if (allIds.has(issue.id)) {
      errors.push(`Duplicate issue id '${issue.id}'`);
    }
    allIds.add(issue.id);
  }

  // Validate parentId and blockedBy references exist
  for (const issue of manifest.issues) {
    if (issue.parentId && !allIds.has(issue.parentId)) {
      errors.push(`Issue '${issue.id}' references unknown parentId '${issue.parentId}'`);
    }
    for (const dep of issue.blockedBy) {
      if (!allIds.has(dep)) {
        errors.push(`Issue '${issue.id}' references unknown blockedBy id '${dep}'`);
      }
      if (dep === issue.id) {
        errors.push(`Issue '${issue.id}' cannot be blocked by itself`);
      }
    }
  }

  if (errors.length > 0) {
    return E.left({
      type: 'PLAN_VALIDATION_ERROR',
      message: 'Plan manifest reference validation failed',
      details: errors,
    });
  }

  // Cycle detection on blockedBy + parentId edges using DFS 3-color marking
  const adj = new Map<string, string[]>();
  for (const id of allIds) {
    adj.set(id, []);
  }
  for (const issue of manifest.issues) {
    for (const dep of issue.blockedBy) {
      adj.get(dep)?.push(issue.id);
    }
  }

  const color = new Map<string, 'white' | 'gray' | 'black'>();
  for (const id of allIds) {
    color.set(id, 'white');
  }

  function hasCycle(nodeId: string, path: string[]): string[] | null {
    color.set(nodeId, 'gray');
    const neighbors = adj.get(nodeId) ?? [];
    for (const next of neighbors) {
      const c = color.get(next);
      if (c === 'gray') {
        return [...path, next];
      }
      if (c === 'white') {
        const cycle = hasCycle(next, [...path, next]);
        if (cycle) return cycle;
      }
    }
    color.set(nodeId, 'black');
    return null;
  }

  for (const id of allIds) {
    if (color.get(id) === 'white') {
      const cycle = hasCycle(id, [id]);
      if (cycle) {
        return E.left({
          type: 'PLAN_VALIDATION_ERROR',
          message: `Dependency cycle detected: ${cycle.join(' -> ')}`,
          details: [cycle.join(' -> ')],
        });
      }
    }
  }

  return E.right(manifest);
}
