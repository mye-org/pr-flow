import { pipe } from 'fp-ts/lib/function';
import * as O from 'fp-ts/lib/Option';
import * as RA from 'fp-ts/lib/ReadonlyArray';
import { match } from 'ts-pattern';
import { z } from 'zod';
import {
  type Body,
  type BranchName,
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

export const FIELD_VALUE_TO_STATUS: Readonly<Record<string, IssueStatus>> = Object.fromEntries(
  pipe(
    Object.entries(STATUS_TO_FIELD_VALUE),
    RA.map(([status, value]) => [value, status as IssueStatus] as const),
  ),
);

export type IssueFieldOptionDefinition = {
  readonly name: FieldOptionName;
  readonly color: HexColor;
  readonly description: Message;
};

export const PR_FLOW_STATUS_OPTIONS: ReadonlyArray<IssueFieldOptionDefinition> = [
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
];

export const TYPE_TO_LABEL: Readonly<Record<IssueType, LabelName>> = {
  epic: isoLabelName.wrap('type:epic'),
  story: isoLabelName.wrap('type:story'),
  task: isoLabelName.wrap('type:task'),
  bug: isoLabelName.wrap('type:bug'),
};

export const LABEL_TO_TYPE: Readonly<Record<string, IssueType>> = Object.fromEntries(
  pipe(
    Object.entries(TYPE_TO_LABEL),
    RA.map(([type, label]) => [isoLabelName.unwrap(label), type as IssueType] as const),
  ),
);

export type LabelDefinition = {
  readonly name: LabelName;
  readonly color: HexColor;
  readonly description: Message;
};

export const DEFAULT_LABELS: ReadonlyArray<LabelDefinition> = [
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
];

export type IssueNode = {
  readonly number: IssueNumber;
  readonly title: Title;
  readonly body: Body;
  readonly state: 'open' | 'closed';
  readonly status: IssueStatus;
  readonly type: IssueType;
  readonly labels: ReadonlyArray<LabelName>;
  readonly subIssueNumbers: ReadonlyArray<IssueNumber>;
  readonly blockedByNumbers: ReadonlyArray<IssueNumber>;
  readonly blockingNumbers: ReadonlyArray<IssueNumber>;
  readonly linkedPrNumber: O.Option<PrNumber>;
  readonly parentNumber: O.Option<IssueNumber>;
  readonly updatedAt: IsoTimestamp;
};

export function isExecutableLeaf(issue: Pick<IssueNode, 'type' | 'subIssueNumbers'>): boolean {
  return match(issue.type)
    .with('task', 'bug', () => true)
    .with('story', () => issue.subIssueNumbers.length === 0)
    .with('epic', () => false)
    .exhaustive();
}

export function isContainerIssue(issue: Pick<IssueNode, 'type' | 'subIssueNumbers'>): boolean {
  return !isExecutableLeaf(issue);
}

export function branchNameForIssue(issueNumber: IssueNumber): BranchName {
  return isoBranchName.wrap(`ai/issue-${String(isoIssueNumber.unwrap(issueNumber))}`);
}

export function extractStatusFromFieldValue(value: O.Option<string>): IssueStatus {
  return pipe(
    value,
    O.chain((v) => O.fromNullable(FIELD_VALUE_TO_STATUS[v])),
    O.getOrElse((): IssueStatus => 'backlog'),
  );
}

export function extractTypeFromLabels(labels: ReadonlyArray<LabelName>): IssueType {
  return pipe(
    labels,
    RA.findFirstMap((label) => O.fromNullable(LABEL_TO_TYPE[isoLabelName.unwrap(label)])),
    O.getOrElse((): IssueType => 'task'),
  );
}

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
