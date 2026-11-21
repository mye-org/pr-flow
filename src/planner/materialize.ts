import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import type { GitHubPort } from '../adapters/github/types.js';
import type { DomainError } from '../domain/errors.js';
import {
  AI_MANAGED_LABEL,
  TYPE_TO_LABEL,
} from '../domain/issue.js';
import type { PlanManifest } from '../domain/plan.js';
import { topoSortPlan } from './topoSort.js';
import { validatePlanDag } from './validateDag.js';

export interface MaterializedPlanResult {
  createdIssues: Record<string, number>;
  subIssueLinks: Array<{ parent: number; child: number }>;
  dependencyLinks: Array<{ issue: number; blockedBy: number }>;
}

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

export function materializePlan(
  manifest: PlanManifest,
  github: GitHubPort,
): TE.TaskEither<DomainError, MaterializedPlanResult> {
  return pipe(
    TE.fromEither(validatePlanDag(manifest)),
    TE.chain((validManifest) => {
      const sorted = topoSortPlan(validManifest);
      const idToNumber = new Map<string, number>();
      const subIssueLinks: Array<{ parent: number; child: number }> = [];
      const dependencyLinks: Array<{ issue: number; blockedBy: number }> = [];

      const createEpicIfPresent: TE.TaskEither<DomainError, void> = validManifest.epic
        ? pipe(
            github.createIssue({
              title: validManifest.epic.title,
              body: formatIssueBody(validManifest.epic.body),
              labels: [
                TYPE_TO_LABEL.epic,
                AI_MANAGED_LABEL,
              ],
            }),
            TE.chain((created) => {
              idToNumber.set(validManifest.epic!.id, created.number);
              return github.setIssueStatus(created.number, 'backlog');
            }),
          )
        : TE.right(undefined);

      return pipe(
        createEpicIfPresent,
        TE.chain(() =>
          sorted.reduce<TE.TaskEither<DomainError, void>>(
            (acc, node) =>
              pipe(
                acc,
                TE.chain(() => {
                  const initialStatus = node.blockedBy.length > 0 ? 'blocked_dep' : 'ready';
                  const labels = Array.from(
                    new Set([
                      TYPE_TO_LABEL[node.type],
                      AI_MANAGED_LABEL,
                      ...node.labels,
                    ]),
                  );
                  return pipe(
                    github.createIssue({
                      title: node.title,
                      body: formatIssueBody(node.body),
                      labels,
                    }),
                    TE.chain((created) => {
                      idToNumber.set(node.id, created.number);
                      return github.setIssueStatus(created.number, initialStatus);
                    }),
                  );
                }),
              ),
            TE.right(undefined),
          ),
        ),
        TE.chain(() => {
          const linkTasks: Array<TE.TaskEither<DomainError, void>> = [];

          for (const node of sorted) {
            const childNum = idToNumber.get(node.id);
            if (!childNum) continue;

            const parentId = node.parentId ?? validManifest.epic?.id;
            if (parentId) {
              const parentNum = idToNumber.get(parentId);
              if (parentNum) {
                subIssueLinks.push({ parent: parentNum, child: childNum });
                linkTasks.push(github.addSubIssue(parentNum, childNum));
              }
            }

            for (const depId of node.blockedBy) {
              const blockerNum = idToNumber.get(depId);
              if (blockerNum) {
                dependencyLinks.push({ issue: childNum, blockedBy: blockerNum });
                linkTasks.push(github.addBlockedBy(childNum, blockerNum));
              }
            }
          }

          return linkTasks.reduce<TE.TaskEither<DomainError, void>>(
            (acc, task) => pipe(acc, TE.chain(() => task)),
            TE.right(undefined),
          );
        }),
        TE.map(() => ({
          createdIssues: Object.fromEntries(idToNumber.entries()),
          subIssueLinks,
          dependencyLinks,
        })),
      );
    }),
  );
}
