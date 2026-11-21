import { pipe } from 'fp-ts/lib/function';
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

export function formatIssueBody(body: string): string {
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
): TE.TaskEither<DomainError, ReadonlyMap<string, number>> =>
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
): TE.TaskEither<DomainError, ReadonlyMap<string, number>> =>
  pipe(
    O.fromNullable(epic),
    O.match(
      () => TE.right(new Map<string, number>()),
      (e) => createEpicNode(e, github),
    ),
  );

const nodeLabels = (node: PlanIssueNode): ReadonlyArray<string> =>
  Array.from(
    new Set([
      isoLabelName.unwrap(TYPE_TO_LABEL[node.type]),
      isoLabelName.unwrap(AI_MANAGED_LABEL),
      ...node.labels,
    ]),
  );

const createSingleNode = (
  node: PlanIssueNode,
  idToNumber: ReadonlyMap<string, number>,
  github: GitHubPort,
): TE.TaskEither<DomainError, ReadonlyMap<string, number>> =>
  pipe(
    github.createIssue({ title: node.title, body: formatIssueBody(node.body), labels: nodeLabels(node) }),
    TE.chain((created) =>
      pipe(
        github.setIssueStatus(created.number, node.blockedBy.length > 0 ? 'blocked_dep' : 'ready'),
        TE.map(() => new Map(idToNumber).set(node.id, created.number)),
      ),
    ),
  );

const createAllNodes = (
  sorted: ReadonlyArray<PlanIssueNode>,
  initialMap: ReadonlyMap<string, number>,
  github: GitHubPort,
): TE.TaskEither<DomainError, ReadonlyMap<string, number>> =>
  pipe(
    sorted,
    RA.reduce(TE.right<DomainError, ReadonlyMap<string, number>>(initialMap), (acc, node) =>
      pipe(
        acc,
        TE.chain((map) => createSingleNode(node, map, github)),
      ),
    ),
  );

type NodeLinks = {
  readonly subLinks: ReadonlyArray<SubIssueLink>;
  readonly depLinks: ReadonlyArray<DependencyLink>;
  readonly tasks: ReadonlyArray<TE.TaskEither<DomainError, void>>;
};

const collectParentLink = (
  childNum: number,
  parentId: O.Option<string>,
  idToNumber: ReadonlyMap<string, number>,
  github: GitHubPort,
): { readonly subLinks: ReadonlyArray<SubIssueLink>; readonly tasks: ReadonlyArray<TE.TaskEither<DomainError, void>> } =>
  pipe(
    parentId,
    O.chain((id) => O.fromNullable(idToNumber.get(id))),
    O.match(
      () => ({ subLinks: [], tasks: [] }),
      (parentNum) => ({
        subLinks: [{ parent: isoIssueNumber.wrap(parentNum), child: isoIssueNumber.wrap(childNum) }],
        tasks: [github.addSubIssue(parentNum, childNum)],
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
): { readonly depLinks: ReadonlyArray<DependencyLink>; readonly tasks: ReadonlyArray<TE.TaskEither<DomainError, void>> } =>
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

const mergeNodeLinks = (
  parent: { readonly subLinks: ReadonlyArray<SubIssueLink>; readonly tasks: ReadonlyArray<TE.TaskEither<DomainError, void>> },
  deps: { readonly depLinks: ReadonlyArray<DependencyLink>; readonly tasks: ReadonlyArray<TE.TaskEither<DomainError, void>> },
): NodeLinks => ({
  subLinks: parent.subLinks,
  depLinks: deps.depLinks,
  tasks: [...parent.tasks, ...deps.tasks],
});

const collectLinksForNode = (
  node: PlanIssueNode,
  epicId: O.Option<string>,
  idToNumber: ReadonlyMap<string, number>,
  github: GitHubPort,
): NodeLinks =>
  pipe(
    O.fromNullable(idToNumber.get(node.id)),
    O.match(
      (): NodeLinks => ({ subLinks: [], depLinks: [], tasks: [] }),
      (childNum): NodeLinks =>
        mergeNodeLinks(
          collectParentLink(childNum, pipe(O.fromNullable(node.parentId), O.alt(() => epicId)), idToNumber, github),
          collectDepLinks(childNum, node.blockedBy, idToNumber, github),
        ),
    ),
  );

const runSequentialTasks = (
  tasks: ReadonlyArray<TE.TaskEither<DomainError, void>>,
): TE.TaskEither<DomainError, void> =>
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
  epicId: O.Option<string>,
  idToNumber: ReadonlyMap<string, number>,
  github: GitHubPort,
): TE.TaskEither<DomainError, MaterializedPlanResult> =>
  pipe(
    sorted,
    RA.map((node) => collectLinksForNode(node, epicId, idToNumber, github)),
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
): TE.TaskEither<DomainError, MaterializedPlanResult> =>
  pipe(
    createEpicIfPresent(validManifest.epic, github),
    TE.chain((epicMap) => createAllNodes(topoSortPlan(validManifest), epicMap, github)),
    TE.chain((idToNumber) =>
      linkAllNodes(topoSortPlan(validManifest), O.fromNullable(validManifest.epic?.id), idToNumber, github),
    ),
  );

export function materializePlan(
  manifest: PlanManifest,
  github: GitHubPort,
): TE.TaskEither<DomainError, MaterializedPlanResult> {
  return pipe(
    TE.fromEither(validatePlanDag(manifest)),
    TE.chain((validManifest) => materializeValidPlan(validManifest, github)),
  );
}
