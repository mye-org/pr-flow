import * as E from 'fp-ts/lib/Either';
import { pipe } from 'fp-ts/lib/function';
import * as O from 'fp-ts/lib/Option';
import * as RA from 'fp-ts/lib/ReadonlyArray';
import { match } from 'ts-pattern';
import type { DomainError } from '../domain/errors.js';
import { isoMessage } from '../domain/newtypes.js';
import type { PlanIssueNode, PlanManifest } from '../domain/plan.js';

type DupAcc = {
  readonly allIds: ReadonlySet<string>;
  readonly errors: ReadonlyArray<string>;
};

const initDupAcc = (epicId: O.Option<string>) =>
  ({
    allIds: pipe(
      epicId,
      O.match(
        () => new Set<string>(),
        (id) => new Set<string>([id]),
      ),
    ),
    errors: [],
  }) satisfies DupAcc;

const collectDuplicateErrors = (
  issues: ReadonlyArray<PlanIssueNode>,
  epicId: O.Option<string>,
) =>
  pipe(
    issues,
    RA.reduce(initDupAcc(epicId), (acc: DupAcc, issue) => ({
      allIds: new Set([...acc.allIds, issue.id]),
      errors: acc.allIds.has(issue.id)
        ? [...acc.errors, `Duplicate issue id '${issue.id}'`]
        : acc.errors,
    })),
  );

const collectRefErrorsForIssue = (
  issue: PlanIssueNode,
  allIds: ReadonlySet<string>,
) => [
  ...(issue.parentId && !allIds.has(issue.parentId)
    ? [`Issue '${issue.id}' references unknown parentId '${issue.parentId}'`]
    : []),
  ...(issue.parentId === issue.id ? [`Issue '${issue.id}' cannot be its own parent`] : []),
  ...pipe(
    issue.blockedBy,
    RA.chain((dep) => [
      ...(!allIds.has(dep) ? [`Issue '${issue.id}' references unknown blockedBy id '${dep}'`] : []),
      ...(dep === issue.id ? [`Issue '${issue.id}' cannot be blocked by itself`] : []),
    ]),
  ),
];

const addEdgeToAdj = (
  adj: ReadonlyMap<string, ReadonlyArray<string>>,
  from: string,
  to: string,
) => new Map(adj).set(from, [...(adj.get(from) ?? []), to]);

const addDepsToAdj = (
  adj: ReadonlyMap<string, ReadonlyArray<string>>,
  issue: PlanIssueNode,
) =>
  pipe(
    issue.parentId ? addEdgeToAdj(adj, issue.parentId, issue.id) : adj,
    (withParent) =>
      pipe(
        issue.blockedBy,
        RA.reduce(withParent, (m, dep) => addEdgeToAdj(m, dep, issue.id)),
      ),
  );

const buildAdjacency = (
  allIds: ReadonlySet<string>,
  issues: ReadonlyArray<PlanIssueNode>,
) =>
  pipe(
    issues,
    RA.reduce(
      new Map<string, ReadonlyArray<string>>(
        pipe(Array.from(allIds), RA.map((id) => [id, []] as const)),
      ),
      addDepsToAdj,
    ),
  );

type DfsResult = {
  readonly visited: ReadonlySet<string>;
  readonly cycle: O.Option<ReadonlyArray<string>>;
};

type DfsNodeFn = (
  nodeId: string,
  path: ReadonlyArray<string>,
  visiting: ReadonlySet<string>,
  visited: ReadonlySet<string>,
  adj: ReadonlyMap<string, ReadonlyArray<string>>,
) => DfsResult;

const dfsNeighbors = (
  neighbors: ReadonlyArray<string>,
  path: ReadonlyArray<string>,
  visiting: ReadonlySet<string>,
  visited: ReadonlySet<string>,
  adj: ReadonlyMap<string, ReadonlyArray<string>>,
) =>
  pipe(
    neighbors,
    RA.reduce({ visited, cycle: O.none }, (acc: DfsResult, next) =>
      pipe(
        acc.cycle,
        O.match(
          () => dfsNode(next, path, visiting, acc.visited, adj),
          () => acc,
        ),
      ),
    ),
  );

const exploreNode = (
  nodeId: string,
  path: ReadonlyArray<string>,
  visiting: ReadonlySet<string>,
  visited: ReadonlySet<string>,
  adj: ReadonlyMap<string, ReadonlyArray<string>>,
) =>
  pipe(
    dfsNeighbors(adj.get(nodeId) ?? [], [...path, nodeId], new Set([...visiting, nodeId]), visited, adj),
    (res) => ({ visited: new Set([...res.visited, nodeId]), cycle: res.cycle }),
  );

const dfsNode: DfsNodeFn = (nodeId, path, visiting, visited, adj) => {
  if (visiting.has(nodeId)) return { visited, cycle: O.some([...path, nodeId]) };
  if (visited.has(nodeId)) return { visited, cycle: O.none };
  return exploreNode(nodeId, path, visiting, visited, adj);
};

const findCycle = (
  allIds: ReadonlySet<string>,
  adj: ReadonlyMap<string, ReadonlyArray<string>>,
) =>
  pipe(
    Array.from(allIds),
    RA.reduce({ visited: new Set<string>(), cycle: O.none }, (acc: DfsResult, id) =>
      O.isSome(acc.cycle) || acc.visited.has(id)
        ? acc
        : dfsNode(id, [], new Set<string>(), acc.visited, adj),
    ),
    (res) => res.cycle,
  );

const checkCycles = (
  manifest: PlanManifest,
  allIds: ReadonlySet<string>,
) =>
  pipe(
    findCycle(allIds, buildAdjacency(allIds, manifest.issues)),
    O.match(
      () => E.right<DomainError, PlanManifest>(manifest),
      (cycle) =>
        E.left<DomainError, PlanManifest>({
          type: 'PLAN_VALIDATION_ERROR',
          message: isoMessage.wrap(`Dependency cycle detected: ${cycle.join(' -> ')}`),
          details: O.some([isoMessage.wrap(cycle.join(' -> '))]),
        }),
    ),
  );

const validateReferences = (
  manifest: PlanManifest,
  allIds: ReadonlySet<string>,
  dupErrors: ReadonlyArray<string>,
) =>
  pipe(
    [...dupErrors, ...pipe(manifest.issues, RA.chain((issue) => collectRefErrorsForIssue(issue, allIds)))],
    (allErrors) =>
      match(allErrors.length > 0)
        .with(true, () =>
          E.left<DomainError, PlanManifest>({
            type: 'PLAN_VALIDATION_ERROR',
            message: isoMessage.wrap('Plan manifest reference validation failed'),
            details: O.some(pipe(allErrors, RA.map(isoMessage.wrap))),
          }),
        )
        .with(false, () => checkCycles(manifest, allIds))
        .exhaustive(),
  );

export function validatePlanDag(manifest: PlanManifest) {
  return pipe(
    collectDuplicateErrors(manifest.issues, O.fromNullable(manifest.epic?.id)),
    ({ allIds, errors }) => validateReferences(manifest, allIds, errors),
  );
}
