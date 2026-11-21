import type * as TE from 'fp-ts/lib/TaskEither';
import type { DomainError } from '../../domain/errors.js';
import type { IssueNode, IssueStatus, LabelDefinition } from '../../domain/issue.js';

export type CreateIssueInput = {
  readonly title: string;
  readonly body: string;
  readonly labels: ReadonlyArray<string>;
};

export type CreatePullRequestInput = {
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
  readonly labels?: ReadonlyArray<string>;
  readonly draft?: boolean;
};

export type PullRequestSummary = {
  readonly number: number;
  readonly url: string;
  readonly headRef: string;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
};

export type ManagedPrSummary = {
  readonly number: number;
  readonly headRef: string;
  readonly issueNumber: number;
  readonly updatedAt: string;
  readonly latestReviewState: string | null;
  readonly latestReviewSubmittedAt: string | null;
  readonly lastFixCommentAt: string | null;
};

export type PreflightCheckResult = {
  readonly name: string;
  readonly status: 'pass' | 'warn' | 'fail';
  readonly message: string;
  readonly remediation?: string;
};

export type PrReviewThreadComment = {
  readonly id: string;
  readonly databaseId: number | null;
  readonly author: string;
  readonly body: string;
};

export type PrReviewThread = {
  readonly threadId: string;
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  readonly path: string;
  readonly line: number | null;
  readonly comments: ReadonlyArray<PrReviewThreadComment>;
};

export type PrReviewFeedback = {
  readonly unresolvedThreads: ReadonlyArray<PrReviewThread>;
  readonly generalComments: ReadonlyArray<string>;
};

export type GitHubPort = {
  getIssue(issueNumber: number): TE.TaskEither<DomainError, IssueNode>;
  listAllIssues(state?: 'open' | 'closed' | 'all'): TE.TaskEither<DomainError, ReadonlyArray<IssueNode>>;
  createIssue(input: CreateIssueInput): TE.TaskEither<DomainError, { readonly number: number; readonly url: string }>;
  closeIssue(issueNumber: number): TE.TaskEither<DomainError, void>;
  reopenIssue(issueNumber: number): TE.TaskEither<DomainError, void>;
  setIssueStatus(issueNumber: number, status: IssueStatus): TE.TaskEither<DomainError, void>;
  ensureStatusField(): TE.TaskEither<DomainError, void>;
  addLabels(issueNumber: number, labels: ReadonlyArray<string>): TE.TaskEither<DomainError, void>;
  removeLabel(issueNumber: number, label: string): TE.TaskEither<DomainError, void>;
  addComment(issueNumber: number, body: string): TE.TaskEither<DomainError, void>;
  listIssueComments(issueNumber: number): TE.TaskEither<DomainError, ReadonlyArray<string>>;
  ensureLabels(labels: ReadonlyArray<LabelDefinition>): TE.TaskEither<DomainError, void>;
  dispatchWorkflow(
    workflowFile: string,
    ref: string,
    inputs: Readonly<Record<string, string>>,
  ): TE.TaskEither<DomainError, void>;

  // Native GitHub Sub-issues & Dependencies
  listSubIssues(issueNumber: number): TE.TaskEither<DomainError, ReadonlyArray<number>>;
  addSubIssue(parentNumber: number, childNumber: number): TE.TaskEither<DomainError, void>;
  listBlockedBy(issueNumber: number): TE.TaskEither<DomainError, ReadonlyArray<IssueNode>>;
  listBlocking(issueNumber: number): TE.TaskEither<DomainError, ReadonlyArray<number>>;
  addBlockedBy(issueNumber: number, blockerNumber: number): TE.TaskEither<DomainError, void>;

  // Pull Requests
  getPullRequest(prNumber: number): TE.TaskEither<DomainError, PullRequestSummary>;
  listOpenPrsForIssue(issueNumber: number): TE.TaskEither<DomainError, ReadonlyArray<PullRequestSummary>>;
  listOpenAiManagedPrs(): TE.TaskEither<DomainError, ReadonlyArray<ManagedPrSummary>>;
  createPullRequest(input: CreatePullRequestInput): TE.TaskEither<DomainError, PullRequestSummary>;
  mergePullRequest(prNumber: number, method: 'squash' | 'merge' | 'rebase'): TE.TaskEither<DomainError, void>;
  checkSetupPrerequisites(opts: {
    readonly prFlowOwner: string;
    readonly expectedLabels?: ReadonlyArray<LabelDefinition>;
    readonly secretName?: string;
  }): TE.TaskEither<DomainError, ReadonlyArray<PreflightCheckResult>>;
  addPrComment(prNumber: number, body: string): TE.TaskEither<DomainError, void>;
  getPrReviewComments(prNumber: number): TE.TaskEither<DomainError, ReadonlyArray<string>>;
  getPrReviewThreads(prNumber: number): TE.TaskEither<DomainError, ReadonlyArray<PrReviewThread>>;
  getPrReviewFeedback(prNumber: number): TE.TaskEither<DomainError, PrReviewFeedback>;
  replyToReviewThread(threadId: string, body: string): TE.TaskEither<DomainError, void>;
  resolveReviewThread(threadId: string): TE.TaskEither<DomainError, void>;
  listPrReviewers(prNumber: number): TE.TaskEither<DomainError, ReadonlyArray<string>>;
  requestReviewers(prNumber: number, reviewers: ReadonlyArray<string>): TE.TaskEither<DomainError, void>;
};
