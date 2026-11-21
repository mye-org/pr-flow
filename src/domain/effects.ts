import type * as O from 'fp-ts/lib/Option';
import type { IssueStatus } from './issue.js';
import type {
  Body,
  BranchName,
  IssueNumber,
  LabelName,
  PrNumber,
  Title,
} from './newtypes.js';

export type Effect =
  | {
      readonly type: 'SET_STATUS_FIELD';
      readonly issueNumber: IssueNumber;
      readonly from: O.Option<IssueStatus>;
      readonly to: IssueStatus;
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
      readonly branch: BranchName;
      readonly baseBranch: BranchName;
      readonly title: Title;
      readonly body: Body;
      readonly labels: ReadonlyArray<LabelName>;
    }
  | {
      readonly type: 'ADD_PR_COMMENT';
      readonly prNumber: PrNumber;
      readonly body: Body;
    };
