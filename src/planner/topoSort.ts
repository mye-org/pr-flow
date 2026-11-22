import { flow, pipe } from 'fp-ts/lib/function';
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

const appendUniqueEdge = (insertion: EdgeInsertion) => {
  const { graph, edge } = insertion;
  const existing = graph.adj.get(isoPlanNodeId.unwrap(edge.source)) ?? [];
  return pipe(edge.target, isoPlanNodeId.unwrap, (target) =>
    match(existing.includes(target))
      .with(true, () => graph)
      .with(false, () => insertUniqueEdge(insertion, existing))
      .exhaustive(),
  );
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

const addBlockedByEdges = (graph: Graph, issue: PlanIssueNode) =>
  pipe(
    issue.blockedBy,
    RA.reduce(graph, (acc, dep) =>
      addEdge({
        graph: acc,
        edge: { source: isoPlanNodeId.wrap(dep), target: isoPlanNodeId.wrap(issue.id) },
      }),
    ),
  );

const addIssueEdges = (graph: Graph, issue: PlanIssueNode) =>
  pipe(
    issue.parentId
      ? addEdge({
          graph,
          edge: {
            source: isoPlanNodeId.wrap(issue.parentId),
            target: isoPlanNodeId.wrap(issue.id),
          },
        })
      : graph,
    (g) => addBlockedByEdges(g, issue),
  );

const buildByIdMap = (issues: ReadonlyArray<PlanIssueNode>) =>
  new Map(
    pipe(
      issues,
      RA.map((i) => [i.id, i] as const),
    ),
  );

const buildInDegreeMap = (issues: ReadonlyArray<PlanIssueNode>) =>
  new Map(
    pipe(
      issues,
      RA.map((i) => [i.id, 0] as const),
    ),
  );

const buildAdjMap = (issues: ReadonlyArray<PlanIssueNode>) =>
  new Map(
    pipe(
      issues,
      RA.map((i) => [i.id, [] as ReadonlyArray<string>] as const),
    ),
  );

const applyAllIssueEdges = (issues: ReadonlyArray<PlanIssueNode>) => (initial: Graph) =>
  pipe(issues, RA.reduce(initial, addIssueEdges));

const buildGraph = (manifest: PlanManifest) =>
  pipe(
    {
      byId: buildByIdMap(manifest.issues),
      inDegree: buildInDegreeMap(manifest.issues),
      adj: buildAdjMap(manifest.issues),
    } satisfies Graph,
    applyAllIssueEdges(manifest.issues),
  );

const decrementNeighbors = (
  neighbors: ReadonlyArray<string>,
  inDegree: ReadonlyMap<string, number>,
) =>
  pipe(
    neighbors,
    RA.reduce({ inDegree, newlyReady: [] as ReadonlyArray<string> }, (acc, next) => {
      const nextDeg = (acc.inDegree.get(next) ?? 1) - 1;
      return {
        inDegree: new Map(acc.inDegree).set(next, nextDeg),
        newlyReady: nextDeg === 0 ? [...acc.newlyReady, next] : acc.newlyReady,
      };
    }),
  );

type KahnStepFn = (
  queue: ReadonlyArray<string>,
  inDegree: ReadonlyMap<string, number>,
  graph: Graph,
  acc: ReadonlyArray<PlanIssueNode>,
) => ReadonlyArray<PlanIssueNode>;

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
    [...queue.slice(1), ...newlyReady],
    nextInDegree,
    graph,
    node ? [...acc, node] : acc,
  );
};

const kahnStep: KahnStepFn = (queue, inDegree, graph, acc) =>
  pipe(
    RA.head(queue),
    O.match(
      () => acc,
      (current) => stepWithNode(current, queue, inDegree, graph, acc),
    ),
  );

const readyNodeIds = (inDegree: ReadonlyMap<string, number>) =>
  pipe(
    Array.from(inDegree.entries()),
    RA.filterMap(([id, deg]) => (deg === 0 ? O.some(id) : O.none)),
  );

const runKahn = (graph: Graph) =>
  pipe(readyNodeIds(graph.inDegree), (ready) =>
    kahnStep(ready, graph.inDegree, graph, []),
  );

/**
 * Topologically sorts plan issues so that:
 * 1. Parent issues are created before their children.
 * 2. Blocking issues are ordered before the issues they block.
 */
export const topoSortPlan = flow(buildGraph, runKahn);
