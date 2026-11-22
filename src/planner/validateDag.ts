import * as E from 'fp-ts/lib/Either';
import { pipe } from 'fp-ts/lib/function';
import * as O from 'fp-ts/lib/Option';
import * as RA from 'fp-ts/lib/ReadonlyArray';
import { match } from 'ts-pattern';
import type { DomainError } from '../domain/errors.js';
import { isoMessage, isoPlanNodeId, type PlanNodeId } from '../domain/newtypes.js';
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

const collectBlockedByRefErrors = (issue: PlanIssueNode, allIds: ReadonlySet<string>) =>
  pipe(
    issue.blockedBy,
    RA.flatMap((dep) => [
      ...(!allIds.has(dep) ? [`Issue '${issue.id}' references unknown blockedBy id '${dep}'`] : []),
      ...(dep === issue.id ? [`Issue '${issue.id}' cannot be blocked by itself`] : []),
    ]),
  );

const collectRefErrorsForIssue = (
  issue: PlanIssueNode,
  allIds: ReadonlySet<string>,
) => [
  ...(issue.parentId && !allIds.has(issue.parentId)
    ? [`Issue '${issue.id}' references unknown parentId '${issue.parentId}'`]
    : []),
  ...(issue.parentId === issue.id ? [`Issue '${issue.id}' cannot be its own parent`] : []),
  ...collectBlockedByRefErrors(issue, allIds),
];

type DagEdge = {
  readonly source: PlanNodeId;
  readonly target: PlanNodeId;
};

const addEdgeToAdj = (
  adj: ReadonlyMap<string, ReadonlyArray<string>>,
  edge: DagEdge,
) => {
  const source = isoPlanNodeId.unwrap(edge.source);
  return new Map(adj).set(source, [...(adj.get(source) ?? []), isoPlanNodeId.unwrap(edge.target)]);
};

const addBlockedByToAdj = (
  adj: ReadonlyMap<string, ReadonlyArray<string>>,
  issue: PlanIssueNode,
) =>
  pipe(
    issue.blockedBy,
    RA.reduce(adj, (m, dep) =>
      addEdgeToAdj(m, { source: isoPlanNodeId.wrap(dep), target: isoPlanNodeId.wrap(issue.id) }),
    ),
  );

const addDepsToAdj = (
  adj: ReadonlyMap<string, ReadonlyArray<string>>,
  issue: PlanIssueNode,
) =>
  pipe(
    issue.parentId
      ? addEdgeToAdj(adj, {
          source: isoPlanNodeId.wrap(issue.parentId),
          target: isoPlanNodeId.wrap(issue.id),
        })
      : adj,
    (withParent) => addBlockedByToAdj(withParent, issue),
  );

const initialAdjEntries = (allIds: ReadonlySet<string>) =>
  pipe(
    Array.from(allIds),
    RA.map((id) => [id, []] as const),
  );

const buildAdjacency = (
  allIds: ReadonlySet<string>,
  issues: ReadonlyArray<PlanIssueNode>,
) =>
  pipe(
    issues,
    RA.reduce(new Map<string, ReadonlyArray<string>>(initialAdjEntries(allIds)), addDepsToAdj),
  );

type DfsResult = {
  readonly visited: ReadonlySet<string>;
  readonly cycle: O.Option<ReadonlyArray<string>>;
};

type DfsState = {
  readonly path: ReadonlyArray<string>;
  readonly visiting: ReadonlySet<string>;
  readonly visited: ReadonlySet<string>;
  readonly adj: ReadonlyMap<string, ReadonlyArray<string>>;
};

type DfsNodeFn = (nodeId: string, state: DfsState) => DfsResult;

const stepNeighbor = (
  next: string,
  acc: DfsResult,
  state: DfsState,
) =>
  pipe(
    acc.cycle,
    O.match(
      () => dfsNode(next, { ...state, visited: acc.visited }),
      () => acc,
    ),
  );

const dfsNeighbors = (
  neighbors: ReadonlyArray<string>,
  state: DfsState,
) =>
  pipe(
    neighbors,
    RA.reduce({ visited: state.visited, cycle: O.none }, (acc: DfsResult, next) =>
      stepNeighbor(next, acc, state),
    ),
  );

const exploreNode = (nodeId: string, state: DfsState) =>
  pipe(
    dfsNeighbors(state.adj.get(nodeId) ?? [], {
      ...state,
      path: [...state.path, nodeId],
      visiting: new Set([...state.visiting, nodeId]),
    }),
    (res) => ({ visited: new Set([...res.visited, nodeId]), cycle: res.cycle }),
  );

const dfsNode: DfsNodeFn = (nodeId, state) =>
  match({
    isVisiting: state.visiting.has(nodeId),
    isVisited: state.visited.has(nodeId),
  })
    .with({ isVisiting: true }, () => ({
      visited: state.visited,
      cycle: O.some([...state.path, nodeId]),
    }))
    .with({ isVisited: true }, () => ({
      visited: state.visited,
      cycle: O.none,
    }))
    .otherwise(() => exploreNode(nodeId, state));

const findCycle = (
  allIds: ReadonlySet<string>,
  adj: ReadonlyMap<string, ReadonlyArray<string>>,
) =>
  pipe(
    Array.from(allIds),
    RA.reduce({ visited: new Set<string>(), cycle: O.none }, (acc: DfsResult, id) =>
      O.isSome(acc.cycle) || acc.visited.has(id)
        ? acc
        : dfsNode(id, { path: [], visiting: new Set<string>(), visited: acc.visited, adj }),
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
          details: [isoMessage.wrap(cycle.join(' -> '))],
        }),
    ),
  );

const collectAllRefErrors = (
  issues: ReadonlyArray<PlanIssueNode>,
  allIds: ReadonlySet<string>,
) =>
  pipe(
    issues,
    RA.flatMap((issue) => collectRefErrorsForIssue(issue, allIds)),
  );

const wrapMessages = (msgs: ReadonlyArray<string>) => pipe(msgs, RA.map(isoMessage.wrap));

const validateReferences = (
  manifest: PlanManifest,
  allIds: ReadonlySet<string>,
  dupErrors: ReadonlyArray<string>,
) =>
  pipe(
    [...dupErrors, ...collectAllRefErrors(manifest.issues, allIds)],
    (allErrors) =>
      match(allErrors.length > 0)
        .with(true, () =>
          E.left<DomainError, PlanManifest>({
            type: 'PLAN_VALIDATION_ERROR',
            message: isoMessage.wrap('Plan manifest reference validation failed'),
            details: wrapMessages(allErrors),
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
