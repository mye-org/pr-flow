import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { describe, expect, it } from 'vitest';
import type { GitHubPort } from '../src/adapters/github/types.js';
import { parsePlanManifest } from '../src/domain/plan.js';
import { materializePlan } from '../src/planner/materialize.js';
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

    const validated = validatePlanDag(parsed.right);
    expect(E.isRight(validated)).toBe(true);

    const sorted = topoSortPlan(parsed.right);
    const ids = sorted.map((n) => n.id);
    expect(ids.indexOf('story-core')).toBeLessThan(ids.indexOf('task-jwt'));
    expect(ids.indexOf('task-jwt')).toBeLessThan(ids.indexOf('task-middleware'));
  });

  it('rejects dependency cycles', () => {
    const cyclic = `version: 1
issues:
  - id: a
    title: A
    type: task
    blockedBy: [b]
  - id: b
    title: B
    type: task
    blockedBy: [a]
`;
    const parsed = parsePlanManifest(cyclic);
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
    const subLinks: Array<[number, number]> = [];
    const depLinks: Array<[number, number]> = [];

    const mockGitHub: Partial<GitHubPort> = {
      createIssue: () => {
        const num = nextNum++;
        return TE.right({ number: num, url: `https://github.com/o/r/issues/${num}` });
      },
      addSubIssue: (parent, child) => {
        subLinks.push([parent, child]);
        return TE.right(undefined);
      },
      addBlockedBy: (issue, blocker) => {
        depLinks.push([issue, blocker]);
        return TE.right(undefined);
      },
    };

    const res = await materializePlan(parsed.right, mockGitHub as GitHubPort)();
    expect(E.isRight(res)).toBe(true);
    if (E.isRight(res)) {
      expect(Object.keys(res.right.createdIssues)).toHaveLength(4);
      expect(subLinks).toHaveLength(3);
      expect(depLinks).toHaveLength(1);
    }
  });
});
