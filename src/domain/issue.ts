import { z } from 'zod';

export type IssueStatus =
  | 'backlog'
  | 'blocked_dep'
  | 'ready'
  | 'in_progress'
  | 'review_pending'
  | 'fixed'
  | 'needs_human';

export type IssueType = 'epic' | 'story' | 'task' | 'bug';

export const AI_MANAGED_LABEL = 'ai-managed';
export const PR_FLOW_STATUS_FIELD_NAME = 'pr-flow-status';

export const STATUS_TO_FIELD_VALUE: Record<IssueStatus, string> = {
  backlog: 'backlog',
  blocked_dep: 'blocked-dep',
  ready: 'ready',
  in_progress: 'in-progress',
  review_pending: 'review-pending',
  fixed: 'fixed',
  needs_human: 'needs-human',
};

export const FIELD_VALUE_TO_STATUS: Record<string, IssueStatus> = Object.fromEntries(
  Object.entries(STATUS_TO_FIELD_VALUE).map(([status, value]) => [value, status as IssueStatus]),
) as Record<string, IssueStatus>;

export interface IssueFieldOptionDefinition {
  name: string;
  color: string;
  description: string;
}

export const PR_FLOW_STATUS_OPTIONS: readonly IssueFieldOptionDefinition[] = [
  { name: 'backlog', color: 'GRAY', description: 'Unrefined or not yet scheduled' },
  { name: 'blocked-dep', color: 'ORANGE', description: 'Blocked by open upstream dependencies' },
  { name: 'ready', color: 'GREEN', description: 'Ready for automated AI pickup' },
  { name: 'in-progress', color: 'YELLOW', description: 'Claimed and actively executing (counts toward WIP limit)' },
  { name: 'review-pending', color: 'BLUE', description: 'PR opened and awaiting human review (uncapped WIP)' },
  { name: 'fixed', color: 'PURPLE', description: 'PR merged and issue resolved' },
  { name: 'needs-human', color: 'RED', description: 'Requires human intervention or clarification' },
];

export const TYPE_TO_LABEL: Record<IssueType, string> = {
  epic: 'type:epic',
  story: 'type:story',
  task: 'type:task',
  bug: 'type:bug',
};

export const LABEL_TO_TYPE: Record<string, IssueType> = Object.fromEntries(
  Object.entries(TYPE_TO_LABEL).map(([type, label]) => [label, type as IssueType]),
) as Record<string, IssueType>;

export interface LabelDefinition {
  name: string;
  color: string;
  description: string;
}

export const DEFAULT_LABELS: readonly LabelDefinition[] = [
  { name: 'type:epic', color: '3e4b9e', description: 'Top-level Agile Epic container (status rolls up)' },
  { name: 'type:story', color: '5319e7', description: 'User Story (container if it has sub-issues, leaf otherwise)' },
  { name: 'type:task', color: '006b75', description: 'Executable engineering task (1 PR per issue)' },
  { name: 'type:bug', color: 'd73a4a', description: 'Executable bug fix (1 PR per issue)' },
  { name: AI_MANAGED_LABEL, color: '0052cc', description: 'Managed by pr-flow automation' },
];

export interface IssueNode {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  status: IssueStatus;
  type: IssueType;
  labels: string[];
  subIssueNumbers: number[];
  blockedByNumbers: number[];
  blockingNumbers: number[];
  linkedPrNumber: number | null;
  parentNumber: number | null;
  updatedAt: string;
}

export function isExecutableLeaf(issue: Pick<IssueNode, 'type' | 'subIssueNumbers'>): boolean {
  if (issue.type === 'task' || issue.type === 'bug') {
    return true;
  }
  if (issue.type === 'story' && issue.subIssueNumbers.length === 0) {
    return true;
  }
  return false;
}

export function isContainerIssue(issue: Pick<IssueNode, 'type' | 'subIssueNumbers'>): boolean {
  return !isExecutableLeaf(issue);
}

export function branchNameForIssue(issueNumber: number): string {
  return `ai/issue-${issueNumber}`;
}

export function extractStatusFromFieldValue(value: string | null | undefined): IssueStatus {
  if (!value) return 'backlog';
  return FIELD_VALUE_TO_STATUS[value] ?? 'backlog';
}

export function extractTypeFromLabels(labels: readonly string[]): IssueType {
  for (const label of labels) {
    const issueType = LABEL_TO_TYPE[label];
    if (issueType) return issueType;
  }
  return 'task';
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
