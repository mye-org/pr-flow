import { flow, pipe } from 'fp-ts/lib/function';
import * as O from 'fp-ts/lib/Option';
import * as RA from 'fp-ts/lib/ReadonlyArray';
import * as TE from 'fp-ts/lib/TaskEither';
import type { GitHubPort } from '../adapters/github/types.js';
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
  if (trimmed.includes('## Development Standards')) {
    return trimmed;
  }
  return trimmed.length > 0
    ? `${trimmed}\n\n${ISSUE_DEVELOPMENT_STANDARDS}`
    : ISSUE_DEVELOPMENT_STANDARDS;
}

const createEpicNode = (
  epic: NonNullable<PlanManifest['epic']>,
  github: GitHubPort,
) =>
  pipe(
    github.createIssue({
      title: epic.title,
      body: formatIssueBody(epic.body),
      labels: [isoLabelName.unwrap(TYPE_TO_LABEL.epic), isoLabelName.unwrap(AI_MANAGED_LABEL)],
    }),
    TE.chain((created) =>
      pipe(
        github.setIssueStatus(created.number, 'backlog'),
        TE.map(() => new Map<string, number>([[epic.id, created.number]])),
      ),
    ),
  );

const createEpicIfPresent = (
  epic: PlanManifest['epic'],
  github: GitHubPort,
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
) => {
  if (node.type === 'epic' || parentIds.has(node.id)) {
    return 'backlog' as const;
  }
  return node.blockedBy.length > 0 ? ('blocked_dep' as const) : ('ready' as const);
};

const createSingleNode = (
  node: PlanIssueNode,
  idToNumber: ReadonlyMap<string, number>,
  parentIds: ReadonlySet<string>,
  github: GitHubPort,
) =>
  pipe(
    github.createIssue({ title: node.title, body: formatIssueBody(node.body), labels: nodeLabels(node) }),
    TE.chain((created) =>
      pipe(
        github.setIssueStatus(created.number, initialStatusForNode(node, parentIds)),
        TE.map(() => new Map(idToNumber).set(node.id, created.number)),
      ),
    ),
  );

const createAllNodes = (
  sorted: ReadonlyArray<PlanIssueNode>,
  initialMap: ReadonlyMap<string, number>,
  github: GitHubPort,
) =>
  pipe(collectParentIds(sorted), (parentIds) =>
    pipe(
      sorted,
      RA.reduce(TE.right<DomainError, ReadonlyMap<string, number>>(initialMap), (acc, node) =>
        pipe(
          acc,
          TE.chain((map) => createSingleNode(node, map, parentIds, github)),
        ),
      ),
    ),
  );

const collectParentLink = (
  childNum: number,
  parentId: O.Option<string>,
  idToNumber: ReadonlyMap<string, number>,
  github: GitHubPort,
) =>
  pipe(
    parentId,
    O.chain(flow((id: string) => idToNumber.get(id), O.fromNullable)),
    O.match(
      () => ({ subLinks: [] as ReadonlyArray<SubIssueLink>, tasks: [] as ReadonlyArray<TE.TaskEither<DomainError, void>> }),
      (parentNum) => ({
        subLinks: [{ parent: isoIssueNumber.wrap(parentNum), child: isoIssueNumber.wrap(childNum) }] as ReadonlyArray<SubIssueLink>,
        tasks: [github.addSubIssue(parentNum, childNum)] as ReadonlyArray<TE.TaskEither<DomainError, void>>,
      }),
    ),
  );

const toDepPair = (
  childNum: number,
  blockerNum: number,
  github: GitHubPort,
) => ({
  link: { issue: isoIssueNumber.wrap(childNum), blockedBy: isoIssueNumber.wrap(blockerNum) },
  task: github.addBlockedBy(childNum, blockerNum),
});

const collectDepLinks = (
  childNum: number,
  blockedBy: ReadonlyArray<string>,
  idToNumber: ReadonlyMap<string, number>,
  github: GitHubPort,
) =>
  pipe(
    blockedBy,
    RA.filterMap((depId) =>
      pipe(O.fromNullable(idToNumber.get(depId)), O.map((b) => toDepPair(childNum, b, github))),
    ),
    (pairs) => ({
      depLinks: pipe(pairs, RA.map((p) => p.link)),
      tasks: pipe(pairs, RA.map((p) => p.task)),
    }),
  );

const buildNodeLinks = (
  childNum: number,
  node: PlanIssueNode,
  epic: PlanManifest['epic'],
  idToNumber: ReadonlyMap<string, number>,
  github: GitHubPort,
) => {
  const parent = collectParentLink(
    childNum,
    pipe(O.fromNullable(node.parentId), O.alt(() => O.fromNullable(epic?.id))),
    idToNumber,
    github,
  );
  const deps = collectDepLinks(childNum, node.blockedBy, idToNumber, github);
  return {
    subLinks: parent.subLinks,
    depLinks: deps.depLinks,
    tasks: [...parent.tasks, ...deps.tasks],
  };
};

const collectLinksForNode = (
  node: PlanIssueNode,
  epic: PlanManifest['epic'],
  idToNumber: ReadonlyMap<string, number>,
  github: GitHubPort,
) =>
  pipe(
    O.fromNullable(idToNumber.get(node.id)),
    O.match(
      () => ({
        subLinks: [] as ReadonlyArray<SubIssueLink>,
        depLinks: [] as ReadonlyArray<DependencyLink>,
        tasks: [] as ReadonlyArray<TE.TaskEither<DomainError, void>>,
      }),
      (childNum) => buildNodeLinks(childNum, node, epic, idToNumber, github),
    ),
  );

const runSequentialTasks = (
  tasks: ReadonlyArray<TE.TaskEither<DomainError, void>>,
) =>
  pipe(
    tasks,
    RA.reduce(TE.right(undefined) as TE.TaskEither<DomainError, void>, (acc, task) =>
      pipe(
        acc,
        TE.chain(() => task),
      ),
    ),
  );

const linkAllNodes = (
  sorted: ReadonlyArray<PlanIssueNode>,
  epic: PlanManifest['epic'],
  idToNumber: ReadonlyMap<string, number>,
  github: GitHubPort,
) =>
  pipe(
    sorted,
    RA.map((node) => collectLinksForNode(node, epic, idToNumber, github)),
    (collected) =>
      pipe(
        runSequentialTasks(pipe(collected, RA.chain((c) => c.tasks))),
        TE.map(() => ({
          createdIssues: Object.fromEntries(idToNumber.entries()),
          subIssueLinks: pipe(collected, RA.chain((c) => c.subLinks)),
          dependencyLinks: pipe(collected, RA.chain((c) => c.depLinks)),
        })),
      ),
  );

const materializeValidPlan = (
  validManifest: PlanManifest,
  github: GitHubPort,
) => {
  const sorted = topoSortPlan(validManifest);
  return pipe(
    createEpicIfPresent(validManifest.epic, github),
    TE.chain((epicMap) => createAllNodes(sorted, epicMap, github)),
    TE.chain((idToNumber) => linkAllNodes(sorted, validManifest.epic, idToNumber, github)),
  );
};

export function materializePlan(
  manifest: PlanManifest,
  github: GitHubPort,
) {
  return pipe(
    TE.fromEither(validatePlanDag(manifest)),
    TE.chain((validManifest) => materializeValidPlan(validManifest, github)),
  );
}
