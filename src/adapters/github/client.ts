import { Octokit } from '@octokit/rest';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import type { DomainError } from '../../domain/errors.js';
import {
  branchNameForIssue,
  extractStatusFromFieldValue,
  extractTypeFromLabels,
  PR_FLOW_STATUS_FIELD_NAME,
  PR_FLOW_STATUS_OPTIONS,
  STATUS_TO_FIELD_VALUE,
  type IssueNode,
  type IssueStatus,
  type LabelDefinition,
} from '../../domain/issue.js';
import type {
  CreateIssueInput,
  CreatePullRequestInput,
  GitHubPort,
  ManagedPrSummary,
  PullRequestSummary,
} from './types.js';

function toGitHubError(context: string, err: unknown): DomainError {
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? Number((err as { status: unknown }).status)
      : undefined;
  const message = err instanceof Error ? err.message : String(err);
  return {
    type: 'GITHUB_API_ERROR',
    message: `${context}: ${message}`,
    status,
    cause: err,
  };
}

interface RawGitHubIssue {
  number: number;
  id: number;
  title: string;
  body?: string | null;
  state: string;
  labels: Array<string | { name?: string }>;
  updated_at: string;
  pull_request?: unknown;
}

interface GraphQLIssueFieldValueNode {
  __typename?: string;
  name?: string;
  field?: {
    id?: string;
    name?: string;
  };
}

interface GraphQLIssueNode {
  number: number;
  title: string;
  body: string | null;
  state: 'OPEN' | 'CLOSED';
  updatedAt: string;
  labels: { nodes: Array<{ name: string }> };
  issueFieldValues?: { nodes: GraphQLIssueFieldValueNode[] };
}

function extractStatusFieldValueFromGraphQL(
  nodes: readonly GraphQLIssueFieldValueNode[] | undefined,
  fieldName: string,
): string | null {
  if (!nodes) return null;
  for (const node of nodes) {
    if (node.field?.name === fieldName && typeof node.name === 'string') {
      return node.name;
    }
  }
  return null;
}

function mapRawIssue(
  raw: RawGitHubIssue,
  subIssueNumbers: number[] = [],
  blockedByNumbers: number[] = [],
  blockingNumbers: number[] = [],
  statusValue: string | null = null,
): IssueNode {
  const labels = raw.labels
    .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
    .filter((l) => l.length > 0);

  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    state: raw.state === 'closed' ? 'closed' : 'open',
    status: extractStatusFromFieldValue(statusValue),
    type: extractTypeFromLabels(labels),
    labels,
    subIssueNumbers,
    blockedByNumbers,
    blockingNumbers,
    linkedPrNumber: null,
    parentNumber: null,
    updatedAt: raw.updated_at,
  };
}

export class OctokitGitHubAdapter implements GitHubPort {
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;
  private readonly statusFieldName: string;
  private cachedStatusField: {
    id: string;
    optionsByName: Map<string, string>;
  } | null = null;

  constructor(options: {
    token: string;
    owner: string;
    repo: string;
    statusFieldName?: string;
  }) {
    this.octokit = new Octokit({ auth: options.token });
    this.owner = options.owner;
    this.repo = options.repo;
    this.statusFieldName = options.statusFieldName ?? PR_FLOW_STATUS_FIELD_NAME;
  }

  private async resolveStatusField(): Promise<{
    id: string;
    optionsByName: Map<string, string>;
  }> {
    if (this.cachedStatusField !== null) {
      return this.cachedStatusField;
    }
    const query = `
      query ResolveIssueField($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          issueFields(first: 20) {
            nodes {
              __typename
              ... on IssueFieldSingleSelect {
                id
                name
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    `;
    const data = await this.octokit.graphql<{
      repository: {
        issueFields: {
          nodes: Array<{
            __typename?: string;
            id?: string;
            name?: string;
            options?: Array<{ id: string; name: string }>;
          }>;
        };
      };
    }>(query, {
      owner: this.owner,
      repo: this.repo,
      headers: { 'GraphQL-Features': 'issue_fields' },
    });

    const match = data.repository.issueFields.nodes.find(
      (f) => f.__typename === 'IssueFieldSingleSelect' && f.name === this.statusFieldName,
    );
    if (!match || !match.id || !match.options) {
      throw new Error(
        `Issue field "${this.statusFieldName}" not found in organization "${this.owner}". Run "pr-flow fields sync --repo ${this.owner}/${this.repo}" with an org-admin token or create it in Organization Settings -> Issue Fields.`,
      );
    }

    this.cachedStatusField = {
      id: match.id,
      optionsByName: new Map(match.options.map((opt) => [opt.name, opt.id])),
    };
    return this.cachedStatusField;
  }

  private getIssueStatusFieldValue(issueNumber: number): TE.TaskEither<DomainError, string | null> {
    return TE.tryCatch(
      async () => {
        const query = `
          query GetIssueFieldValues($owner: String!, $repo: String!, $number: Int!) {
            repository(owner: $owner, name: $repo) {
              issue(number: $number) {
                issueFieldValues(first: 20) {
                  nodes {
                    __typename
                    ... on IssueFieldSingleSelectValue {
                      name
                      field {
                        ... on IssueFieldSingleSelect {
                          name
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        `;
        const data = await this.octokit.graphql<{
          repository: {
            issue: {
              issueFieldValues: { nodes: GraphQLIssueFieldValueNode[] };
            } | null;
          };
        }>(query, {
          owner: this.owner,
          repo: this.repo,
          number: issueNumber,
          headers: { 'GraphQL-Features': 'issue_fields' },
        });
        return extractStatusFieldValueFromGraphQL(
          data.repository.issue?.issueFieldValues.nodes,
          this.statusFieldName,
        );
      },
      (err) => toGitHubError(`Failed to fetch issue field values for #${issueNumber}`, err),
    );
  }

  setIssueStatus(issueNumber: number, status: IssueStatus): TE.TaskEither<DomainError, void> {
    return TE.tryCatch(
      async () => {
        const { id: fieldId, optionsByName } = await this.resolveStatusField();
        const optionName = STATUS_TO_FIELD_VALUE[status];
        const singleSelectOptionId = optionsByName.get(optionName);
        if (!singleSelectOptionId) {
          throw new Error(
            `Option "${optionName}" not found on issue field "${this.statusFieldName}". Run "pr-flow fields sync --repo ${this.owner}/${this.repo}" with an org-admin token.`,
          );
        }

        const issueQuery = `
          query GetIssueNodeId($owner: String!, $repo: String!, $number: Int!) {
            repository(owner: $owner, name: $repo) {
              issue(number: $number) {
                id
              }
            }
          }
        `;
        const issueData = await this.octokit.graphql<{
          repository: { issue: { id: string } | null };
        }>(issueQuery, {
          owner: this.owner,
          repo: this.repo,
          number: issueNumber,
        });
        const issueId = issueData.repository.issue?.id;
        if (!issueId) {
          throw new Error(`Issue #${issueNumber} not found in ${this.owner}/${this.repo}.`);
        }

        const mutation = `
          mutation SetIssueFieldValue($input: SetIssueFieldValueInput!) {
            setIssueFieldValue(input: $input) {
              clientMutationId
            }
          }
        `;
        await this.octokit.graphql(mutation, {
          input: {
            issueId,
            issueFields: [
              {
                fieldId,
                singleSelectOptionId,
              },
            ],
          },
          headers: { 'GraphQL-Features': 'issue_fields' },
        });
      },
      (err) => toGitHubError(`Failed to set "${this.statusFieldName}" on #${issueNumber} to "${status}"`, err),
    );
  }

  ensureStatusField(): TE.TaskEither<DomainError, void> {
    return TE.tryCatch(
      async () => {
        const res = await this.octokit.request('GET /orgs/{org}/issue-fields', {
          org: this.owner,
        });
        const fields = res.data as Array<{ id: number; name: string }>;
        const existing = fields.find((f) => f.name === this.statusFieldName);
        if (existing) {
          return;
        }
        await this.octokit.request('POST /orgs/{org}/issue-fields', {
          org: this.owner,
          name: this.statusFieldName,
          data_type: 'single_select',
          description: 'pr-flow automated Issue-to-PR lifecycle status',
          options: PR_FLOW_STATUS_OPTIONS.map((opt) => ({
            name: opt.name,
            color: opt.color,
            description: opt.description,
          })),
        });
      },
      (err) => {
        const baseErr = toGitHubError(
          `Failed to ensure "${this.statusFieldName}" issue field in org "${this.owner}"`,
          err,
        );
        if (baseErr.type === 'GITHUB_API_ERROR' && baseErr.status === 403) {
          const optionNames = PR_FLOW_STATUS_OPTIONS.map((o) => o.name).join(', ');
          return {
            ...baseErr,
            message:
              `Failed to ensure "${this.statusFieldName}" issue field in org "${this.owner}" (HTTP 403: token lacks organization-admin permissions for org-level Issue Fields). ` +
              `Run \`GITHUB_TOKEN=$(gh auth token) npx --yes github:<owner>/pr-flow#v1 fields sync --repo ${this.owner}/${this.repo}\` with an org-admin token, ` +
              `or create the single-select field "${this.statusFieldName}" (options: ${optionNames}) at https://github.com/organizations/${this.owner}/settings/issue-fields.`,
          };
        }
        if (baseErr.type === 'GITHUB_API_ERROR' && baseErr.status === 404) {
          return {
            ...baseErr,
            message:
              `Failed to ensure "${this.statusFieldName}" issue field in org "${this.owner}" (HTTP 404: "${this.owner}" may be a personal account rather than a GitHub Organization, or Issue Fields are not enabled).`,
          };
        }
        return baseErr;
      },
    );
  }

  getIssue(issueNumber: number): TE.TaskEither<DomainError, IssueNode> {
    return pipe(
      TE.tryCatch(
        () =>
          this.octokit.rest.issues.get({
            owner: this.owner,
            repo: this.repo,
            issue_number: issueNumber,
          }),
        (err) => toGitHubError(`Failed to fetch issue #${issueNumber}`, err),
      ),
      TE.chain((res) =>
        pipe(
          TE.Do,
          TE.apS('subIssues', this.listSubIssues(issueNumber)),
          TE.apS('blockedBy', this.listBlockedBy(issueNumber)),
          TE.apS('blocking', this.listBlocking(issueNumber)),
          TE.apS('statusValue', this.getIssueStatusFieldValue(issueNumber)),
          TE.map(({ subIssues, blockedBy, blocking, statusValue }) =>
            mapRawIssue(
              res.data as RawGitHubIssue,
              subIssues,
              blockedBy.map((b) => b.number),
              blocking,
              statusValue,
            ),
          ),
        ),
      ),
    );
  }

  listAllIssues(state: 'open' | 'closed' | 'all' = 'all'): TE.TaskEither<DomainError, IssueNode[]> {
    return TE.tryCatch(
      async () => {
        const states =
          state === 'open' ? ['OPEN'] : state === 'closed' ? ['CLOSED'] : ['OPEN', 'CLOSED'];
        const query = `
          query ListIssuesWithFields($owner: String!, $repo: String!, $states: [IssueState!], $after: String) {
            repository(owner: $owner, name: $repo) {
              issues(first: 100, states: $states, after: $after) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  number
                  title
                  body
                  state
                  updatedAt
                  labels(first: 30) {
                    nodes {
                      name
                    }
                  }
                  issueFieldValues(first: 20) {
                    nodes {
                      __typename
                      ... on IssueFieldSingleSelectValue {
                        name
                        field {
                          ... on IssueFieldSingleSelect {
                            name
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        `;

        const results: IssueNode[] = [];
        let after: string | null = null;

        while (true) {
          const data: {
            repository: {
              issues: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
                nodes: GraphQLIssueNode[];
              };
            };
          } = await this.octokit.graphql(query, {
            owner: this.owner,
            repo: this.repo,
            states,
            after,
            headers: { 'GraphQL-Features': 'issue_fields' },
          });

          for (const node of data.repository.issues.nodes) {
            const labels = node.labels.nodes.map((l) => l.name);
            const statusValue = extractStatusFieldValueFromGraphQL(
              node.issueFieldValues?.nodes,
              this.statusFieldName,
            );
            results.push({
              number: node.number,
              title: node.title,
              body: node.body ?? '',
              state: node.state === 'CLOSED' ? 'closed' : 'open',
              status: extractStatusFromFieldValue(statusValue),
              type: extractTypeFromLabels(labels),
              labels,
              subIssueNumbers: [],
              blockedByNumbers: [],
              blockingNumbers: [],
              linkedPrNumber: null,
              parentNumber: null,
              updatedAt: node.updatedAt,
            });
          }

          if (!data.repository.issues.pageInfo.hasNextPage) {
            break;
          }
          after = data.repository.issues.pageInfo.endCursor;
        }

        return results;
      },
      (err) => toGitHubError('Failed to list repository issues', err),
    );
  }

  createIssue(input: CreateIssueInput): TE.TaskEither<DomainError, { number: number; url: string }> {
    return TE.tryCatch(
      async () => {
        const res = await this.octokit.rest.issues.create({
          owner: this.owner,
          repo: this.repo,
          title: input.title,
          body: input.body,
          labels: input.labels,
        });
        return { number: res.data.number, url: res.data.html_url };
      },
      (err) => toGitHubError(`Failed to create issue "${input.title}"`, err),
    );
  }

  closeIssue(issueNumber: number): TE.TaskEither<DomainError, void> {
    return TE.tryCatch(
      async () => {
        await this.octokit.rest.issues.update({
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
          state: 'closed',
        });
      },
      (err) => toGitHubError(`Failed to close issue #${issueNumber}`, err),
    );
  }

  reopenIssue(issueNumber: number): TE.TaskEither<DomainError, void> {
    return TE.tryCatch(
      async () => {
        await this.octokit.rest.issues.update({
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
          state: 'open',
        });
      },
      (err) => toGitHubError(`Failed to reopen issue #${issueNumber}`, err),
    );
  }

  addLabels(issueNumber: number, labels: string[]): TE.TaskEither<DomainError, void> {
    if (labels.length === 0) return TE.right(undefined);
    return TE.tryCatch(
      async () => {
        await this.octokit.rest.issues.addLabels({
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
          labels,
        });
      },
      (err) => toGitHubError(`Failed to add labels to #${issueNumber}`, err),
    );
  }

  removeLabel(issueNumber: number, label: string): TE.TaskEither<DomainError, void> {
    return TE.tryCatch(
      async () => {
        try {
          await this.octokit.rest.issues.removeLabel({
            owner: this.owner,
            repo: this.repo,
            issue_number: issueNumber,
            name: label,
          });
        } catch (err: unknown) {
          // Ignore 404 when label is not currently on the issue
          if (typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 404) {
            return;
          }
          throw err;
        }
      },
      (err) => toGitHubError(`Failed to remove label "${label}" from #${issueNumber}`, err),
    );
  }

  addComment(issueNumber: number, body: string): TE.TaskEither<DomainError, void> {
    return this.addCommentImpl(issueNumber, body);
  }

  private addCommentImpl(issueNumber: number, body: string): TE.TaskEither<DomainError, void> {
    return TE.tryCatch(
      async () => {
        await this.octokit.rest.issues.createComment({
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
          body,
        });
      },
      (err) => toGitHubError(`Failed to comment on #${issueNumber}`, err),
    );
  }

  listIssueComments(issueNumber: number): TE.TaskEither<DomainError, string[]> {
    return TE.tryCatch(
      async () => {
        const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
          per_page: 100,
        });
        return comments.map((c) => c.body ?? '');
      },
      (err) => toGitHubError(`Failed to list comments for #${issueNumber}`, err),
    );
  }

  dispatchWorkflow(
    workflowFile: string,
    ref: string,
    inputs: Record<string, string>,
  ): TE.TaskEither<DomainError, void> {
    return TE.tryCatch(
      async () => {
        await this.octokit.rest.actions.createWorkflowDispatch({
          owner: this.owner,
          repo: this.repo,
          workflow_id: workflowFile,
          ref,
          inputs,
        });
      },
      (err) => toGitHubError(`Failed to dispatch workflow ${workflowFile}`, err),
    );
  }

  ensureLabels(labels: readonly LabelDefinition[]): TE.TaskEither<DomainError, void> {
    return TE.tryCatch(
      async () => {
        const existing = await this.octokit.paginate(this.octokit.rest.issues.listLabelsForRepo, {
          owner: this.owner,
          repo: this.repo,
          per_page: 100,
        });
        const existingByName = new Map(existing.map((l) => [l.name, l]));

        for (const label of labels) {
          const current = existingByName.get(label.name);
          if (!current) {
            await this.octokit.rest.issues.createLabel({
              owner: this.owner,
              repo: this.repo,
              name: label.name,
              color: label.color,
              description: label.description,
            });
          } else if (current.color.toLowerCase() !== label.color.toLowerCase()) {
            await this.octokit.rest.issues.updateLabel({
              owner: this.owner,
              repo: this.repo,
              name: label.name,
              color: label.color,
              description: label.description,
            });
          }
        }
      },
      (err) => toGitHubError('Failed to ensure repository labels', err),
    );
  }

  listSubIssues(issueNumber: number): TE.TaskEither<DomainError, number[]> {
    return TE.tryCatch(
      async () => {
        try {
          const res = await this.octokit.request(
            'GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues',
            {
              owner: this.owner,
              repo: this.repo,
              issue_number: issueNumber,
              per_page: 100,
            },
          );
          const data = res.data as Array<{ number: number }>;
          return data.map((d) => d.number);
        } catch (err: unknown) {
          if (typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 404) {
            return [];
          }
          throw err;
        }
      },
      (err) => toGitHubError(`Failed to list sub-issues for #${issueNumber}`, err),
    );
  }

  addSubIssue(parentNumber: number, childNumber: number): TE.TaskEither<DomainError, void> {
    return TE.tryCatch(
      async () => {
        const child = await this.octokit.rest.issues.get({
          owner: this.owner,
          repo: this.repo,
          issue_number: childNumber,
        });
        await this.octokit.request(
          'POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues',
          {
            owner: this.owner,
            repo: this.repo,
            issue_number: parentNumber,
            sub_issue_id: child.data.id,
          },
        );
      },
      (err) => toGitHubError(`Failed to link sub-issue #${childNumber} to #${parentNumber}`, err),
    );
  }

  listBlockedBy(issueNumber: number): TE.TaskEither<DomainError, IssueNode[]> {
    return TE.tryCatch(
      async () => {
        try {
          const res = await this.octokit.request(
            'GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by',
            {
              owner: this.owner,
              repo: this.repo,
              issue_number: issueNumber,
              per_page: 100,
            },
          );
          const data = res.data as RawGitHubIssue[];
          return data.map((d) => mapRawIssue(d));
        } catch (err: unknown) {
          if (typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 404) {
            return [];
          }
          throw err;
        }
      },
      (err) => toGitHubError(`Failed to list blocked_by for #${issueNumber}`, err),
    );
  }

  listBlocking(issueNumber: number): TE.TaskEither<DomainError, number[]> {
    return TE.tryCatch(
      async () => {
        try {
          const res = await this.octokit.request(
            'GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocking',
            {
              owner: this.owner,
              repo: this.repo,
              issue_number: issueNumber,
              per_page: 100,
            },
          );
          const data = res.data as Array<{ number: number }>;
          return data.map((d) => d.number);
        } catch (err: unknown) {
          if (typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 404) {
            return [];
          }
          throw err;
        }
      },
      (err) => toGitHubError(`Failed to list blocking issues for #${issueNumber}`, err),
    );
  }

  addBlockedBy(issueNumber: number, blockerNumber: number): TE.TaskEither<DomainError, void> {
    return TE.tryCatch(
      async () => {
        const blocker = await this.octokit.rest.issues.get({
          owner: this.owner,
          repo: this.repo,
          issue_number: blockerNumber,
        });
        await this.octokit.request(
          'POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by',
          {
            owner: this.owner,
            repo: this.repo,
            issue_number: issueNumber,
            issue_id: blocker.data.id,
          },
        );
      },
      (err) => toGitHubError(`Failed to add blocked_by #${blockerNumber} on #${issueNumber}`, err),
    );
  }

  listOpenPrsForIssue(issueNumber: number): TE.TaskEither<DomainError, PullRequestSummary[]> {
    return TE.tryCatch(
      async () => {
        const branch = branchNameForIssue(issueNumber);
        const prs = await this.octokit.rest.pulls.list({
          owner: this.owner,
          repo: this.repo,
          state: 'open',
          head: `${this.owner}:${branch}`,
        });
        return prs.data.map((pr) => ({
          number: pr.number,
          url: pr.html_url,
          headRef: pr.head.ref,
          state: pr.state === 'closed' ? 'closed' : 'open',
          merged: false,
        }));
      },
      (err) => toGitHubError(`Failed to list open PRs for #${issueNumber}`, err),
    );
  }

  listOpenAiManagedPrs(): TE.TaskEither<DomainError, ManagedPrSummary[]> {
    return TE.tryCatch(
      async () => {
        const prs = await this.octokit.paginate(this.octokit.rest.pulls.list, {
          owner: this.owner,
          repo: this.repo,
          state: 'open',
          per_page: 100,
        });
        const results: ManagedPrSummary[] = [];
        for (const pr of prs) {
          const hasLabel = pr.labels.some((l) => l.name === 'ai-managed');
          const match = /^ai\/issue-(\d+)$/.exec(pr.head.ref);
          if (!hasLabel || !match) continue;
          const issueNumber = Number(match[1]);

          const reviews = await this.octokit.rest.pulls.listReviews({
            owner: this.owner,
            repo: this.repo,
            pull_number: pr.number,
          });
          const decisive = reviews.data.filter(
            (r) => r.state === 'CHANGES_REQUESTED' || r.state === 'APPROVED' || r.state === 'DISMISSED',
          );
          const latestReviewState = decisive.length > 0 ? decisive[decisive.length - 1]!.state : null;

          results.push({
            number: pr.number,
            headRef: pr.head.ref,
            issueNumber,
            updatedAt: pr.updated_at,
            latestReviewState,
          });
        }
        return results;
      },
      (err) => toGitHubError('Failed to list open ai-managed PRs', err),
    );
  }

  createPullRequest(input: CreatePullRequestInput): TE.TaskEither<DomainError, PullRequestSummary> {
    return TE.tryCatch(
      async () => {
        const res = await this.octokit.rest.pulls.create({
          owner: this.owner,
          repo: this.repo,
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
        });
        if (input.labels && input.labels.length > 0) {
          await this.octokit.rest.issues.addLabels({
            owner: this.owner,
            repo: this.repo,
            issue_number: res.data.number,
            labels: input.labels,
          });
        }
        return {
          number: res.data.number,
          url: res.data.html_url,
          headRef: res.data.head.ref,
          state: res.data.state === 'closed' ? 'closed' : 'open',
          merged: res.data.merged ?? false,
        };
      },
      (err) => toGitHubError(`Failed to create PR for branch ${input.head}`, err),
    );
  }

  mergePullRequest(
    prNumber: number,
    method: 'squash' | 'merge' | 'rebase',
  ): TE.TaskEither<DomainError, void> {
    return TE.tryCatch(
      async () => {
        await this.octokit.rest.pulls.merge({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
          merge_method: method,
        });
      },
      (err) => toGitHubError(`Failed to merge PR #${prNumber}`, err),
    );
  }

  addPrComment(prNumber: number, body: string): TE.TaskEither<DomainError, void> {
    return this.addComment(prNumber, body);
  }

  getPrReviewComments(prNumber: number): TE.TaskEither<DomainError, string[]> {
    return TE.tryCatch(
      async () => {
        const [reviews, reviewComments, issueComments] = await Promise.all([
          this.octokit.rest.pulls.listReviews({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
          }),
          this.octokit.rest.pulls.listReviewComments({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
          }),
          this.octokit.rest.issues.listComments({
            owner: this.owner,
            repo: this.repo,
            issue_number: prNumber,
          }),
        ]);

        const collected: string[] = [];
        for (const r of reviews.data) {
          if (r.body && r.body.trim().length > 0) {
            collected.push(`[Review ${r.state} by ${r.user?.login ?? 'unknown'}]: ${r.body}`);
          }
        }
        for (const rc of reviewComments.data) {
          collected.push(
            `[Inline comment on ${rc.path}:${rc.line ?? rc.original_line ?? '?'} by ${rc.user?.login ?? 'unknown'}]: ${rc.body}`,
          );
        }
        for (const ic of issueComments.data) {
          if (ic.user?.type !== 'Bot') {
            collected.push(`[PR comment by ${ic.user?.login ?? 'unknown'}]: ${ic.body ?? ''}`);
          }
        }
        return collected;
      },
      (err) => toGitHubError(`Failed to fetch review comments for PR #${prNumber}`, err),
    );
  }
}
