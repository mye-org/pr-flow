/**
 * @file executeEffects.test.ts
 * @description Unit tests for the executeEffects interpreter. Verifies that domain effects
 * (such as SET_STATUS_FIELD, ADD_COMMENT, CLOSE_ISSUE, etc.) are correctly executed
 * via the GitHub adapter port and return expected TaskEither results.
 */

import * as E from 'fp-ts/lib/Either';
import * as TE from 'fp-ts/lib/TaskEither';
import { describe, expect, it, vi } from 'vitest';
import type { GitHubPort } from '../src/adapters/github/types.js';
import {
  isoBody,
  isoBranchName,
  isoIssueNumber,
  isoLabelName,
  isoMessage,
  isoPrNumber,
  isoTitle,
} from '../src/domain/newtypes.js';
import { executeEffect, executeEffects } from '../src/interpreter/executeEffects.js';

const mockGithub = (overrides: Partial<GitHubPort> = {}) => ({
  getIssue: vi.fn(),
  listAllIssues: vi.fn(),
  createIssue: vi.fn(),
  closeIssue: vi.fn(),
  reopenIssue: vi.fn(),
  updateIssueStatus: vi.fn(),
  ensureStatusField: vi.fn(),
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
  getPullRequest: vi.fn(),
  listOpenPrsForIssue: vi.fn(),
  listOpenAiManagedPrs: vi.fn(),
  createPullRequest: vi.fn(),
  mergePullRequest: vi.fn(),
  checkSetupPrerequisites: vi.fn(),
  addPrComment: vi.fn(),
  getPrReviewComments: vi.fn(),
  getPrReviewThreads: vi.fn(),
  getPrReviewFeedback: vi.fn(),
  replyToReviewThread: vi.fn(),
  resolveReviewThread: vi.fn(),
  listPrReviewers: vi.fn(),
  requestReviewers: vi.fn(),
  ...overrides,
});

describe('executeEffect', () => {
  it('handles SET_STATUS_FIELD (with from status)', async () => {
    const updateIssueStatus = vi.fn().mockReturnValue(TE.right(undefined));

    expect(
      E.isRight(
        await executeEffect(
          {
            type: 'SET_STATUS_FIELD',
            issueNumber: isoIssueNumber.wrap(42),
            transition: { kind: 'transition', from: 'ready', to: 'in_progress' },
          },
          mockGithub({ updateIssueStatus }),
        )(),
      ),
    ).toBe(true);
    expect(updateIssueStatus).toHaveBeenCalledWith(42, 'in_progress');
  });

  it('handles SET_STATUS_FIELD (without from status)', async () => {
    const updateIssueStatus = vi.fn().mockReturnValue(TE.right(undefined));

    expect(
      E.isRight(
        await executeEffect(
          {
            type: 'SET_STATUS_FIELD',
            issueNumber: isoIssueNumber.wrap(42),
            transition: { kind: 'initial', to: 'ready' },
          },
          mockGithub({ updateIssueStatus }),
        )(),
      ),
    ).toBe(true);
    expect(updateIssueStatus).toHaveBeenCalledWith(42, 'ready');
  });

  it('handles ADD_COMMENT', async () => {
    const addComment = vi.fn().mockReturnValue(TE.right(undefined));

    expect(
      E.isRight(
        await executeEffect(
          {
            type: 'ADD_COMMENT',
            issueNumber: isoIssueNumber.wrap(42),
            body: isoBody.wrap('Hello world'),
          },
          mockGithub({ addComment }),
        )(),
      ),
    ).toBe(true);
    expect(addComment).toHaveBeenCalledWith(42, 'Hello world');
  });

  it('handles CLOSE_ISSUE', async () => {
    const closeIssue = vi.fn().mockReturnValue(TE.right(undefined));

    expect(
      E.isRight(
        await executeEffect(
          { type: 'CLOSE_ISSUE', issueNumber: isoIssueNumber.wrap(42) },
          mockGithub({ closeIssue }),
        )(),
      ),
    ).toBe(true);
    expect(closeIssue).toHaveBeenCalledWith(42);
  });

  it('handles REOPEN_ISSUE', async () => {
    const reopenIssue = vi.fn().mockReturnValue(TE.right(undefined));

    expect(
      E.isRight(
        await executeEffect(
          { type: 'REOPEN_ISSUE', issueNumber: isoIssueNumber.wrap(42) },
          mockGithub({ reopenIssue }),
        )(),
      ),
    ).toBe(true);
    expect(reopenIssue).toHaveBeenCalledWith(42);
  });

  it('handles CREATE_PR', async () => {
    const createPullRequest = vi.fn().mockReturnValue(
      TE.right({
        number: 99,
        url: 'https://github.com/owner/repo/pull/99',
        headRef: 'branch',
        state: 'open',
        merged: false,
      }),
    );

    expect(
      E.isRight(
        await executeEffect(
          {
            type: 'CREATE_PR',
            issueNumber: isoIssueNumber.wrap(42),
            draft: {
              branch: isoBranchName.wrap('ai/issue-42'),
              baseBranch: isoBranchName.wrap('main'),
              content: {
                title: isoTitle.wrap('Implement auth'),
                body: isoBody.wrap('Closes #42'),
                labels: [isoLabelName.wrap('ai-generated')],
              },
            },
          },
          mockGithub({ createPullRequest }),
        )(),
      ),
    ).toBe(true);
    expect(createPullRequest).toHaveBeenCalledWith({
      content: {
        title: 'Implement auth',
        body: 'Closes #42',
        labels: ['ai-generated'],
      },
      head: 'ai/issue-42',
      base: 'main',
    });
  });

  it('handles ADD_PR_COMMENT', async () => {
    const addPrComment = vi.fn().mockReturnValue(TE.right(undefined));

    expect(
      E.isRight(
        await executeEffect(
          {
            type: 'ADD_PR_COMMENT',
            prNumber: isoPrNumber.wrap(99),
            body: isoBody.wrap('LGTM'),
          },
          mockGithub({ addPrComment }),
        )(),
      ),
    ).toBe(true);
    expect(addPrComment).toHaveBeenCalledWith(99, 'LGTM');
  });
});

describe('executeEffects', () => {
  it('executes multiple effects in sequence', async () => {
    const addComment = vi.fn().mockReturnValue(TE.right(undefined));
    const closeIssue = vi.fn().mockReturnValue(TE.right(undefined));

    expect(
      E.isRight(
        await executeEffects(
          [
            { type: 'ADD_COMMENT', issueNumber: isoIssueNumber.wrap(42), body: isoBody.wrap('Done') },
            { type: 'CLOSE_ISSUE', issueNumber: isoIssueNumber.wrap(42) },
          ],
          mockGithub({ addComment, closeIssue }),
        )(),
      ),
    ).toBe(true);
    expect(addComment).toHaveBeenCalledWith(42, 'Done');
    expect(closeIssue).toHaveBeenCalledWith(42);
  });

  it('stops execution on first error', async () => {
    const addComment = vi.fn().mockReturnValue(
      TE.left({
        type: 'GITHUB_API_ERROR',
        message: isoMessage.wrap('Failed'),
        httpStatus: { kind: 'unknown' },
        cause: { kind: 'none' },
      }),
    );
    const closeIssue = vi.fn().mockReturnValue(TE.right(undefined));

    expect(
      E.isLeft(
        await executeEffects(
          [
            { type: 'ADD_COMMENT', issueNumber: isoIssueNumber.wrap(42), body: isoBody.wrap('Done') },
            { type: 'CLOSE_ISSUE', issueNumber: isoIssueNumber.wrap(42) },
          ],
          mockGithub({ addComment, closeIssue }),
        )(),
      ),
    ).toBe(true);
    expect(addComment).toHaveBeenCalledWith(42, 'Done');
    expect(closeIssue).not.toHaveBeenCalled();
  });
});
