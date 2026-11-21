import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as E from 'fp-ts/lib/Either';
import { flow, pipe } from 'fp-ts/lib/function';
import * as RA from 'fp-ts/lib/ReadonlyArray';
import { describe, expect, it, vi } from 'vitest';
import { OctokitGitHubAdapter } from '../src/adapters/github/client.js';
import { generateInitFiles } from '../src/cli/init.js';
import { parseConfig } from '../src/domain/config.js';
import { isoHexColor, isoLabelName, isoMessage } from '../src/domain/newtypes.js';

type MockOctokit = {
  readonly graphql: () => Promise<object>;
  readonly request: (route: string) => Promise<object>;
  readonly rest: {
    readonly pulls: {
      readonly listReviews: () => Promise<object>;
      readonly listReviewComments: () => Promise<object>;
    };
    readonly issues: {
      readonly listLabelsForRepo: () => Promise<object>;
      readonly listComments: () => Promise<object>;
    };
  };
};

const getOctokit = (adapter: OctokitGitHubAdapter) =>
  Reflect.get(adapter, 'octokit') as MockOctokit;

describe('parseConfig', () => {
  it('parses valid config with defaults', () => {
    const res = parseConfig(`version: 1
workspace:
  verifyCommand: "npm test"
`);
    expect(E.isRight(res)).toBe(true);
    if (E.isRight(res)) {
      expect(res.right.wipLimit).toBe(4);
      expect(res.right.baseBranch).toBe('main');
      expect(res.right.statusFieldName).toBe('pr-flow-status');
      expect(res.right.agent.provider).toBe('gemini');
      expect(res.right.agent.fallbackModels).toEqual([]);
      expect(res.right.agent.maxRetries).toBe(3);
      expect(res.right.agent.maxSessionTurns).toBe(25);
      expect(res.right.agent.compressionThreshold).toBe(0.2);
      expect(res.right.triggers.reviewMode).toBe('changes_requested');
    }
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
      const generatedSkill = readFile('.agents/skills/pr-flow/SKILL.md');
      expect(generatedSkill).toContain('Parent rollup precedence');
      expect(generatedSkill).toContain('status set --issue');

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
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('OctokitGitHubAdapter.ensureStatusField', () => {
  it('succeeds via GraphQL without calling org REST API when pr-flow-status already exists', async () => {
    const adapter = new OctokitGitHubAdapter({
      token: 'test-token',
      owner: 'mye-org',
      repo: 'pr-flow-demo',
    });
    const octokit = getOctokit(adapter);
    vi.spyOn(octokit, 'graphql').mockResolvedValueOnce({
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
    const requestSpy = vi.spyOn(octokit, 'request');

    expect(E.isRight(await adapter.ensureStatusField()())).toBe(true);
    expect(requestSpy).not.toHaveBeenCalled();
    expect(requestSpy.mock.calls).toHaveLength(0);
  });

  it('returns actionable remediation instructions on HTTP 403 when field does not exist', async () => {
    const adapter = new OctokitGitHubAdapter({
      token: 'test-token',
      owner: 'mye-org',
      repo: 'pr-flow-demo',
    });
    const octokit = getOctokit(adapter);
    vi.spyOn(octokit, 'graphql').mockResolvedValueOnce({
      repository: { issueFields: { nodes: [] } },
    });
    vi.spyOn(octokit, 'request').mockRejectedValueOnce(
      Object.assign(new Error('Resource not accessible by integration'), { status: 403 }),
    );

    const res = await adapter.ensureStatusField()();
    expect(E.isLeft(res)).toBe(true);
    if (E.isLeft(res)) {
      expect(res.left.type).toBe('GITHUB_API_ERROR');
      expect(isoMessage.unwrap(res.left.message)).toContain('HTTP 403');
      expect(isoMessage.unwrap(res.left.message)).toContain('fields sync --repo mye-org/pr-flow-demo');
      expect(isoMessage.unwrap(res.left.message)).toContain(
        'https://github.com/organizations/mye-org/settings/issue-fields',
      );
    }
  });

  it('returns organization hint on HTTP 404 when field does not exist', async () => {
    const adapter = new OctokitGitHubAdapter({
      token: 'test-token',
      owner: 'personal-user',
      repo: 'demo',
    });
    const octokit = getOctokit(adapter);
    vi.spyOn(octokit, 'graphql').mockResolvedValueOnce({
      repository: { issueFields: { nodes: [] } },
    });
    vi.spyOn(octokit, 'request').mockRejectedValueOnce(
      Object.assign(new Error('Not Found'), { status: 404 }),
    );

    const res = await adapter.ensureStatusField()();
    expect(E.isLeft(res)).toBe(true);
    if (E.isLeft(res)) {
      expect(res.left.type).toBe('GITHUB_API_ERROR');
      expect(isoMessage.unwrap(res.left.message)).toContain('HTTP 404');
      expect(isoMessage.unwrap(res.left.message)).toContain('GitHub Organization');
    }
  });
});

describe('OctokitGitHubAdapter.checkSetupPrerequisites', () => {
  it('reports pass for all checks when repo and org are properly configured', async () => {
    const adapter = new OctokitGitHubAdapter({
      token: 'test-token',
      owner: 'mye-org',
      repo: 'pr-flow-demo',
    });
    const octokit = getOctokit(adapter);

    vi.spyOn(octokit, 'request').mockImplementation((route: string) => {
      if (route === 'GET /repos/{owner}/{repo}') {
        return Promise.resolve({ data: { private: false } });
      }
      if (route === 'GET /repos/{owner}/{repo}/actions/permissions/workflow') {
        return Promise.resolve({ data: { can_approve_pull_request_reviews: true } });
      }
      if (route === 'GET /repos/{owner}/{repo}/labels') {
        return Promise.resolve({ data: [{ name: 'type:epic' }, { name: 'type:task' }] });
      }
      if (route === 'GET /repos/{owner}/{repo}/actions/secrets/{secret_name}') {
        return Promise.resolve({ data: { name: 'GEMINI_API_KEY' } });
      }
      return Promise.reject(new Error(`Unexpected route: ${route}`));
    });

    vi.spyOn(octokit, 'graphql').mockResolvedValueOnce({
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
    if (E.isRight(res)) {
      expect(res.right).toHaveLength(5);
      expect(
        pipe(
          res.right,
          RA.every((c) => c.status === 'pass'),
        ),
      ).toBe(true);
    }
  });

  it('reports fail/warn with remediation when prerequisites are missing', async () => {
    const adapter = new OctokitGitHubAdapter({
      token: 'test-token',
      owner: 'mye-org',
      repo: 'pr-flow-demo',
    });
    const octokit = getOctokit(adapter);

    vi.spyOn(octokit, 'request').mockImplementation((route: string) => {
      if (route === 'GET /repos/{owner}/{repo}') {
        return Promise.resolve({ data: { private: true } });
      }
      if (route === 'GET /repos/{owner}/{repo}/actions/permissions/workflow') {
        return Promise.resolve({ data: { can_approve_pull_request_reviews: false } });
      }
      if (route === 'GET /repos/{owner}/{repo}/labels') {
        return Promise.resolve({ data: [] });
      }
      if (route === 'GET /repos/{owner}/{repo}/actions/secrets/{secret_name}') {
        return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
      }
      return Promise.reject(new Error(`Unexpected route: ${route}`));
    });

    vi.spyOn(octokit, 'graphql').mockResolvedValueOnce({
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
    if (E.isRight(res)) {
      const byName = new Map(
        pipe(
          res.right,
          RA.map((c) => [c.name, c] as const),
        ),
      );
      expect(byName.get('pr-flow repository visibility')?.status).toBe('warn');
      expect(byName.get('Actions PR permissions')?.status).toBe('fail');
      expect(byName.get('Actions PR permissions')?.remediation).toContain(
        'can_approve_pull_request_reviews=true',
      );
      expect(byName.get('pr-flow-status Issue Field')?.status).toBe('fail');
      expect(byName.get('Required labels')?.status).toBe('fail');
      expect(byName.get('Actions secret (GEMINI_API_KEY)')?.status).toBe('fail');
    }
  });
});

describe('OctokitGitHubAdapter.getPrReviewComments', () => {
  it('filters out resolved review threads, approved reviews, and pre-fix comments', async () => {
    const adapter = new OctokitGitHubAdapter({
      token: 'test-token',
      owner: 'mye-org',
      repo: 'pr-flow-demo',
    });
    const octokit = getOctokit(adapter);

    vi.spyOn(octokit.rest.pulls, 'listReviews').mockResolvedValueOnce({
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

    vi.spyOn(octokit.rest.issues, 'listComments').mockResolvedValueOnce({
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

    vi.spyOn(octokit, 'graphql').mockResolvedValueOnce({
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
    if (E.isRight(res)) {
      expect(res.right).toEqual([
        '[Review CHANGES_REQUESTED by reviewer]: New review feedback',
        '[Inline comment on src/new.ts:22 by reviewer]: Please rename this',
        '[PR comment by reviewer]: Fresh PR comment',
      ]);
    }
  });

  it('filters out pre-fix reviews, approved reviews, and resolved threads in getPrReviewFeedback', async () => {
    const adapter = new OctokitGitHubAdapter({
      token: 'test-token',
      owner: 'mye-org',
      repo: 'pr-flow-demo',
    });
    const octokit = getOctokit(adapter);

    vi.spyOn(octokit, 'graphql').mockResolvedValueOnce({
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

    vi.spyOn(octokit.rest.pulls, 'listReviews').mockResolvedValueOnce({
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

    vi.spyOn(octokit.rest.issues, 'listComments').mockResolvedValueOnce({
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
    if (E.isRight(res)) {
      expect(res.right.unresolvedThreads).toHaveLength(1);
      expect(res.right.unresolvedThreads[0]?.threadId).toBe('PRRT_open');
      expect(res.right.generalComments).toEqual([
        '[Review CHANGES_REQUESTED by reviewer]: Fresh review',
        '[PR comment by reviewer]: Fresh comment',
      ]);
    }
  });
});
