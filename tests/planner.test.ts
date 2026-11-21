import * as E from 'fp-ts/lib/Either';
import { pipe } from 'fp-ts/lib/function';
import * as RA from 'fp-ts/lib/ReadonlyArray';
import * as TE from 'fp-ts/lib/TaskEither';
import { describe, expect, it } from 'vitest';
import type { GitHubPort } from '../src/adapters/github/types.js';
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
  priority: p1
issues:
  - id: story-core
    title: "Core Token Service"
    type: story
    priority: p1
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
    if (E.isLeft(parsed)) return;

    expect(pipe(parsed.right, validatePlanDag, E.isRight)).toBe(true);

    const ids = pipe(
      topoSortPlan(parsed.right),
      RA.map((n) => n.id),
    );
    expect(ids.indexOf('story-core')).toBeLessThan(ids.indexOf('task-jwt'));
    expect(ids.indexOf('task-jwt')).toBeLessThan(ids.indexOf('task-middleware'));
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
    if (E.isLeft(parsed)) return;

    const validated = validatePlanDag(parsed.right);
    expect(E.isLeft(validated)).toBe(true);
    if (E.isLeft(validated)) {
      expect(validated.left.type).toBe('PLAN_VALIDATION_ERROR');
    }
  });

  it('materializes issues, sub-issues, and blocked_by links via GitHubPort', async () => {
    const parsed = parsePlanManifest(VALID_PLAN_YAML);
    expect(E.isRight(parsed)).toBe(true);
    if (E.isLeft(parsed)) return;

    let nextNum = 10;
    let createdBodies: ReadonlyArray<{ readonly title: string; readonly body: string }> = [];
    let subLinks: ReadonlyArray<readonly [number, number]> = [];
    let depLinks: ReadonlyArray<readonly [number, number]> = [];
    let statusUpdates: ReadonlyArray<readonly [number, string]> = [];

    const res = await materializePlan(parsed.right, {
      createIssue: (input) => {
        createdBodies = [...createdBodies, { title: input.title, body: input.body }];
        const num = nextNum++;
        return TE.right({ number: num, url: `https://github.com/o/r/issues/${String(num)}` });
      },
      setIssueStatus: (issueNumber, status) => {
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
    if (E.isRight(res)) {
      expect(Object.keys(res.right.createdIssues)).toHaveLength(4);
      expect(statusUpdates).toHaveLength(4);
      expect(subLinks).toHaveLength(3);
      expect(depLinks).toHaveLength(1);
      expect(createdBodies).toHaveLength(4);
      pipe(
        createdBodies,
        RA.map((created) => {
          expect(created.body).toContain('declarative programming style');
          expect(created.body).toContain('TypeScript type-driven development');
          expect(created.body).toContain('functional programming style');
          return undefined;
        }),
      );
      expect(createdBodies[0]?.body).toBe(`End-to-end auth\n\n${ISSUE_DEVELOPMENT_STANDARDS}`);
      expect(createdBodies[1]?.body).toBe(ISSUE_DEVELOPMENT_STANDARDS);
    }
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
