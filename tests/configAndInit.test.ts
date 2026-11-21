import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as E from 'fp-ts/Either';
import { describe, expect, it, vi } from 'vitest';
import { OctokitGitHubAdapter } from '../src/adapters/github/client.js';
import { generateInitFiles } from '../src/cli/init.js';
import { parseConfig } from '../src/domain/config.js';

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
      expect(res.right.triggers.reviewMode).toBe('changes_requested');
    }
  });

  it('rejects custom provider without agent.command', () => {
    const res = parseConfig(`version: 1
workspace:
  verifyCommand: "pytest"
agent:
  provider: custom
`);
    expect(E.isLeft(res)).toBe(true);
  });
});

describe('generateInitFiles', () => {
  it('creates target repo footprint and respects force flag', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-flow-init-'));
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
      expect(fs.existsSync(path.join(tmpDir, 'pr-flow.config.yml'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, '.agents/skills/pr-flow/SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, '.github/workflows/pr-flow-implement.yml'))).toBe(true);
      expect(
        fs.readFileSync(path.join(tmpDir, '.github/workflows/pr-flow-implement.yml'), 'utf-8'),
      ).toContain('field_added');
      const generatedSkill = fs.readFileSync(
        path.join(tmpDir, '.agents/skills/pr-flow/SKILL.md'),
        'utf-8',
      );
      expect(generatedSkill).toContain('Parent rollup precedence');
      expect(generatedSkill).toContain('status set --issue');

      const second = generateInitFiles({
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
      expect(second.written).toHaveLength(0);
      expect(second.skipped).toHaveLength(7);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('OctokitGitHubAdapter.ensureStatusField', () => {
  it('returns actionable remediation instructions on HTTP 403', async () => {
    const adapter = new OctokitGitHubAdapter({
      token: 'test-token',
      owner: 'mye-org',
      repo: 'pr-flow-demo',
    });
    const octokit = (adapter as unknown as { octokit: { request: (...args: unknown[]) => Promise<unknown> } }).octokit;
    vi.spyOn(octokit, 'request').mockRejectedValueOnce(
      Object.assign(new Error('Resource not accessible by integration'), { status: 403 }),
    );

    const res = await adapter.ensureStatusField()();
    expect(E.isLeft(res)).toBe(true);
    if (E.isLeft(res)) {
      expect(res.left.type).toBe('GITHUB_API_ERROR');
      if (res.left.type === 'GITHUB_API_ERROR') {
        expect(res.left.message).toContain('HTTP 403');
        expect(res.left.message).toContain('fields sync --repo mye-org/pr-flow-demo');
        expect(res.left.message).toContain('https://github.com/organizations/mye-org/settings/issue-fields');
      }
    }
  });

  it('returns organization hint on HTTP 404', async () => {
    const adapter = new OctokitGitHubAdapter({
      token: 'test-token',
      owner: 'personal-user',
      repo: 'demo',
    });
    const octokit = (adapter as unknown as { octokit: { request: (...args: unknown[]) => Promise<unknown> } }).octokit;
    vi.spyOn(octokit, 'request').mockRejectedValueOnce(
      Object.assign(new Error('Not Found'), { status: 404 }),
    );

    const res = await adapter.ensureStatusField()();
    expect(E.isLeft(res)).toBe(true);
    if (E.isLeft(res)) {
      expect(res.left.type).toBe('GITHUB_API_ERROR');
      if (res.left.type === 'GITHUB_API_ERROR') {
        expect(res.left.message).toContain('HTTP 404');
        expect(res.left.message).toContain('GitHub Organization');
      }
    }
  });
});

