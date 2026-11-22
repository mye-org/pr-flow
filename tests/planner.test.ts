import * as E from 'fp-ts/lib/Either';
import { flow } from 'fp-ts/lib/function';
import * as RA from 'fp-ts/lib/ReadonlyArray';
import * as TE from 'fp-ts/lib/TaskEither';
import { match } from 'ts-pattern';
import { describe, expect, it } from 'vitest';
import type { CreateIssueInput, GitHubPort } from '../src/adapters/github/types.js';
import { parsePlanManifest } from '../src/domain/plan.js';
import {
  formatIssueBody,
  ISSUE_DEVELOPMENT_STANDARDS,
  materializePlan,
} from '../src/planner/materialize.js';
import { topoSortPlan } from '../src/planner/topoSort.js';
import { validatePlanDag } from '../src/planner/validateDag.js';

const VALID_PLAN_YAML = `version: 1
epic:
  id: epic-auth
  title: "Authentication System"
  body: "End-to-end auth"
issues:
  - id: story-core
    title: "Core Token Service"
    type: story
  - id: task-jwt
    title: "Implement JWT signing"
    type: task
    parentId: story-core
  - id: task-middleware
    title: "Add auth middleware"
    type: task
    parentId: story-core
    blockedBy:
      - task-jwt
`;

describe('planner DAG validation & topoSort', () => {
  it('parses, validates, and topologically sorts a valid plan manifest', () => {
    const parsed = parsePlanManifest(VALID_PLAN_YAML);
    expect(E.isRight(parsed)).toBe(true);
    match(parsed)
      .with({ _tag: 'Right' }, ({ right }) => {
        expect(flow(validatePlanDag, E.isRight)(right)).toBe(true);

        const ids = flow(
          topoSortPlan,
          RA.map((n) => n.id),
        )(right);
        expect(ids.indexOf('story-core')).toBeLessThan(ids.indexOf('task-jwt'));
        expect(ids.indexOf('task-jwt')).toBeLessThan(ids.indexOf('task-middleware'));
      })
      .with({ _tag: 'Left' }, () => {
        expect.unreachable('Expected Right');
      })
      .exhaustive();
  });

  it('rejects dependency cycles', () => {
    const parsed = parsePlanManifest(`version: 1
issues:
  - id: a
    title: A
    type: task
    blockedBy: [b]
  - id: b
    title: B
    type: task
    blockedBy: [a]
`);
    expect(E.isRight(parsed)).toBe(true);
    match(parsed)
      .with({ _tag: 'Right' }, ({ right }) => {
        const validated = validatePlanDag(right);
        expect(E.isLeft(validated)).toBe(true);
        match(validated)
          .with({ _tag: 'Left' }, ({ left }) => {
            expect(left.type).toBe('PLAN_VALIDATION_ERROR');
          })
          .with({ _tag: 'Right' }, () => {
            expect.unreachable('Expected Left');
          })
          .exhaustive();
      })
      .with({ _tag: 'Left' }, () => {
        expect.unreachable('Expected Right');
      })
      .exhaustive();
  });

  it('rejects self-parenting and parentId/blockedBy cycles', () => {
    const selfParent = parsePlanManifest(`version: 1
issues:
  - id: a
    title: A
    type: story
    parentId: a
`);
    expect(E.isRight(selfParent)).toBe(true);
    match(selfParent)
      .with({ _tag: 'Right' }, ({ right }) => {
        expect(flow(validatePlanDag, E.isLeft)(right)).toBe(true);
      })
      .with({ _tag: 'Left' }, () => {
        expect.unreachable('Expected Right');
      })
      .exhaustive();

    const parentCycle = parsePlanManifest(`version: 1
issues:
  - id: a
    title: A
    type: story
    parentId: b
  - id: b
    title: B
    type: story
    parentId: a
`);
    expect(E.isRight(parentCycle)).toBe(true);
    match(parentCycle)
      .with({ _tag: 'Right' }, ({ right }) => {
        expect(flow(validatePlanDag, E.isLeft)(right)).toBe(true);
      })
      .with({ _tag: 'Left' }, () => {
        expect.unreachable('Expected Right');
      })
      .exhaustive();

    const crossCycle = parsePlanManifest(`version: 1
issues:
  - id: story-a
    title: Story A
    type: story
    blockedBy: [task-b]
  - id: task-b
    title: Task B
    type: task
    parentId: story-a
`);
    expect(E.isRight(crossCycle)).toBe(true);
    match(crossCycle)
      .with({ _tag: 'Right' }, ({ right }) => {
        expect(flow(validatePlanDag, E.isLeft)(right)).toBe(true);
      })
      .with({ _tag: 'Left' }, () => {
        expect.unreachable('Expected Right');
      })
      .exhaustive();
  });

  it('materializes issues, sub-issues, and blocked_by links via GitHubPort', async () => {
    const parsed = parsePlanManifest(VALID_PLAN_YAML);
    expect(E.isRight(parsed)).toBe(true);
    await match(parsed)
      .with({ _tag: 'Right' }, async ({ right: manifest }) => {
        let nextNum = 10;
        let createdBodies: ReadonlyArray<Pick<CreateIssueInput, 'title' | 'body'>> = [];
        let subLinks: ReadonlyArray<readonly [number, number]> = [];
        let depLinks: ReadonlyArray<readonly [number, number]> = [];
        let statusUpdates: ReadonlyArray<readonly [number, string]> = [];

        const res = await materializePlan(manifest, {
          createIssue: (input) => {
            createdBodies = [...createdBodies, { title: input.title, body: input.body }];
            const num = nextNum++;
            return TE.right({ number: num, url: `https://github.com/o/r/issues/${String(num)}` });
          },
          updateIssueStatus: (issueNumber, status) => {
            statusUpdates = [...statusUpdates, [issueNumber, status]];
            return TE.right(undefined);
          },
          addSubIssue: (parent, child) => {
            subLinks = [...subLinks, [parent, child]];
            return TE.right(undefined);
          },
          addBlockedBy: (issue, blocker) => {
            depLinks = [...depLinks, [issue, blocker]];
            return TE.right(undefined);
          },
        } as Partial<GitHubPort> as GitHubPort)();

        expect(E.isRight(res)).toBe(true);
        match(res)
          .with({ _tag: 'Right' }, ({ right }) => {
            expect(Object.keys(right.createdIssues)).toHaveLength(4);
            expect(statusUpdates).toEqual([
              [10, 'backlog'],
              [11, 'backlog'],
              [12, 'ready'],
              [13, 'blocked_dep'],
            ]);
            expect(subLinks).toHaveLength(3);
            expect(depLinks).toHaveLength(1);
            expect(createdBodies).toHaveLength(4);
            RA.map((created: Pick<CreateIssueInput, 'title' | 'body'>) => {
              expect(created.body).toContain('declarative programming style');
              expect(created.body).toContain('TypeScript type-driven development');
              expect(created.body).toContain('functional programming style');
              return undefined;
            })(createdBodies);
            expect(createdBodies[0]?.body).toBe(`End-to-end auth\n\n${ISSUE_DEVELOPMENT_STANDARDS}`);
            expect(createdBodies[1]?.body).toBe(ISSUE_DEVELOPMENT_STANDARDS);
          })
          .with({ _tag: 'Left' }, () => {
            expect.unreachable('Expected Right');
          })
          .exhaustive();
      })
      .with({ _tag: 'Left' }, () => {
        expect.unreachable('Expected Right');
      })
      .exhaustive();
  });

  it('formatIssueBody appends standards without duplicating existing sections', () => {
    expect(formatIssueBody('')).toBe(ISSUE_DEVELOPMENT_STANDARDS);
    expect(formatIssueBody('  ## Acceptance Criteria\n- Test  ')).toBe(
      `## Acceptance Criteria\n- Test\n\n${ISSUE_DEVELOPMENT_STANDARDS}`,
    );
    const alreadyFormatted = `## Goal\nDo thing\n\n${ISSUE_DEVELOPMENT_STANDARDS}`;
    expect(formatIssueBody(alreadyFormatted)).toBe(alreadyFormatted);
  });
});
