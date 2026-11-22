import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Octokit } from '@octokit/rest';
import * as E from 'fp-ts/lib/Either';
import { flow, pipe } from 'fp-ts/lib/function';
import * as RA from 'fp-ts/lib/ReadonlyArray';
import { match } from 'ts-pattern';
import { describe, expect, it, vi } from 'vitest';
import { createOctokitGitHubAdapter } from '../src/adapters/github/client.js';
import { generateInitFiles } from '../src/cli/init.js';
import { parseConfig } from '../src/domain/config.js';
import { isoHexColor, isoLabelName, isoMessage } from '../src/domain/newtypes.js';

function createMockOctokitAdapter(owner = 'mye-org', repo = 'pr-flow-demo') {
  const graphql = vi.fn();
  const request = vi.fn();
  const listReviews = vi.fn();
  const listReviewComments = vi.fn();
  const listComments = vi.fn();

  return {
    adapter: createOctokitGitHubAdapter({
      token: 'test-token',
      owner,
      repo,
      octokit: Object.assign(new Octokit({ auth: 'test-token' }), {
        graphql,
        request,
        paginate: vi.fn(),
        rest: {
          pulls: { listReviews, listReviewComments },
          issues: { listLabelsForRepo: vi.fn(), listComments },
          actions: {},
        },
      }),
    }),
    graphql,
    request,
    listReviews,
    listReviewComments,
    listComments,
  };
}

describe('parseConfig', () => {
  it('parses valid config with defaults', () => {
    const res = parseConfig(`version: 1
workspace:
  verifyCommand: "npm test"
`);
    expect(E.isRight(res)).toBe(true);
    match(res)
      .with({ _tag: 'Right' }, ({ right: cfg }) => {
        const agent = cfg.agent;
        expect(cfg.wipLimit).toBe(4);
        expect(cfg.baseBranch).toBe('main');
        expect(cfg.statusFieldName).toBe('pr-flow-status');
        expect(agent.provider).toBe('gemini');
        expect(agent.fallbackModels).toEqual([]);
        expect(agent.maxRetries).toBe(3);
        expect(agent.maxVerifyRetries).toBe(10);
        expect(agent.maxSessionTurns).toBe(25);
        expect(agent.compressionThreshold).toBe(0.2);
        expect(cfg.triggers.reviewMode).toBe('changes_requested');
      })
      .with({ _tag: 'Left' }, () => {
        expect.unreachable('Expected Right');
      })
      .exhaustive();
  });

  it('rejects custom provider without agent.command', () => {
    expect(
      pipe(
        parseConfig(`version: 1
workspace:
  verifyCommand: "pytest"
agent:
  provider: custom
`),
        E.isLeft,
      ),
    ).toBe(true);
  });
});

describe('generateInitFiles', () => {
  it('creates target repo footprint and respects force flag', () => {
    const tmpDir = pipe(path.join(os.tmpdir(), 'pr-flow-init-'), (prefix: string) =>
      fs.mkdtempSync(prefix),
    );
    const hasFile = (rel: string) => pipe(path.join(tmpDir, rel), fs.existsSync);
    const readFile = flow(
      (rel: string) => path.join(tmpDir, rel),
      (p) => fs.readFileSync(p, 'utf-8'),
    );
    try {
      const first = generateInitFiles({
        targetDir: tmpDir,
        prFlowOwner: 'mingqianye',
        prFlowRef: 'v1',
        baseBranch: 'main',
        wipLimit: 4,
        setupCommand: 'npm ci',
        verifyCommand: 'npm run verify',
        reviewMode: 'changes_requested',
        force: false,
      });
      expect(first.written).toHaveLength(7);
      expect(first.skipped).toHaveLength(0);
      expect(hasFile('pr-flow.config.yml')).toBe(true);
      expect(hasFile('AGENTS.md')).toBe(true);
      expect(hasFile('.agents/skills/pr-flow/SKILL.md')).toBe(true);
      expect(hasFile('.github/workflows/pr-flow-implement.yml')).toBe(true);
      expect(readFile('.github/workflows/pr-flow-implement.yml')).toContain('field_added');
      expect(readFile('.github/workflows/pr-flow-sync.yml')).toContain('field_added');
      expect(readFile('.github/workflows/pr-flow-sync.yml')).toContain('field_removed');
      const generatedAgents = readFile('AGENTS.md');
      expect(generatedAgents).toContain('.agents/skills/pr-flow/SKILL.md');
      expect(generatedAgents).not.toContain('For CI Execution Agents');
      const generatedSkill = readFile('.agents/skills/pr-flow/SKILL.md');
      expect(generatedSkill).toContain('[WIP]` draft PR');
      expect(generatedSkill).toContain('status set --issue');
      expect(generatedSkill).toContain('--request-changes');

      const second = generateInitFiles({
        targetDir: tmpDir,
        prFlowOwner: 'mye-org',
        prFlowRef: 'v1',
        baseBranch: 'main',
        wipLimit: 4,
        setupCommand: 'npm ci',
        verifyCommand: 'npm run verify',
        reviewMode: 'changes_requested',
        force: false,
      });
      expect(second.written).toHaveLength(0);
      expect(second.skipped).toHaveLength(7);

      generateInitFiles({
        targetDir: tmpDir,
        prFlowOwner: 'mye-org',
        prFlowRef: 'v1',
        baseBranch: 'main',
        wipLimit: 4,
        setupCommand: 'npm ci',
        verifyCommand: 'npm run verify',
        reviewMode: 'both',
        force: true,
      });
      const reviewYml = readFile('.github/workflows/pr-flow-review.yml');
      expect(reviewYml).toContain('issue_comment:');
      expect(reviewYml).toContain("review.state == 'commented'");
      expect(reviewYml).toContain("review.state == 'changes_requested'");
      expect(readFile('.agents/skills/pr-flow/SKILL.md')).toContain('reviewMode: both');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('createOctokitGitHubAdapter.ensureStatusField', () => {
  it('succeeds via GraphQL without calling org REST API when pr-flow-status already exists', async () => {
    const { adapter, graphql, request } = createMockOctokitAdapter();
    graphql.mockResolvedValueOnce({
      repository: {
        issueFields: {
          nodes: [
            {
              __typename: 'IssueFieldSingleSelect',
              id: 'IFSS_123',
              name: 'pr-flow-status',
              options: [
                { id: 'opt1', name: 'backlog' },
                { id: 'opt2', name: 'blocked-dep' },
                { id: 'opt3', name: 'ready' },
                { id: 'opt4', name: 'in-progress' },
                { id: 'opt5', name: 'review-pending' },
                { id: 'opt6', name: 'fixed' },
                { id: 'opt7', name: 'needs-human' },
              ],
            },
          ],
        },
      },
    });

    expect(E.isRight(await adapter.ensureStatusField()())).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(request.mock.calls).toHaveLength(0);
  });

  it('returns actionable remediation instructions on HTTP 403 when field does not exist', async () => {
    const { adapter, graphql, request } = createMockOctokitAdapter();
    graphql.mockResolvedValueOnce({
      repository: { issueFields: { nodes: [] } },
    });
    request.mockRejectedValueOnce(
      Object.assign(new Error('Resource not accessible by integration'), { status: 403 }),
    );

    const res = await adapter.ensureStatusField()();
    expect(E.isLeft(res)).toBe(true);
    match(res)
      .with({ _tag: 'Left' }, ({ left }) => {
        expect(left.type).toBe('GITHUB_API_ERROR');
        expect(isoMessage.unwrap(left.message)).toContain('HTTP 403');
        expect(isoMessage.unwrap(left.message)).toContain('fields sync --repo mye-org/pr-flow-demo');
        expect(isoMessage.unwrap(left.message)).toContain(
          'https://github.com/organizations/mye-org/settings/issue-fields',
        );
      })
      .with({ _tag: 'Right' }, () => {
        expect.unreachable('Expected Left GITHUB_API_ERROR');
      })
      .exhaustive();
  });

  it('returns organization hint on HTTP 404 when field does not exist', async () => {
    const { adapter, graphql, request } = createMockOctokitAdapter('personal-user', 'demo');
    graphql.mockResolvedValueOnce({
      repository: { issueFields: { nodes: [] } },
    });
    request.mockRejectedValueOnce(
      Object.assign(new Error('Not Found'), { status: 404 }),
    );

    const res = await adapter.ensureStatusField()();
    expect(E.isLeft(res)).toBe(true);
    match(res)
      .with({ _tag: 'Left' }, ({ left }) => {
        expect(left.type).toBe('GITHUB_API_ERROR');
        expect(isoMessage.unwrap(left.message)).toContain('HTTP 404');
        expect(isoMessage.unwrap(left.message)).toContain('GitHub Organization');
      })
      .with({ _tag: 'Right' }, () => {
        expect.unreachable('Expected Left GITHUB_API_ERROR');
      })
      .exhaustive();
  });
});

describe('createOctokitGitHubAdapter.checkSetupPrerequisites', () => {
  it('reports pass for all checks when repo and org are properly configured', async () => {
    const { adapter, graphql, request } = createMockOctokitAdapter();

    request.mockImplementation((route: string) =>
      match(route)
        .with('GET /repos/{owner}/{repo}', () => Promise.resolve({ data: { private: false } }))
        .with('GET /repos/{owner}/{repo}/actions/permissions/workflow', () =>
          Promise.resolve({ data: { can_approve_pull_request_reviews: true } }),
        )
        .with('GET /repos/{owner}/{repo}/labels', () =>
          Promise.resolve({ data: [{ name: 'type:epic' }, { name: 'type:task' }] }),
        )
        .with('GET /repos/{owner}/{repo}/actions/secrets/{secret_name}', () =>
          Promise.resolve({ data: { name: 'GEMINI_API_KEY' } }),
        )
        .otherwise(() => Promise.reject(new Error(`Unexpected route: ${route}`))),
    );

    graphql.mockResolvedValueOnce({
      repository: {
        issueFields: {
          nodes: [
            {
              __typename: 'IssueFieldSingleSelect',
              id: 'IFSS_123',
              name: 'pr-flow-status',
              options: [
                { id: 'opt1', name: 'backlog' },
                { id: 'opt2', name: 'blocked-dep' },
                { id: 'opt3', name: 'ready' },
                { id: 'opt4', name: 'in-progress' },
                { id: 'opt5', name: 'review-pending' },
                { id: 'opt6', name: 'fixed' },
                { id: 'opt7', name: 'needs-human' },
              ],
            },
          ],
        },
      },
    });

    const res = await adapter.checkSetupPrerequisites({
      prFlowOwner: 'mye-org',
      expectedLabels: [
        {
          name: isoLabelName.wrap('type:epic'),
          color: isoHexColor.wrap('3e4b9e'),
          description: isoMessage.wrap('Epic'),
        },
        {
          name: isoLabelName.wrap('type:task'),
          color: isoHexColor.wrap('006b75'),
          description: isoMessage.wrap('Task'),
        },
      ],
    })();

    expect(E.isRight(res)).toBe(true);
    match(res)
      .with({ _tag: 'Right' }, ({ right }) => {
        expect(right).toHaveLength(5);
        expect(
          pipe(
            right,
            RA.every((c) => c.outcome === 'pass'),
          ),
        ).toBe(true);
      })
      .with({ _tag: 'Left' }, () => {
        expect.unreachable('Expected Right');
      })
      .exhaustive();
  });

  it('reports fail/warn with remediation when prerequisites are missing', async () => {
    const { adapter, graphql, request } = createMockOctokitAdapter();

    request.mockImplementation((route: string) =>
      match(route)
        .with('GET /repos/{owner}/{repo}', () => Promise.resolve({ data: { private: true } }))
        .with('GET /repos/{owner}/{repo}/actions/permissions/workflow', () =>
          Promise.resolve({ data: { can_approve_pull_request_reviews: false } }),
        )
        .with('GET /repos/{owner}/{repo}/labels', () => Promise.resolve({ data: [] }))
        .with('GET /repos/{owner}/{repo}/actions/secrets/{secret_name}', () =>
          Promise.reject(Object.assign(new Error('Not Found'), { status: 404 })),
        )
        .otherwise(() => Promise.reject(new Error(`Unexpected route: ${route}`))),
    );

    graphql.mockResolvedValueOnce({
      repository: { issueFields: { nodes: [] } },
    });

    const res = await adapter.checkSetupPrerequisites({
      prFlowOwner: 'mye-org',
      expectedLabels: [
        {
          name: isoLabelName.wrap('type:task'),
          color: isoHexColor.wrap('006b75'),
          description: isoMessage.wrap('Task'),
        },
      ],
    })();

    expect(E.isRight(res)).toBe(true);
    match(res)
      .with({ _tag: 'Right' }, ({ right }) => {
        const byName = new Map(
          pipe(
            right,
            RA.map((c) => [c.name, c] as const),
          ),
        );
        expect(byName.get('pr-flow repository visibility')?.outcome).toBe('warn');
        expect(byName.get('Actions PR permissions')?.outcome).toBe('fail');
        expect(byName.get('Actions PR permissions')?.remediation).toContain(
          'can_approve_pull_request_reviews=true',
        );
        expect(byName.get('pr-flow-status Issue Field')?.outcome).toBe('fail');
        expect(byName.get('Required labels')?.outcome).toBe('fail');
        expect(byName.get('Actions secret (GEMINI_API_KEY)')?.outcome).toBe('fail');
      })
      .with({ _tag: 'Left' }, () => {
        expect.unreachable('Expected Right');
      })
      .exhaustive();
  });
});

describe('createOctokitGitHubAdapter.getPrReviewComments', () => {
  it('filters out resolved review threads, approved reviews, and pre-fix comments', async () => {
    const { adapter, graphql, listReviews, listComments } = createMockOctokitAdapter();

    listReviews.mockResolvedValueOnce({
      data: [
        {
          state: 'CHANGES_REQUESTED',
          body: 'Old review round',
          submitted_at: '2026-11-20T10:00:00Z',
          user: { login: 'reviewer' },
        },
        {
          state: 'APPROVED',
          body: 'LGTM',
          submitted_at: '2026-11-20T12:00:00Z',
          user: { login: 'reviewer' },
        },
        {
          state: 'CHANGES_REQUESTED',
          body: 'New review feedback',
          submitted_at: '2026-11-20T13:00:00Z',
          user: { login: 'reviewer' },
        },
      ],
    });

    listComments.mockResolvedValueOnce({
      data: [
        {
          user: { type: 'User', login: 'reviewer' },
          body: 'Stale PR comment',
          created_at: '2026-11-20T10:30:00Z',
        },
        {
          user: { type: 'Bot', login: 'github-actions[bot]' },
          body: 'Applied review fixes on `ai/issue-1`.\n\n**Summary:** fixed',
          created_at: '2026-11-20T11:00:00Z',
        },
        {
          user: { type: 'User', login: 'reviewer' },
          body: 'Fresh PR comment',
          created_at: '2026-11-20T13:05:00Z',
        },
      ],
    });

    graphql.mockResolvedValueOnce({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                isResolved: true,
                isOutdated: true,
                comments: {
                  nodes: [
                    {
                      path: 'src/old.ts',
                      line: 10,
                      originalLine: 10,
                      body: 'Already resolved',
                      author: { login: 'reviewer' },
                    },
                  ],
                },
              },
              {
                isResolved: false,
                isOutdated: false,
                comments: {
                  nodes: [
                    {
                      path: 'src/new.ts',
                      line: 22,
                      originalLine: 22,
                      body: 'Please rename this',
                      author: { login: 'reviewer' },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });

    const res = await adapter.getPrReviewComments(99)();
    expect(E.isRight(res)).toBe(true);
    match(res)
      .with({ _tag: 'Right' }, ({ right }) => {
        expect(right).toEqual([
          '[Review CHANGES_REQUESTED by reviewer]: New review feedback',
          '[Inline comment on src/new.ts:22 by reviewer]: Please rename this',
          '[PR comment by reviewer]: Fresh PR comment',
        ]);
      })
      .with({ _tag: 'Left' }, () => {
        expect.unreachable('Expected Right');
      })
      .exhaustive();
  });

  it('filters out pre-fix reviews, approved reviews, and resolved threads in getPrReviewFeedback', async () => {
    const { adapter, graphql, listReviews, listComments } = createMockOctokitAdapter();

    graphql.mockResolvedValueOnce({
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'PRRT_resolved',
                isResolved: true,
                isOutdated: true,
                path: 'src/old.ts',
                line: 10,
                originalLine: 10,
                comments: {
                  nodes: [
                    { id: 'c1', databaseId: 1, body: 'Old resolved', author: { login: 'reviewer' } },
                  ],
                },
              },
              {
                id: 'PRRT_open',
                isResolved: false,
                isOutdated: false,
                path: 'src/new.ts',
                line: 22,
                originalLine: 22,
                comments: {
                  nodes: [
                    { id: 'c2', databaseId: 2, body: 'Fix null check', author: { login: 'reviewer' } },
                  ],
                },
              },
            ],
          },
        },
      },
    });

    listReviews.mockResolvedValueOnce({
      data: [
        {
          state: 'CHANGES_REQUESTED',
          body: 'Stale review',
          submitted_at: '2026-11-20T10:00:00Z',
          user: { login: 'reviewer' },
        },
        {
          state: 'APPROVED',
          body: 'Looks good',
          submitted_at: '2026-11-20T12:00:00Z',
          user: { login: 'reviewer' },
        },
        {
          state: 'CHANGES_REQUESTED',
          body: 'Fresh review',
          submitted_at: '2026-11-20T13:00:00Z',
          user: { login: 'reviewer' },
        },
      ],
    });

    listComments.mockResolvedValueOnce({
      data: [
        {
          user: { type: 'User', login: 'reviewer' },
          body: 'Stale comment',
          created_at: '2026-11-20T10:30:00Z',
        },
        {
          user: { type: 'Bot', login: 'github-actions[bot]' },
          body: 'Applied review fixes on `ai/issue-1`.\n\n**Summary:** fixed',
          created_at: '2026-11-20T11:00:00Z',
        },
        {
          user: { type: 'User', login: 'reviewer' },
          body: 'Fresh comment',
          created_at: '2026-11-20T13:05:00Z',
        },
      ],
    });

    const res = await adapter.getPrReviewFeedback(99)();
    expect(E.isRight(res)).toBe(true);
    match(res)
      .with({ _tag: 'Right' }, ({ right: feedback }) => {
        const threads = feedback.unresolvedThreads;
        expect(threads).toHaveLength(1);
        expect(threads[0]?.threadId).toBe('PRRT_open');
        expect(feedback.generalComments).toEqual([
          '[Review CHANGES_REQUESTED by reviewer]: Fresh review',
          '[PR comment by reviewer]: Fresh comment',
        ]);
      })
      .with({ _tag: 'Left' }, () => {
        expect.unreachable('Expected Right');
      })
      .exhaustive();
  });
});
