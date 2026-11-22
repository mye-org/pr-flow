import { flow } from 'fp-ts/lib/function';
import * as O from 'fp-ts/lib/Option';
import * as RA from 'fp-ts/lib/ReadonlyArray';
import * as TE from 'fp-ts/lib/TaskEither';
import { match } from 'ts-pattern';
import type { GitHubPlannerPort } from '../adapters/github/types.js';
import type { DomainError } from '../domain/errors.js';
import { AI_MANAGED_LABEL, TYPE_TO_LABEL } from '../domain/issue.js';
import { isoIssueNumber, isoLabelName, type IssueNumber } from '../domain/newtypes.js';
import type { PlanIssueNode, PlanManifest } from '../domain/plan.js';
import { topoSortPlan } from './topoSort.js';
import { validatePlanDag } from './validateDag.js';

export type SubIssueLink = {
  readonly parent: IssueNumber;
  readonly child: IssueNumber;
};

export type DependencyLink = {
  readonly issue: IssueNumber;
  readonly blockedBy: IssueNumber;
};

export type MaterializedPlanResult = {
  readonly createdIssues: Readonly<Record<string, number>>;
  readonly subIssueLinks: ReadonlyArray<SubIssueLink>;
  readonly dependencyLinks: ReadonlyArray<DependencyLink>;
};

export const ISSUE_DEVELOPMENT_STANDARDS = [
  '## Development Standards',
  '- Always use **declarative programming style**.',
  '- Always use **TypeScript type-driven development**.',
  '- Always use **functional programming style**.',
].join('\n');

export function formatIssueBody(body: string) {
  const trimmed = body.trim();
  return match(trimmed.includes('## Development Standards'))
    .with(true, () => trimmed)
    .with(false, () =>
      trimmed.length > 0
        ? `${trimmed}\n\n${ISSUE_DEVELOPMENT_STANDARDS}`
        : ISSUE_DEVELOPMENT_STANDARDS,
    )
    .exhaustive();
}

type MaterializeContext = {
  readonly github: GitHubPlannerPort;
  readonly idToNumber: ReadonlyMap<string, number>;
};

const assignCreatedStatus = (
  github: GitHubPlannerPort,
  issueNumber: number,
  epicId: string,
) =>
  TE.map(() => new Map<string, number>([[epicId, issueNumber]]))(
    github.updateIssueStatus(issueNumber, 'backlog'),
  );

const createEpicNode = (
  epic: NonNullable<PlanManifest['epic']>,
  github: GitHubPlannerPort,
) =>
  flow(
    (input: Parameters<GitHubPlannerPort['createIssue']>[0]) => github.createIssue(input),
    TE.flatMap((created) => assignCreatedStatus(github, created.number, epic.id)),
  )({
    title: epic.title,
    body: formatIssueBody(epic.body),
    labels: [isoLabelName.unwrap(TYPE_TO_LABEL.epic), isoLabelName.unwrap(AI_MANAGED_LABEL)],
  });

const createEpicIfPresent = (
  epic: PlanManifest['epic'],
  github: GitHubPlannerPort,
) =>
  flow(
    O.fromNullable<PlanManifest['epic']>,
    O.match(
      () => TE.right(new Map<string, number>()),
      (e) => createEpicNode(e, github),
    ),
  )(epic);

const toUniqueArray = (items: ReadonlyArray<string>) => Array.from(new Set(items));

const nodeLabels = (node: PlanIssueNode) =>
  toUniqueArray([
    isoLabelName.unwrap(TYPE_TO_LABEL[node.type]),
    isoLabelName.unwrap(AI_MANAGED_LABEL),
    ...node.labels,
  ]);

const collectParentIds = (nodes: ReadonlyArray<PlanIssueNode>) =>
  new Set(RA.filterMap((n: PlanIssueNode) => O.fromNullable(n.parentId))(nodes));

const initialStatusForNode = (
  node: PlanIssueNode,
  parentIds: ReadonlySet<string>,
) =>
  match(node.type === 'epic' || parentIds.has(node.id))
    .with(true, () => 'backlog' as const)
    .with(false, () => (node.blockedBy.length > 0 ? ('blocked_dep' as const) : ('ready' as const)))
    .exhaustive();

const assignNodeStatus = (
  ctx: MaterializeContext,
  node: PlanIssueNode,
  createdNumber: number,
  parentIds: ReadonlySet<string>,
) =>
  flow(
    (status: ReturnType<typeof initialStatusForNode>) =>
      ctx.github.updateIssueStatus(createdNumber, status),
    TE.map(() => new Map(ctx.idToNumber).set(node.id, createdNumber)),
  )(initialStatusForNode(node, parentIds));

const createSingleNode = (
  node: PlanIssueNode,
  ctx: MaterializeContext,
  parentIds: ReadonlySet<string>,
) =>
  flow(
    (input: Parameters<GitHubPlannerPort['createIssue']>[0]) => ctx.github.createIssue(input),
    TE.flatMap((created) => assignNodeStatus(ctx, node, created.number, parentIds)),
  )({
    title: node.title,
    body: formatIssueBody(node.body),
    labels: nodeLabels(node),
  });

const appendCreatedNode = (
  github: GitHubPlannerPort,
  parentIds: ReadonlySet<string>,
) => (acc: TE.TaskEither<DomainError, ReadonlyMap<string, number>>, node: PlanIssueNode) =>
  TE.flatMap((idToNumber: ReadonlyMap<string, number>) =>
    createSingleNode(node, { github, idToNumber }, parentIds),
  )(acc);

const createNodesWithParentIds = (
  sorted: ReadonlyArray<PlanIssueNode>,
  initialMap: ReadonlyMap<string, number>,
  github: GitHubPlannerPort,
  parentIds: ReadonlySet<string>,
) =>
  RA.reduce(
    TE.right<DomainError, ReadonlyMap<string, number>>(initialMap),
    appendCreatedNode(github, parentIds),
  )(sorted);

const createAllNodes = (
  sorted: ReadonlyArray<PlanIssueNode>,
  initialMap: ReadonlyMap<string, number>,
  github: GitHubPlannerPort,
) => createNodesWithParentIds(sorted, initialMap, github, collectParentIds(sorted));

const emptyParentLinkResult = () => ({
  subLinks: [] as ReadonlyArray<SubIssueLink>,
  tasks: [] as ReadonlyArray<TE.TaskEither<DomainError, void>>,
});

const buildParentLinkResult = (
  parentNum: number,
  childNum: number,
  github: GitHubPlannerPort,
) => ({
  subLinks: [
    { parent: isoIssueNumber.wrap(parentNum), child: isoIssueNumber.wrap(childNum) },
  ] as ReadonlyArray<SubIssueLink>,
  tasks: [github.addSubIssue(parentNum, childNum)] as ReadonlyArray<
    TE.TaskEither<DomainError, void>
  >,
});

const collectParentLink = (
  childNum: number,
  parentId: O.Option<string>,
  ctx: MaterializeContext,
) =>
  flow(
    O.flatMap(flow((id: string) => ctx.idToNumber.get(id), O.fromNullable)),
    O.match(
      emptyParentLinkResult,
      (parentNum) => buildParentLinkResult(parentNum, childNum, ctx.github),
    ),
  )(parentId);

const toDepPair = (
  childNum: number,
  blockerNum: number,
  github: GitHubPlannerPort,
) => ({
  link: { issue: isoIssueNumber.wrap(childNum), blockedBy: isoIssueNumber.wrap(blockerNum) },
  task: github.addBlockedBy(childNum, blockerNum),
});

const resolveDepPair = (
  childNum: number,
  depId: string,
  ctx: MaterializeContext,
) =>
  flow(
    (id: string) => ctx.idToNumber.get(id),
    O.fromNullable,
    O.map((b: number) => toDepPair(childNum, b, ctx.github)),
  )(depId);

type DepPair = ReturnType<typeof toDepPair>;

const extractDepLinks = RA.map((p: DepPair) => p.link);

const extractDepTasks = RA.map((p: DepPair) => p.task);

const toCollectedDeps = (pairs: ReadonlyArray<DepPair>) => ({
  depLinks: extractDepLinks(pairs),
  tasks: extractDepTasks(pairs),
});

const collectDepLinks = (
  childNum: number,
  blockedBy: ReadonlyArray<string>,
  ctx: MaterializeContext,
) =>
  flow(
    RA.filterMap((depId: string) => resolveDepPair(childNum, depId, ctx)),
    toCollectedDeps,
  )(blockedBy);

const resolveParentId = (node: PlanIssueNode, epic: PlanManifest['epic']) =>
  O.alt(() => O.fromNullable(epic?.id))(O.fromNullable(node.parentId));

const buildNodeLinks = (
  childNum: number,
  node: PlanIssueNode,
  epic: PlanManifest['epic'],
  ctx: MaterializeContext,
) => {
  const parent = collectParentLink(childNum, resolveParentId(node, epic), ctx);
  const deps = collectDepLinks(childNum, node.blockedBy, ctx);
  return {
    subLinks: parent.subLinks,
    depLinks: deps.depLinks,
    tasks: [...parent.tasks, ...deps.tasks] as ReadonlyArray<TE.TaskEither<DomainError, void>>,
  };
};

type CollectedNodeLinks = ReturnType<typeof buildNodeLinks>;

const collectLinksForNode = (
  node: PlanIssueNode,
  epic: PlanManifest['epic'],
  ctx: MaterializeContext,
) =>
  flow(
    (id: string) => ctx.idToNumber.get(id),
    O.fromNullable,
    O.match(
      () => ({
        subLinks: [] as ReadonlyArray<SubIssueLink>,
        depLinks: [] as ReadonlyArray<DependencyLink>,
        tasks: [] as ReadonlyArray<TE.TaskEither<DomainError, void>>,
      }),
      (childNum: number) => buildNodeLinks(childNum, node, epic, ctx),
    ),
  )(node.id);

const chainTask = (
  acc: TE.TaskEither<DomainError, void>,
  task: TE.TaskEither<DomainError, void>,
) => TE.flatMap(() => task)(acc);

const emptyTask: TE.TaskEither<DomainError, void> = TE.right(undefined);

const runSequentialTasks = RA.reduce(emptyTask, chainTask);

const flattenTasks = RA.flatMap((c: CollectedNodeLinks) => c.tasks);

const flattenSubLinks = RA.flatMap((c: CollectedNodeLinks) => c.subLinks);

const flattenDepLinks = RA.flatMap((c: CollectedNodeLinks) => c.depLinks);

function mapToRecord(map: ReadonlyMap<string, number>) {
  return Object.fromEntries(map.entries());
}

const toMaterializedResult = (
  collected: ReadonlyArray<CollectedNodeLinks>,
  idToNumber: ReadonlyMap<string, number>,
) =>
  ({
    createdIssues: mapToRecord(idToNumber),
    subIssueLinks: flattenSubLinks(collected),
    dependencyLinks: flattenDepLinks(collected),
  }) satisfies MaterializedPlanResult;

const executeCollectedLinks = (
  collected: ReadonlyArray<CollectedNodeLinks>,
  idToNumber: ReadonlyMap<string, number>,
) =>
  flow(
    flattenTasks,
    runSequentialTasks,
    TE.map(() => toMaterializedResult(collected, idToNumber)),
  )(collected);

const linkAllNodes = (
  sorted: ReadonlyArray<PlanIssueNode>,
  epic: PlanManifest['epic'],
  ctx: MaterializeContext,
) =>
  flow(
    RA.map((node: PlanIssueNode) => collectLinksForNode(node, epic, ctx)),
    (collected) => executeCollectedLinks(collected, ctx.idToNumber),
  )(sorted);

const materializeValidPlan = (
  validManifest: PlanManifest,
  github: GitHubPlannerPort,
) => {
  const sorted = topoSortPlan(validManifest);
  return flow(
    (epic: PlanManifest['epic']) => createEpicIfPresent(epic, github),
    TE.flatMap((epicMap) => createAllNodes(sorted, epicMap, github)),
    TE.flatMap((idToNumber) =>
      linkAllNodes(sorted, validManifest.epic, { github, idToNumber }),
    ),
  )(validManifest.epic);
};

export function materializePlan(
  manifest: PlanManifest,
  github: GitHubPlannerPort,
) {
  return flow(
    validatePlanDag,
    TE.fromEither,
    TE.flatMap((validManifest) => materializeValidPlan(validManifest, github)),
  )(manifest);
}
