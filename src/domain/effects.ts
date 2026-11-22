import type { IssueContent, IssueStatus } from './issue.js';
import type {
  Body,
  BranchName,
  IssueNumber,
  PrNumber,
} from './newtypes.js';

export type StatusTransition =
  | { readonly kind: 'initial'; readonly to: IssueStatus }
  | { readonly kind: 'transition'; readonly from: IssueStatus; readonly to: IssueStatus };

export type PrDraft = {
  readonly branch: BranchName;
  readonly baseBranch: BranchName;
  readonly content: IssueContent;
};

export type Effect =
  | {
      readonly type: 'SET_STATUS_FIELD';
      readonly issueNumber: IssueNumber;
      readonly transition: StatusTransition;
    }
  | {
      readonly type: 'ADD_COMMENT';
      readonly issueNumber: IssueNumber;
      readonly body: Body;
    }
  | {
      readonly type: 'CLOSE_ISSUE';
      readonly issueNumber: IssueNumber;
    }
  | {
      readonly type: 'REOPEN_ISSUE';
      readonly issueNumber: IssueNumber;
    }
  | {
      readonly type: 'CREATE_PR';
      readonly issueNumber: IssueNumber;
      readonly draft: PrDraft;
    }
  | {
      readonly type: 'ADD_PR_COMMENT';
      readonly prNumber: PrNumber;
      readonly body: Body;
    };
