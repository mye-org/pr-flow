import * as E from 'fp-ts/lib/Either';
import { flow } from 'fp-ts/lib/function';
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
    allIds: O.match(
      () => new Set<string>(),
      (id: string) => new Set<string>([id]),
    )(epicId),
    errors: [],
  }) satisfies DupAcc;

const formatDupError = (issueId: string) => `Duplicate issue id '${issueId}'`;

const appendDupAcc = (acc: DupAcc, issue: PlanIssueNode) =>
  ({
    allIds: new Set([...acc.allIds, issue.id]),
    errors: acc.allIds.has(issue.id)
      ? [...acc.errors, formatDupError(issue.id)]
      : acc.errors,
  }) satisfies DupAcc;

const collectDuplicateErrors = (
  issues: ReadonlyArray<PlanIssueNode>,
  epicId: O.Option<string>,
) => RA.reduce(initDupAcc(epicId), appendDupAcc)(issues);

const formatUnknownBlockedBy = (issueId: string, dep: string) =>
  `Issue '${issueId}' references unknown blockedBy id '${dep}'`;

const formatSelfBlockedBy = (issueId: string) =>
  `Issue '${issueId}' cannot be blocked by itself`;

const collectBlockedByRefErrors = (issue: PlanIssueNode, allIds: ReadonlySet<string>) =>
  RA.flatMap((dep: string) => [
    ...(!allIds.has(dep) ? [formatUnknownBlockedBy(issue.id, dep)] : []),
    ...(dep === issue.id ? [formatSelfBlockedBy(issue.id)] : []),
  ])(issue.blockedBy);

const formatUnknownParent = (issueId: string, parentId: string) =>
  `Issue '${issueId}' references unknown parentId '${parentId}'`;

const formatSelfParent = (issueId: string) =>
  `Issue '${issueId}' cannot be its own parent`;

const collectRefErrorsForIssue = (
  issue: PlanIssueNode,
  allIds: ReadonlySet<string>,
) => [
  ...(issue.parentId && !allIds.has(issue.parentId)
    ? [formatUnknownParent(issue.id, issue.parentId)]
    : []),
  ...(issue.parentId === issue.id ? [formatSelfParent(issue.id)] : []),
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

type IssueAdjUpdate = {
  readonly adj: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly issue: PlanIssueNode;
};

const addBlockedByToAdj = (update: IssueAdjUpdate) =>
  RA.reduce(update.adj, (m: ReadonlyMap<string, ReadonlyArray<string>>, dep: string) =>
    addEdgeToAdj(m, {
      source: isoPlanNodeId.wrap(dep),
      target: isoPlanNodeId.wrap(update.issue.id),
    }),
  )(update.issue.blockedBy);

const addParentToAdj = (update: IssueAdjUpdate) =>
  update.issue.parentId
    ? addEdgeToAdj(update.adj, {
        source: isoPlanNodeId.wrap(update.issue.parentId),
        target: isoPlanNodeId.wrap(update.issue.id),
      })
    : update.adj;

const addDepsToAdj = (
  adj: ReadonlyMap<string, ReadonlyArray<string>>,
  issue: PlanIssueNode,
) => addBlockedByToAdj({ adj: addParentToAdj({ adj, issue }), issue });

const setToArray = (ids: ReadonlySet<string>) => Array.from(ids);

const initialAdjEntries = flow(
  setToArray,
  RA.map((id) => [id, []] as const),
);

const buildAdjacency = (
  allIds: ReadonlySet<string>,
  issues: ReadonlyArray<PlanIssueNode>,
) =>
  RA.reduce(new Map<string, ReadonlyArray<string>>(initialAdjEntries(allIds)), addDepsToAdj)(
    issues,
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
  O.match(
    () => dfsNode(next, { ...state, visited: acc.visited }),
    () => acc,
  )(acc.cycle);

const dfsNeighbors = (
  neighbors: ReadonlyArray<string>,
  state: DfsState,
) =>
  RA.reduce({ visited: state.visited, cycle: O.none }, (acc: DfsResult, next: string) =>
    stepNeighbor(next, acc, state),
  )(neighbors);

const finalizeExplore = (nodeId: string, res: DfsResult) => ({
  visited: new Set([...res.visited, nodeId]),
  cycle: res.cycle,
});

const exploreNode = (nodeId: string, state: DfsState) =>
  finalizeExplore(
    nodeId,
    dfsNeighbors(state.adj.get(nodeId) ?? [], {
      ...state,
      path: [...state.path, nodeId],
      visiting: new Set([...state.visiting, nodeId]),
    }),
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
  RA.reduce({ visited: new Set<string>(), cycle: O.none }, (acc: DfsResult, id: string) =>
    O.isSome(acc.cycle) || acc.visited.has(id)
      ? acc
      : dfsNode(id, { path: [], visiting: new Set<string>(), visited: acc.visited, adj }),
  )(setToArray(allIds)).cycle;

const formatCyclePath = (cycle: ReadonlyArray<string>) => cycle.join(' -> ');

const formatCycleMessage = (cyclePath: string) =>
  `Dependency cycle detected: ${cyclePath}`;

const toCycleError = (cycle: ReadonlyArray<string>) => {
  const cyclePath = formatCyclePath(cycle);
  return {
    type: 'PLAN_VALIDATION_ERROR',
    message: isoMessage.wrap(formatCycleMessage(cyclePath)),
    details: [isoMessage.wrap(cyclePath)],
  } satisfies DomainError;
};

const checkCycles = (
  manifest: PlanManifest,
  allIds: ReadonlySet<string>,
) =>
  flow(
    (issues: ReadonlyArray<PlanIssueNode>) => buildAdjacency(allIds, issues),
    (adj) => findCycle(allIds, adj),
    O.match(
      () => E.right<DomainError, PlanManifest>(manifest),
      flow(toCycleError, E.left<DomainError, PlanManifest>),
    ),
  )(manifest.issues);

const collectAllRefErrors = (
  issues: ReadonlyArray<PlanIssueNode>,
  allIds: ReadonlySet<string>,
) => RA.flatMap((issue: PlanIssueNode) => collectRefErrorsForIssue(issue, allIds))(issues);

const wrapMessages = RA.map(isoMessage.wrap);

const validateReferences = (
  manifest: PlanManifest,
  allIds: ReadonlySet<string>,
  dupErrors: ReadonlyArray<string>,
) => {
  const allErrors = [...dupErrors, ...collectAllRefErrors(manifest.issues, allIds)];
  return match(allErrors.length > 0)
    .with(true, () =>
      E.left<DomainError, PlanManifest>({
        type: 'PLAN_VALIDATION_ERROR',
        message: isoMessage.wrap('Plan manifest reference validation failed'),
        details: wrapMessages(allErrors),
      }),
    )
    .with(false, () => checkCycles(manifest, allIds))
    .exhaustive();
};

export function validatePlanDag(manifest: PlanManifest) {
  const { allIds, errors } = collectDuplicateErrors(
    manifest.issues,
    O.fromNullable(manifest.epic?.id),
  );
  return validateReferences(manifest, allIds, errors);
}
