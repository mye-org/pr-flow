import { pipe } from 'fp-ts/lib/function';
import * as O from 'fp-ts/lib/Option';
import * as RA from 'fp-ts/lib/ReadonlyArray';
import type { PlanIssueNode, PlanManifest } from '../domain/plan.js';

type Graph = {
  readonly byId: ReadonlyMap<string, PlanIssueNode>;
  readonly inDegree: ReadonlyMap<string, number>;
  readonly adj: ReadonlyMap<string, ReadonlyArray<string>>;
};

const addEdge = (graph: Graph, from: string, to: string): Graph => {
  if (!graph.byId.has(from) || !graph.byId.has(to) || from === to) {
    return graph;
  }
  const existing = graph.adj.get(from) ?? [];
  if (existing.includes(to)) {
    return graph;
  }
  return {
    byId: graph.byId,
    adj: new Map(graph.adj).set(from, [...existing, to]),
    inDegree: new Map(graph.inDegree).set(to, (graph.inDegree.get(to) ?? 0) + 1),
  };
};

const addIssueEdges = (graph: Graph, issue: PlanIssueNode): Graph =>
  pipe(
    issue.parentId ? addEdge(graph, issue.parentId, issue.id) : graph,
    (g) => pipe(issue.blockedBy, RA.reduce(g, (acc, dep) => addEdge(acc, dep, issue.id))),
  );

const buildGraph = (manifest: PlanManifest): Graph =>
  pipe(
    {
      byId: new Map(pipe(manifest.issues, RA.map((i) => [i.id, i] as const))),
      inDegree: new Map(pipe(manifest.issues, RA.map((i) => [i.id, 0] as const))),
      adj: new Map(pipe(manifest.issues, RA.map((i) => [i.id, [] as ReadonlyArray<string>] as const))),
    } satisfies Graph,
    (initial) => pipe(manifest.issues, RA.reduce(initial, addIssueEdges)),
  );

const decrementNeighbors = (
  neighbors: ReadonlyArray<string>,
  inDegree: ReadonlyMap<string, number>,
): { readonly inDegree: ReadonlyMap<string, number>; readonly newlyReady: ReadonlyArray<string> } =>
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

const stepWithNode = (
  current: string,
  restQueue: ReadonlyArray<string>,
  inDegree: ReadonlyMap<string, number>,
  graph: Graph,
  acc: ReadonlyArray<PlanIssueNode>,
): ReadonlyArray<PlanIssueNode> => {
  const node = graph.byId.get(current);
  const { inDegree: nextInDegree, newlyReady } = decrementNeighbors(
    graph.adj.get(current) ?? [],
    inDegree,
  );
  return kahnStep([...restQueue, ...newlyReady], nextInDegree, graph, node ? [...acc, node] : acc);
};

function kahnStep(
  queue: ReadonlyArray<string>,
  inDegree: ReadonlyMap<string, number>,
  graph: Graph,
  acc: ReadonlyArray<PlanIssueNode>,
): ReadonlyArray<PlanIssueNode> {
  return pipe(
    RA.head(queue),
    O.match(
      () => acc,
      (current) => stepWithNode(current, queue.slice(1), inDegree, graph, acc),
    ),
  );
}

/**
 * Topologically sorts plan issues so that:
 * 1. Parent issues are created before their children.
 * 2. Blocking issues are ordered before the issues they block.
 */
export function topoSortPlan(manifest: PlanManifest): ReadonlyArray<PlanIssueNode> {
  return pipe(buildGraph(manifest), (graph) =>
    kahnStep(
      pipe(
        Array.from(graph.inDegree.entries()),
        RA.filterMap(([id, deg]) => (deg === 0 ? O.some(id) : O.none)),
      ),
      graph.inDegree,
      graph,
      [],
    ),
  );
}
