import type { IssueStatus } from './issue.js';

export type Effect =
  | {
      type: 'SWAP_STATUS_LABEL';
      issueNumber: number;
      from: IssueStatus | null;
      to: IssueStatus;
    }
  | {
      type: 'ADD_COMMENT';
      issueNumber: number;
      body: string;
    }
  | {
      type: 'CLOSE_ISSUE';
      issueNumber: number;
    }
  | {
      type: 'REOPEN_ISSUE';
      issueNumber: number;
    }
  | {
      type: 'CREATE_PR';
      issueNumber: number;
      branch: string;
      baseBranch: string;
      title: string;
      body: string;
      labels: string[];
    }
  | {
      type: 'ADD_PR_COMMENT';
      prNumber: number;
      body: string;
    };
