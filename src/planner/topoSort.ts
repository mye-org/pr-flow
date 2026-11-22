import { flow } from 'fp-ts/lib/function';
import * as O from 'fp-ts/lib/Option';
import * as RA from 'fp-ts/lib/ReadonlyArray';
import { match } from 'ts-pattern';
import { isoPlanNodeId, type PlanNodeId } from '../domain/newtypes.js';
import type { PlanIssueNode, PlanManifest } from '../domain/plan.js';

type Graph = {
  readonly byId: ReadonlyMap<string, PlanIssueNode>;
  readonly inDegree: ReadonlyMap<string, number>;
  readonly adj: ReadonlyMap<string, ReadonlyArray<string>>;
};

type Edge = {
  readonly source: PlanNodeId;
  readonly target: PlanNodeId;
};

type EdgeInsertion = {
  readonly graph: Graph;
  readonly edge: Edge;
};

const insertUniqueEdge = (
  insertion: EdgeInsertion,
  existing: ReadonlyArray<string>,
) => {
  const { graph, edge } = insertion;
  return {
    byId: graph.byId,
    adj: new Map(graph.adj).set(isoPlanNodeId.unwrap(edge.source), [
      ...existing,
      isoPlanNodeId.unwrap(edge.target),
    ]),
    inDegree: new Map(graph.inDegree).set(
      isoPlanNodeId.unwrap(edge.target),
      (graph.inDegree.get(isoPlanNodeId.unwrap(edge.target)) ?? 0) + 1,
    ),
  };
};

const hasEdgeTarget = (existing: ReadonlyArray<string>, target: string) =>
  existing.includes(target);

const isDuplicateTarget = (existing: ReadonlyArray<string>, edge: Edge) =>
  hasEdgeTarget(existing, isoPlanNodeId.unwrap(edge.target));

const appendUniqueEdge = (insertion: EdgeInsertion) => {
  const { graph, edge } = insertion;
  const existing = graph.adj.get(isoPlanNodeId.unwrap(edge.source)) ?? [];
  return match(isDuplicateTarget(existing, edge))
    .with(true, () => graph)
    .with(false, () => insertUniqueEdge(insertion, existing))
    .exhaustive();
};

const addEdge = (insertion: EdgeInsertion) => {
  const { graph, edge } = insertion;
  const source = isoPlanNodeId.unwrap(edge.source);
  const target = isoPlanNodeId.unwrap(edge.target);
  return match(
    !graph.byId.has(source) ||
      !graph.byId.has(target) ||
      source === target,
  )
    .with(true, () => graph)
    .with(false, () => appendUniqueEdge(insertion))
    .exhaustive();
};

type IssueGraphUpdate = {
  readonly graph: Graph;
  readonly issue: PlanIssueNode;
};

const addBlockedByEdges = (update: IssueGraphUpdate) =>
  RA.reduce(update.graph, (acc: Graph, dep: string) =>
    addEdge({
      graph: acc,
      edge: { source: isoPlanNodeId.wrap(dep), target: isoPlanNodeId.wrap(update.issue.id) },
    }),
  )(update.issue.blockedBy);

const addParentEdge = (update: IssueGraphUpdate) =>
  update.issue.parentId
    ? addEdge({
        graph: update.graph,
        edge: {
          source: isoPlanNodeId.wrap(update.issue.parentId),
          target: isoPlanNodeId.wrap(update.issue.id),
        },
      })
    : update.graph;

const addIssueEdges = (graph: Graph, issue: PlanIssueNode) =>
  addBlockedByEdges({ graph: addParentEdge({ graph, issue }), issue });

const buildByIdMap = (issues: ReadonlyArray<PlanIssueNode>) =>
  new Map(RA.map((i: PlanIssueNode) => [i.id, i] as const)(issues));

const buildInDegreeMap = (issues: ReadonlyArray<PlanIssueNode>) =>
  new Map(RA.map((i: PlanIssueNode) => [i.id, 0] as const)(issues));

const buildAdjMap = (issues: ReadonlyArray<PlanIssueNode>) =>
  new Map(RA.map((i: PlanIssueNode) => [i.id, [] as ReadonlyArray<string>] as const)(issues));

const applyAllIssueEdges = (issues: ReadonlyArray<PlanIssueNode>) => (initial: Graph) =>
  RA.reduce(initial, addIssueEdges)(issues);

const buildGraph = (manifest: PlanManifest) =>
  applyAllIssueEdges(manifest.issues)({
    byId: buildByIdMap(manifest.issues),
    inDegree: buildInDegreeMap(manifest.issues),
    adj: buildAdjMap(manifest.issues),
  });

const decrementNeighbor = (
  acc: {
    readonly inDegree: ReadonlyMap<string, number>;
    readonly newlyReady: ReadonlyArray<string>;
  },
  next: string,
) => {
  const nextDeg = (acc.inDegree.get(next) ?? 1) - 1;
  return {
    inDegree: new Map(acc.inDegree).set(next, nextDeg),
    newlyReady: nextDeg === 0 ? [...acc.newlyReady, next] : acc.newlyReady,
  };
};

const decrementNeighbors = (
  neighbors: ReadonlyArray<string>,
  inDegree: ReadonlyMap<string, number>,
) => RA.reduce({ inDegree, newlyReady: [] as ReadonlyArray<string> }, decrementNeighbor)(neighbors);

type KahnStepFn = (
  queue: ReadonlyArray<string>,
  inDegree: ReadonlyMap<string, number>,
  graph: Graph,
  acc: ReadonlyArray<PlanIssueNode>,
) => ReadonlyArray<PlanIssueNode>;

const tailQueue = (queue: ReadonlyArray<string>) => queue.slice(1);

const stepWithNode = (
  current: string,
  queue: ReadonlyArray<string>,
  inDegree: ReadonlyMap<string, number>,
  graph: Graph,
  acc: ReadonlyArray<PlanIssueNode>,
) => {
  const node = graph.byId.get(current);
  const { inDegree: nextInDegree, newlyReady } = decrementNeighbors(
    graph.adj.get(current) ?? [],
    inDegree,
  );
  return kahnStep(
    [...tailQueue(queue), ...newlyReady],
    nextInDegree,
    graph,
    node ? [...acc, node] : acc,
  );
};

const kahnStep: KahnStepFn = (queue, inDegree, graph, acc) =>
  O.match(
    () => acc,
    (current: string) => stepWithNode(current, queue, inDegree, graph, acc),
  )(RA.head(queue));

function mapEntries<K, V>(map: ReadonlyMap<K, V>) {
  return Array.from(map.entries());
}

const readyNodeIds = flow(
  mapEntries<string, number>,
  RA.filterMap(([id, deg]) => (deg === 0 ? O.some(id) : O.none)),
);

function runKahn(graph: Graph) {
  return kahnStep(readyNodeIds(graph.inDegree), graph.inDegree, graph, []);
}

/**
 * Topologically sorts plan issues so that:
 * 1. Parent issues are created before their children.
 * 2. Blocking issues are ordered before the issues they block.
 */
export const topoSortPlan = flow(buildGraph, runKahn);
