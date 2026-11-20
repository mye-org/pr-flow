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

export type Priority = 'p0' | 'p1' | 'p2' | 'p3';

export const AI_MANAGED_LABEL = 'ai-managed';

export const STATUS_TO_LABEL: Record<IssueStatus, string> = {
  backlog: 'status:backlog',
  blocked_dep: 'status:blocked-dep',
  ready: 'status:ready',
  in_progress: 'status:in-progress',
  review_pending: 'status:review-pending',
  fixed: 'status:fixed',
  needs_human: 'status:needs-human',
};

export const LABEL_TO_STATUS: Record<string, IssueStatus> = Object.fromEntries(
  Object.entries(STATUS_TO_LABEL).map(([status, label]) => [label, status as IssueStatus]),
) as Record<string, IssueStatus>;

export const TYPE_TO_LABEL: Record<IssueType, string> = {
  epic: 'type:epic',
  story: 'type:story',
  task: 'type:task',
  bug: 'type:bug',
};

export const LABEL_TO_TYPE: Record<string, IssueType> = Object.fromEntries(
  Object.entries(TYPE_TO_LABEL).map(([type, label]) => [label, type as IssueType]),
) as Record<string, IssueType>;

export const PRIORITY_TO_LABEL: Record<Priority, string> = {
  p0: 'priority:p0',
  p1: 'priority:p1',
  p2: 'priority:p2',
  p3: 'priority:p3',
};

export const LABEL_TO_PRIORITY: Record<string, Priority> = Object.fromEntries(
  Object.entries(PRIORITY_TO_LABEL).map(([priority, label]) => [label, priority as Priority]),
) as Record<string, Priority>;

export interface LabelDefinition {
  name: string;
  color: string;
  description: string;
}

export const DEFAULT_LABELS: readonly LabelDefinition[] = [
  { name: 'status:backlog', color: 'ededed', description: 'Unrefined or not yet scheduled' },
  { name: 'status:blocked-dep', color: 'd93f0b', description: 'Blocked by open upstream dependencies' },
  { name: 'status:ready', color: '0e8a16', description: 'Ready for automated AI pickup' },
  { name: 'status:in-progress', color: 'fbca04', description: 'Claimed and actively executing (counts toward WIP limit)' },
  { name: 'status:review-pending', color: '1d76db', description: 'PR opened and awaiting human review (uncapped WIP)' },
  { name: 'status:fixed', color: '6f42c1', description: 'PR merged and issue resolved' },
  { name: 'status:needs-human', color: 'b60205', description: 'Requires human intervention or clarification' },
  { name: 'type:epic', color: '3e4b9e', description: 'Top-level Agile Epic container (status rolls up)' },
  { name: 'type:story', color: '5319e7', description: 'User Story (container if it has sub-issues, leaf otherwise)' },
  { name: 'type:task', color: '006b75', description: 'Executable engineering task (1 PR per issue)' },
  { name: 'type:bug', color: 'd73a4a', description: 'Executable bug fix (1 PR per issue)' },
  { name: 'priority:p0', color: 'b60205', description: 'Critical priority' },
  { name: 'priority:p1', color: 'd93f0b', description: 'High priority' },
  { name: 'priority:p2', color: 'fbca04', description: 'Medium priority' },
  { name: 'priority:p3', color: 'c2e0c6', description: 'Low priority' },
  { name: AI_MANAGED_LABEL, color: '0052cc', description: 'Managed by pr-flow automation' },
];

export interface IssueNode {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  status: IssueStatus;
  type: IssueType;
  priority: Priority;
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

export function extractStatusFromLabels(labels: readonly string[]): IssueStatus {
  for (const label of labels) {
    const status = LABEL_TO_STATUS[label];
    if (status) return status;
  }
  return 'backlog';
}

export function extractTypeFromLabels(labels: readonly string[]): IssueType {
  for (const label of labels) {
    const issueType = LABEL_TO_TYPE[label];
    if (issueType) return issueType;
  }
  return 'task';
}

export function extractPriorityFromLabels(labels: readonly string[]): Priority {
  for (const label of labels) {
    const priority = LABEL_TO_PRIORITY[label];
    if (priority) return priority;
  }
  return 'p2';
}

export const AgentResultSchema = z.object({
  status: z.enum(['success', 'needs_human', 'failed']),
  summary: z.string().min(1),
  reason: z.string().optional(),
  testsRun: z.boolean().optional(),
  filesChanged: z.array(z.string()).optional(),
});

export type AgentResult = z.infer<typeof AgentResultSchema>;
