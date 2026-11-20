import type { IssueStatus, IssueType } from './issue.js';

export type GuardError =
  | { type: 'WIP_LIMIT_REACHED'; currentWip: number; limit: number }
  | { type: 'BLOCKED_BY_DEPENDENCIES'; blockingIssues: number[] }
  | {
      type: 'NOT_AN_EXECUTABLE_LEAF';
      issueNumber: number;
      issueType: IssueType;
      subIssueCount: number;
    }
  | { type: 'PR_ALREADY_EXISTS'; issueNumber: number; existingPrCount: number }
  | { type: 'INVALID_STATE_FOR_PICKUP'; issueNumber: number; currentStatus: IssueStatus };

export type DomainError =
  | { type: 'CONFIG_ERROR'; message: string }
  | { type: 'PLAN_VALIDATION_ERROR'; message: string; details?: string[] }
  | { type: 'GITHUB_API_ERROR'; message: string; status?: number; cause?: unknown }
  | { type: 'AGENT_EXECUTION_ERROR'; message: string; exitCode?: number; retryable?: boolean }
  | { type: 'GUARD_ERROR'; guard: GuardError }
  | { type: 'GIT_ERROR'; message: string };

export function formatGuardError(err: GuardError): string {
  switch (err.type) {
    case 'WIP_LIMIT_REACHED':
      return `WIP limit reached (${err.currentWip}/${err.limit} issues currently in progress).`;
    case 'BLOCKED_BY_DEPENDENCIES':
      return `Issue is blocked by open dependencies: ${err.blockingIssues.map((n) => `#${n}`).join(', ')}.`;
    case 'NOT_AN_EXECUTABLE_LEAF':
      return `Issue #${err.issueNumber} (type=${err.issueType}, subIssues=${err.subIssueCount}) is a container, not an executable leaf.`;
    case 'PR_ALREADY_EXISTS':
      return `Issue #${err.issueNumber} already has ${err.existingPrCount} open PR(s) (1-PR-per-issue rule).`;
    case 'INVALID_STATE_FOR_PICKUP':
      return `Issue #${err.issueNumber} is in state '${err.currentStatus}', which cannot be picked up automatically.`;
  }
}
