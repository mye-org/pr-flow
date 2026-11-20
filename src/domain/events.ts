import type { IssueStatus } from './issue.js';

export type IssueEvent =
  | { type: 'DEPS_RESOLVED' }
  | { type: 'DEPS_BLOCKED'; blockingIssues: number[] }
  | {
      type: 'PICKUP_REQUESTED';
      wipCount: number;
      wipLimit: number;
      openPrCount: number;
      isLeaf: boolean;
      allBlockersClosed: boolean;
    }
  | { type: 'EXECUTION_SUCCEEDED'; prNumber: number; branch: string; summary: string }
  | { type: 'EXECUTION_FAILED'; reason: string }
  | { type: 'TRANSIENT_EXECUTION_FAILED'; reason: string; retryCount: number; maxRetries: number }
  | { type: 'NEEDS_HUMAN_DETECTED'; reason: string }
  | { type: 'REVIEW_CHANGES_REQUESTED'; prNumber: number; reviewer: string }
  | { type: 'REVIEW_FIX_SUCCEEDED'; prNumber: number; summary: string }
  | { type: 'PR_MERGED'; prNumber: number }
  | { type: 'HUMAN_REQUEUED' }
  | { type: 'ROLLUP_UPDATED'; targetStatus: IssueStatus };
