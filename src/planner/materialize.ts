import { flow, pipe } from 'fp-ts/lib/function';
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
  pipe(
    github.updateIssueStatus(issueNumber, 'backlog'),
    TE.map(() => new Map<string, number>([[epicId, issueNumber]])),
  );

const createEpicNode = (
  epic: NonNullable<PlanManifest['epic']>,
  github: GitHubPlannerPort,
) =>
  pipe(
    github.createIssue({
      title: epic.title,
      body: formatIssueBody(epic.body),
      labels: [isoLabelName.unwrap(TYPE_TO_LABEL.epic), isoLabelName.unwrap(AI_MANAGED_LABEL)],
    }),
    TE.flatMap((created) => assignCreatedStatus(github, created.number, epic.id)),
  );

const createEpicIfPresent = (
  epic: PlanManifest['epic'],
  github: GitHubPlannerPort,
) =>
  pipe(
    O.fromNullable(epic),
    O.match(
      () => TE.right(new Map<string, number>()),
      (e) => createEpicNode(e, github),
    ),
  );

const nodeLabels = (node: PlanIssueNode) =>
  Array.from(
    new Set([
      isoLabelName.unwrap(TYPE_TO_LABEL[node.type]),
      isoLabelName.unwrap(AI_MANAGED_LABEL),
      ...node.labels,
    ]),
  );

const collectParentIds = (nodes: ReadonlyArray<PlanIssueNode>) =>
  new Set(
    pipe(
      nodes,
      RA.filterMap((n) => O.fromNullable(n.parentId)),
    ),
  );

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
  pipe(
    ctx.github.updateIssueStatus(createdNumber, initialStatusForNode(node, parentIds)),
    TE.map(() => new Map(ctx.idToNumber).set(node.id, createdNumber)),
  );

const createSingleNode = (
  node: PlanIssueNode,
  ctx: MaterializeContext,
  parentIds: ReadonlySet<string>,
) =>
  pipe(
    ctx.github.createIssue({
      title: node.title,
      body: formatIssueBody(node.body),
      labels: nodeLabels(node),
    }),
    TE.flatMap((created) => assignNodeStatus(ctx, node, created.number, parentIds)),
  );

const appendCreatedNode = (
  github: GitHubPlannerPort,
  parentIds: ReadonlySet<string>,
) => (acc: TE.TaskEither<DomainError, ReadonlyMap<string, number>>, node: PlanIssueNode) =>
  pipe(
    acc,
    TE.flatMap((idToNumber) => createSingleNode(node, { github, idToNumber }, parentIds)),
  );

const createNodesWithParentIds = (
  sorted: ReadonlyArray<PlanIssueNode>,
  initialMap: ReadonlyMap<string, number>,
  github: GitHubPlannerPort,
  parentIds: ReadonlySet<string>,
) =>
  pipe(
    sorted,
    RA.reduce(
      TE.right<DomainError, ReadonlyMap<string, number>>(initialMap),
      appendCreatedNode(github, parentIds),
    ),
  );

const createAllNodes = (
  sorted: ReadonlyArray<PlanIssueNode>,
  initialMap: ReadonlyMap<string, number>,
  github: GitHubPlannerPort,
) =>
  pipe(collectParentIds(sorted), (parentIds) =>
    createNodesWithParentIds(sorted, initialMap, github, parentIds),
  );

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
  pipe(
    parentId,
    O.flatMap(flow((id: string) => ctx.idToNumber.get(id), O.fromNullable)),
    O.match(
      emptyParentLinkResult,
      (parentNum) => buildParentLinkResult(parentNum, childNum, ctx.github),
    ),
  );

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
  pipe(
    O.fromNullable(ctx.idToNumber.get(depId)),
    O.map((b) => toDepPair(childNum, b, ctx.github)),
  );

type DepPair = ReturnType<typeof toDepPair>;

const extractDepLinks = (pairs: ReadonlyArray<DepPair>) =>
  pipe(
    pairs,
    RA.map((p) => p.link),
  );

const extractDepTasks = (pairs: ReadonlyArray<DepPair>) =>
  pipe(
    pairs,
    RA.map((p) => p.task),
  );

const collectDepLinks = (
  childNum: number,
  blockedBy: ReadonlyArray<string>,
  ctx: MaterializeContext,
) =>
  pipe(
    blockedBy,
    RA.filterMap((depId) => resolveDepPair(childNum, depId, ctx)),
    (pairs) => ({
      depLinks: extractDepLinks(pairs),
      tasks: extractDepTasks(pairs),
    }),
  );

const resolveParentId = (node: PlanIssueNode, epic: PlanManifest['epic']) =>
  pipe(
    O.fromNullable(node.parentId),
    O.alt(() => O.fromNullable(epic?.id)),
  );

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
  pipe(
    O.fromNullable(ctx.idToNumber.get(node.id)),
    O.match(
      () => ({
        subLinks: [] as ReadonlyArray<SubIssueLink>,
        depLinks: [] as ReadonlyArray<DependencyLink>,
        tasks: [] as ReadonlyArray<TE.TaskEither<DomainError, void>>,
      }),
      (childNum) => buildNodeLinks(childNum, node, epic, ctx),
    ),
  );

const chainTask = (
  acc: TE.TaskEither<DomainError, void>,
  task: TE.TaskEither<DomainError, void>,
) =>
  pipe(
    acc,
    TE.flatMap(() => task),
  );

const runSequentialTasks = (tasks: ReadonlyArray<TE.TaskEither<DomainError, void>>) =>
  pipe(tasks, RA.reduce(TE.right(undefined) as TE.TaskEither<DomainError, void>, chainTask));

const flattenTasks = (collected: ReadonlyArray<CollectedNodeLinks>) =>
  pipe(
    collected,
    RA.flatMap((c) => c.tasks),
  );

const flattenSubLinks = (collected: ReadonlyArray<CollectedNodeLinks>) =>
  pipe(
    collected,
    RA.flatMap((c) => c.subLinks),
  );

const flattenDepLinks = (collected: ReadonlyArray<CollectedNodeLinks>) =>
  pipe(
    collected,
    RA.flatMap((c) => c.depLinks),
  );

const executeCollectedLinks = (
  collected: ReadonlyArray<CollectedNodeLinks>,
  idToNumber: ReadonlyMap<string, number>,
) =>
  pipe(
    runSequentialTasks(flattenTasks(collected)),
    TE.map(() => ({
      createdIssues: Object.fromEntries(idToNumber.entries()),
      subIssueLinks: flattenSubLinks(collected),
      dependencyLinks: flattenDepLinks(collected),
    })),
  );

const linkAllNodes = (
  sorted: ReadonlyArray<PlanIssueNode>,
  epic: PlanManifest['epic'],
  ctx: MaterializeContext,
) =>
  pipe(
    sorted,
    RA.map((node) => collectLinksForNode(node, epic, ctx)),
    (collected) => executeCollectedLinks(collected, ctx.idToNumber),
  );

const materializeValidPlan = (
  validManifest: PlanManifest,
  github: GitHubPlannerPort,
) => {
  const sorted = topoSortPlan(validManifest);
  return pipe(
    createEpicIfPresent(validManifest.epic, github),
    TE.flatMap((epicMap) => createAllNodes(sorted, epicMap, github)),
    TE.flatMap((idToNumber) =>
      linkAllNodes(sorted, validManifest.epic, { github, idToNumber }),
    ),
  );
};

export function materializePlan(
  manifest: PlanManifest,
  github: GitHubPlannerPort,
) {
  return pipe(
    TE.fromEither(validatePlanDag(manifest)),
    TE.flatMap((validManifest) => materializeValidPlan(validManifest, github)),
  );
}
