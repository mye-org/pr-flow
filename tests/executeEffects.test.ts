/**
 * @file executeEffects.test.ts
 * @description Unit tests for the executeEffects interpreter. Verifies that domain effects
 * (such as SWAP_STATUS_LABEL, ADD_COMMENT, CREATE_ISSUE, etc.) are correctly executed
 * via the GitHub adapter port and return expected TaskEither results.
 */

import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { describe, expect, it, vi } from 'vitest';
import type { GitHubPort } from '../src/adapters/github/types.js';
import { executeEffect, executeEffects } from '../src/interpreter/executeEffects.js';
import type { Effect } from '../src/domain/effects.js';

const mockGithub = (): GitHubPort => ({
  getIssue: vi.fn(),
  listAllIssues: vi.fn(),
  createIssue: vi.fn(),
  closeIssue: vi.fn(),
  reopenIssue: vi.fn(),
  addLabels: vi.fn(),
  removeLabel: vi.fn(),
  addComment: vi.fn(),
  listIssueComments: vi.fn(),
  ensureLabels: vi.fn(),
  dispatchWorkflow: vi.fn(),
  listSubIssues: vi.fn(),
  addSubIssue: vi.fn(),
  listBlockedBy: vi.fn(),
  listBlocking: vi.fn(),
  addBlockedBy: vi.fn(),
  listOpenPrsForIssue: vi.fn(),
  createPullRequest: vi.fn(),
  addPrComment: vi.fn(),
  getPrReviewComments: vi.fn(),
});

describe('executeEffect', () => {
  it('handles SWAP_STATUS_LABEL (with from status)', async () => {
    const github = mockGithub();
    (github.removeLabel as any).mockReturnValue(TE.right(undefined));
    (github.addLabels as any).mockReturnValue(TE.right(undefined));

    const effect: Effect = {
      type: 'SWAP_STATUS_LABEL',
      issueNumber: 42,
      from: 'ready',
      to: 'in_progress',
    };

    const result = await executeEffect(effect, github)();

    expect(E.isRight(result)).toBe(true);
    expect(github.removeLabel).toHaveBeenCalledWith(42, 'status:ready');
    expect(github.addLabels).toHaveBeenCalledWith(42, ['status:in-progress']);
  });

  it('handles SWAP_STATUS_LABEL (without from status)', async () => {

    const github = mockGithub();
    (github.addLabels as any).mockReturnValue(TE.right(undefined));

    const effect: Effect = {
      type: 'SWAP_STATUS_LABEL',
      issueNumber: 42,
      from: null,
      to: 'ready',
    };

    const result = await executeEffect(effect, github)();

    expect(E.isRight(result)).toBe(true);
    expect(github.removeLabel).not.toHaveBeenCalled();
    expect(github.addLabels).toHaveBeenCalledWith(42, ['status:ready']);
  });

  it('handles ADD_COMMENT', async () => {
    const github = mockGithub();
    (github.addComment as any).mockReturnValue(TE.right(undefined));

    const effect: Effect = {
      type: 'ADD_COMMENT',
      issueNumber: 42,
      body: 'Hello world',
    };

    const result = await executeEffect(effect, github)();

    expect(E.isRight(result)).toBe(true);
    expect(github.addComment).toHaveBeenCalledWith(42, 'Hello world');
  });

  it('handles CLOSE_ISSUE', async () => {
    const github = mockGithub();
    (github.closeIssue as any).mockReturnValue(TE.right(undefined));

    const effect: Effect = {
      type: 'CLOSE_ISSUE',
      issueNumber: 42,
    };

    const result = await executeEffect(effect, github)();

    expect(E.isRight(result)).toBe(true);
    expect(github.closeIssue).toHaveBeenCalledWith(42);
  });

  it('handles REOPEN_ISSUE', async () => {
    const github = mockGithub();
    (github.reopenIssue as any).mockReturnValue(TE.right(undefined));

    const effect: Effect = {
      type: 'REOPEN_ISSUE',
      issueNumber: 42,
    };

    const result = await executeEffect(effect, github)();

    expect(E.isRight(result)).toBe(true);
    expect(github.reopenIssue).toHaveBeenCalledWith(42);
  });

  it('handles CREATE_PR', async () => {
    const github = mockGithub();
    (github.createPullRequest as any).mockReturnValue(
      TE.right({ number: 99, url: 'https://github.com/owner/repo/pull/99', headRef: 'branch', state: 'open', merged: false }),
    );

    const effect: Effect = {
      type: 'CREATE_PR',
      issueNumber: 42,
      branch: 'ai/issue-42',
      baseBranch: 'main',
      title: 'Implement auth',
      body: 'Closes #42',
      labels: ['ai-generated'],
    };

    const result = await executeEffect(effect, github)();

    expect(E.isRight(result)).toBe(true);
    expect(github.createPullRequest).toHaveBeenCalledWith({
      title: 'Implement auth',
      body: 'Closes #42',
      head: 'ai/issue-42',
      base: 'main',
      labels: ['ai-generated'],
    });
  });

  it('handles ADD_PR_COMMENT', async () => {
    const github = mockGithub();
    (github.addPrComment as any).mockReturnValue(TE.right(undefined));

    const effect: Effect = {
      type: 'ADD_PR_COMMENT',
      prNumber: 99,
      body: 'LGTM',
    };

    const result = await executeEffect(effect, github)();

    expect(E.isRight(result)).toBe(true);
    expect(github.addPrComment).toHaveBeenCalledWith(99, 'LGTM');
  });
});

describe('executeEffects', () => {
  it('executes multiple effects in sequence', async () => {
    const github = mockGithub();
    (github.addComment as any).mockReturnValue(TE.right(undefined));
    (github.closeIssue as any).mockReturnValue(TE.right(undefined));

    const effects: Effect[] = [
      { type: 'ADD_COMMENT', issueNumber: 42, body: 'Done' },
      { type: 'CLOSE_ISSUE', issueNumber: 42 },
    ];

    const result = await executeEffects(effects, github)();

    expect(E.isRight(result)).toBe(true);
    expect(github.addComment).toHaveBeenCalledWith(42, 'Done');
    expect(github.closeIssue).toHaveBeenCalledWith(42);
  });

  it('stops execution on first error', async () => {
    const github = mockGithub();
    (github.addComment as any).mockReturnValue(TE.left({ type: 'GITHUB_ERROR', message: 'Failed' }));
    (github.closeIssue as any).mockReturnValue(TE.right(undefined));

    const effects: Effect[] = [
      { type: 'ADD_COMMENT', issueNumber: 42, body: 'Done' },
      { type: 'CLOSE_ISSUE', issueNumber: 42 },
    ];

    const result = await executeEffects(effects, github)();

    expect(E.isLeft(result)).toBe(true);
    expect(github.addComment).toHaveBeenCalledWith(42, 'Done');
    expect(github.closeIssue).not.toHaveBeenCalled();
  });
});

