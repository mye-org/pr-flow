import type * as TE from 'fp-ts/TaskEither';
import type { DomainError } from '../../domain/errors.js';
import type { IssueNode, IssueStatus, LabelDefinition } from '../../domain/issue.js';

export interface CreateIssueInput {
  title: string;
  body: string;
  labels: string[];
}

export interface CreatePullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
  labels?: string[];
}

export interface PullRequestSummary {
  number: number;
  url: string;
  headRef: string;
  state: 'open' | 'closed';
  merged: boolean;
}

export interface ManagedPrSummary {
  number: number;
  headRef: string;
  issueNumber: number;
  updatedAt: string;
  latestReviewState: string | null;
}

export interface GitHubPort {
  getIssue(issueNumber: number): TE.TaskEither<DomainError, IssueNode>;
  listAllIssues(state?: 'open' | 'closed' | 'all'): TE.TaskEither<DomainError, IssueNode[]>;
  createIssue(input: CreateIssueInput): TE.TaskEither<DomainError, { number: number; url: string }>;
  closeIssue(issueNumber: number): TE.TaskEither<DomainError, void>;
  reopenIssue(issueNumber: number): TE.TaskEither<DomainError, void>;
  setIssueStatus(issueNumber: number, status: IssueStatus): TE.TaskEither<DomainError, void>;
  ensureStatusField(): TE.TaskEither<DomainError, void>;
  addLabels(issueNumber: number, labels: string[]): TE.TaskEither<DomainError, void>;
  removeLabel(issueNumber: number, label: string): TE.TaskEither<DomainError, void>;
  addComment(issueNumber: number, body: string): TE.TaskEither<DomainError, void>;
  listIssueComments(issueNumber: number): TE.TaskEither<DomainError, string[]>;
  ensureLabels(labels: readonly LabelDefinition[]): TE.TaskEither<DomainError, void>;
  dispatchWorkflow(
    workflowFile: string,
    ref: string,
    inputs: Record<string, string>,
  ): TE.TaskEither<DomainError, void>;

  // Native GitHub Sub-issues & Dependencies
  listSubIssues(issueNumber: number): TE.TaskEither<DomainError, number[]>;
  addSubIssue(parentNumber: number, childNumber: number): TE.TaskEither<DomainError, void>;
  listBlockedBy(issueNumber: number): TE.TaskEither<DomainError, IssueNode[]>;
  listBlocking(issueNumber: number): TE.TaskEither<DomainError, number[]>;
  addBlockedBy(issueNumber: number, blockerNumber: number): TE.TaskEither<DomainError, void>;

  // Pull Requests
  listOpenPrsForIssue(issueNumber: number): TE.TaskEither<DomainError, PullRequestSummary[]>;
  listOpenAiManagedPrs(): TE.TaskEither<DomainError, ManagedPrSummary[]>;
  createPullRequest(input: CreatePullRequestInput): TE.TaskEither<DomainError, PullRequestSummary>;
  mergePullRequest(prNumber: number, method: 'squash' | 'merge' | 'rebase'): TE.TaskEither<DomainError, void>;
  addPrComment(prNumber: number, body: string): TE.TaskEither<DomainError, void>;
  getPrReviewComments(prNumber: number): TE.TaskEither<DomainError, string[]>;
}
