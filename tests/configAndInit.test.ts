import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as E from 'fp-ts/Either';
import { describe, expect, it } from 'vitest';
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
      expect(first.written).toHaveLength(6);
      expect(first.skipped).toHaveLength(0);
      expect(fs.existsSync(path.join(tmpDir, 'pr-flow.config.yml'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, '.github/workflows/pr-flow-implement.yml'))).toBe(true);

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
      expect(second.skipped).toHaveLength(6);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
