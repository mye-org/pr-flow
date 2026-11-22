import { flow } from 'fp-ts/lib/function';
import * as O from 'fp-ts/lib/Option';
import * as RA from 'fp-ts/lib/ReadonlyArray';
import * as RR from 'fp-ts/lib/ReadonlyRecord';
import { match } from 'ts-pattern';
import { z } from 'zod';
import {
  type Body,
  type FieldOptionName,
  type HexColor,
  isoBranchName,
  isoFieldOptionName,
  isoHexColor,
  isoIssueNumber,
  isoLabelName,
  isoMessage,
  type IsoTimestamp,
  type IssueNumber,
  type LabelName,
  type Message,
  type PrNumber,
  type Title,
} from './newtypes.js';

export type IssueStatus =
  | 'backlog'
  | 'blocked_dep'
  | 'ready'
  | 'in_progress'
  | 'review_pending'
  | 'fixed'
  | 'needs_human';

export type IssueType = 'epic' | 'story' | 'task' | 'bug';

export const AI_MANAGED_LABEL = isoLabelName.wrap('ai-managed');
export const PR_FLOW_STATUS_FIELD_NAME = 'pr-flow-status';

export const STATUS_TO_FIELD_VALUE: Readonly<Record<IssueStatus, string>> = {
  backlog: 'backlog',
  blocked_dep: 'blocked-dep',
  ready: 'ready',
  in_progress: 'in-progress',
  review_pending: 'review-pending',
  fixed: 'fixed',
  needs_human: 'needs-human',
};

const invertStatusEntries = flow(
  (record: Readonly<Record<IssueStatus, string>>) => RR.toEntries(record),
  RA.map(([status, value]) => [value, status] as const),
);

export const FIELD_VALUE_TO_STATUS: Readonly<Record<string, IssueStatus>> = Object.fromEntries(
  invertStatusEntries(STATUS_TO_FIELD_VALUE),
);

export type IssueFieldOptionDefinition = {
  readonly name: FieldOptionName;
  readonly color: HexColor;
  readonly description: Message;
};

export const PR_FLOW_STATUS_OPTIONS = [
  {
    name: isoFieldOptionName.wrap('backlog'),
    color: isoHexColor.wrap('GRAY'),
    description: isoMessage.wrap('Unrefined or not yet scheduled'),
  },
  {
    name: isoFieldOptionName.wrap('blocked-dep'),
    color: isoHexColor.wrap('ORANGE'),
    description: isoMessage.wrap('Blocked by open upstream dependencies'),
  },
  {
    name: isoFieldOptionName.wrap('ready'),
    color: isoHexColor.wrap('GREEN'),
    description: isoMessage.wrap('Ready for automated AI pickup'),
  },
  {
    name: isoFieldOptionName.wrap('in-progress'),
    color: isoHexColor.wrap('YELLOW'),
    description: isoMessage.wrap('Claimed and actively executing (counts toward WIP limit)'),
  },
  {
    name: isoFieldOptionName.wrap('review-pending'),
    color: isoHexColor.wrap('BLUE'),
    description: isoMessage.wrap('PR opened and awaiting human review (uncapped WIP)'),
  },
  {
    name: isoFieldOptionName.wrap('fixed'),
    color: isoHexColor.wrap('PURPLE'),
    description: isoMessage.wrap('PR merged and issue resolved'),
  },
  {
    name: isoFieldOptionName.wrap('needs-human'),
    color: isoHexColor.wrap('RED'),
    description: isoMessage.wrap('Requires human intervention or clarification'),
  },
] as const satisfies ReadonlyArray<IssueFieldOptionDefinition>;

export const TYPE_TO_LABEL: Readonly<Record<IssueType, LabelName>> = {
  epic: isoLabelName.wrap('type:epic'),
  story: isoLabelName.wrap('type:story'),
  task: isoLabelName.wrap('type:task'),
  bug: isoLabelName.wrap('type:bug'),
};

const labelEntryToType = ([type, label]: readonly [IssueType, LabelName]) =>
  [isoLabelName.unwrap(label), type] as const;

const invertTypeEntries = flow(
  (record: Readonly<Record<IssueType, LabelName>>) => RR.toEntries(record),
  RA.map(labelEntryToType),
);

export const LABEL_TO_TYPE: Readonly<Record<string, IssueType>> = Object.fromEntries(
  invertTypeEntries(TYPE_TO_LABEL),
);

export type LabelDefinition = {
  readonly name: LabelName;
  readonly color: HexColor;
  readonly description: Message;
};

export const DEFAULT_LABELS = [
  {
    name: isoLabelName.wrap('type:epic'),
    color: isoHexColor.wrap('3e4b9e'),
    description: isoMessage.wrap('Top-level Agile Epic container (status rolls up)'),
  },
  {
    name: isoLabelName.wrap('type:story'),
    color: isoHexColor.wrap('5319e7'),
    description: isoMessage.wrap('User Story (container if it has sub-issues, leaf otherwise)'),
  },
  {
    name: isoLabelName.wrap('type:task'),
    color: isoHexColor.wrap('006b75'),
    description: isoMessage.wrap('Executable engineering task (1 PR per issue)'),
  },
  {
    name: isoLabelName.wrap('type:bug'),
    color: isoHexColor.wrap('d73a4a'),
    description: isoMessage.wrap('Executable bug fix (1 PR per issue)'),
  },
  {
    name: AI_MANAGED_LABEL,
    color: isoHexColor.wrap('0052cc'),
    description: isoMessage.wrap('Managed by pr-flow automation'),
  },
] as const satisfies ReadonlyArray<LabelDefinition>;

export type IssueContent = {
  readonly title: Title;
  readonly body: Body;
  readonly labels: ReadonlyArray<LabelName>;
};

export type LinkedPrRef =
  | { readonly kind: 'linked'; readonly prNumber: PrNumber }
  | { readonly kind: 'none' };

export type ParentIssueRef =
  | { readonly kind: 'child'; readonly parentNumber: IssueNumber }
  | { readonly kind: 'root' };

export type IssueLinks = {
  readonly linkedPr: LinkedPrRef;
  readonly parent: ParentIssueRef;
};

export type IssueNode = {
  readonly number: IssueNumber;
  readonly content: IssueContent;
  readonly state: 'open' | 'closed';
  readonly status: IssueStatus;
  readonly type: IssueType;
  readonly subIssueNumbers: ReadonlyArray<IssueNumber>;
  readonly blockedByNumbers: ReadonlyArray<IssueNumber>;
  readonly blockingNumbers: ReadonlyArray<IssueNumber>;
  readonly links: IssueLinks;
  readonly lastUpdatedAt: IsoTimestamp;
};

export function isExecutableLeaf(issue: Pick<IssueNode, 'type' | 'subIssueNumbers'>) {
  return match(issue.type)
    .with('task', 'bug', () => true)
    .with('story', () => issue.subIssueNumbers.length === 0)
    .with('epic', () => false)
    .exhaustive();
}

export function isContainerIssue(issue: Pick<IssueNode, 'type' | 'subIssueNumbers'>) {
  return !isExecutableLeaf(issue);
}

const formatIssueBranchName = (issueNumber: number) => `ai/issue-${String(issueNumber)}`;

export const branchNameForIssue = flow(
  isoIssueNumber.unwrap,
  formatIssueBranchName,
  isoBranchName.wrap,
);

const lookupStatusByValue = (value: string) => O.fromNullable(FIELD_VALUE_TO_STATUS[value]);

export const extractStatusFromFieldValue = flow(
  O.flatMap(lookupStatusByValue),
  O.getOrElseW(() => 'backlog' as const),
);

const lookupTypeByLabelName = (labelName: string) => O.fromNullable(LABEL_TO_TYPE[labelName]);

const lookupTypeByLabel = flow(isoLabelName.unwrap, lookupTypeByLabelName);

export const extractTypeFromLabels = flow(
  RA.findFirstMap(lookupTypeByLabel),
  O.getOrElseW(() => 'task' as const),
);

export const ResolvedCommentSchema = z.object({
  threadId: z.string().min(1),
  reply: z.string().min(1),
});

export type ResolvedComment = z.infer<typeof ResolvedCommentSchema>;

export const AgentResultSchema = z.object({
  status: z.enum(['success', 'needs_human', 'failed', 'retryable']),
  summary: z.string().min(1),
  reason: z.string().optional(),
  testsRun: z.boolean().optional(),
  filesChanged: z.array(z.string()).optional(),
  resolvedComments: z.array(ResolvedCommentSchema).optional(),
});

export type AgentResult = z.infer<typeof AgentResultSchema>;
