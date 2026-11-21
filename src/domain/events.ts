import type {
  BranchName,
  Count,
  IssueNumber,
  Message,
  PrNumber,
  ReviewerName,
} from './newtypes.js';

export type LeafKind = 'leaf' | 'container';
export type BlockerState = 'all_closed' | 'has_open';

export type IssueEvent =
  | { readonly type: 'DEPS_RESOLVED' }
  | { readonly type: 'DEPS_BLOCKED'; readonly blockingIssues: ReadonlyArray<IssueNumber> }
  | {
      readonly type: 'PICKUP_REQUESTED';
      readonly wipCount: Count;
      readonly wipLimit: Count;
      readonly openPrCount: Count;
      readonly leafKind: LeafKind;
      readonly blockerState: BlockerState;
    }
  | {
      readonly type: 'EXECUTION_SUCCEEDED';
      readonly prNumber: PrNumber;
      readonly branch: BranchName;
      readonly summary: Message;
    }
  | { readonly type: 'EXECUTION_FAILED'; readonly reason: Message }
  | {
      readonly type: 'TRANSIENT_EXECUTION_FAILED';
      readonly reason: Message;
      readonly retryCount: Count;
      readonly maxRetries: Count;
    }
  | { readonly type: 'NEEDS_HUMAN_DETECTED'; readonly reason: Message }
  | {
      readonly type: 'REVIEW_CHANGES_REQUESTED';
      readonly prNumber: PrNumber;
      readonly reviewer: ReviewerName;
    }
  | { readonly type: 'PR_MERGED'; readonly prNumber: PrNumber }
  | { readonly type: 'HUMAN_REQUEUED' };
