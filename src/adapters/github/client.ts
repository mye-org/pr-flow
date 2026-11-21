import { Octokit } from '@octokit/rest';
import { pipe } from 'fp-ts/lib/function';
import * as O from 'fp-ts/lib/Option';
import * as TE from 'fp-ts/lib/TaskEither';
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
import {
  isoBody,
  isoBranchName,
  isoCount,
  isoFieldOptionName,
  isoHexColor,
  isoIsoTimestamp,
  isoIssueNumber,
  isoLabelName,
  isoMessage,
  isoTitle,
} from '../../domain/newtypes.js';
import type {
  CreateIssueInput,
  CreatePullRequestInput,
  GitHubPort,
  ManagedPrSummary,
  PreflightCheckResult,
  PrReviewThread,
} from './types.js';

function toGitHubError(context: string, err: unknown) {
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? Number(err.status)
      : undefined;
  const message = err instanceof Error ? err.message : String(err);
  return {
    type: 'GITHUB_API_ERROR',
    message: isoMessage.wrap(`${context}: ${message}`),
    status: status !== undefined && Number.isFinite(status) ? O.some(isoCount.wrap(status)) : O.none,
    cause: O.some(isoMessage.wrap(message)),
  } satisfies DomainError;
}

type RawGitHubIssue = {
  number: number;
  id: number;
  title: string;
  body?: string | null;
  state: string;
  labels: ReadonlyArray<string | { name?: string }>;
  updated_at: string;
  pull_request?: unknown;
};

type GraphQLIssueFieldValueNode = {
  __typename?: string;
  name?: string;
  field?: {
    id?: string;
    name?: string;
  };
};

type GraphQLIssueNode = {
  number: number;
  title: string;
  body: string | null;
  state: 'OPEN' | 'CLOSED';
  updatedAt: string;
  labels: { nodes: ReadonlyArray<{ name: string }> };
  issueFieldValues?: { nodes: ReadonlyArray<GraphQLIssueFieldValueNode> };
};

function extractStatusFieldValueFromGraphQL(
  nodes: ReadonlyArray<GraphQLIssueFieldValueNode> | undefined,
  fieldName: string,
) {
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
  subIssueNumbers: ReadonlyArray<number> = [],
  blockedByNumbers: ReadonlyArray<number> = [],
  blockingNumbers: ReadonlyArray<number> = [],
  statusValue: string | null = null,
) {
  const labels = raw.labels
    .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
    .filter((l) => l.length > 0)
    .map(isoLabelName.wrap);

  return {
    number: isoIssueNumber.wrap(raw.number),
    title: isoTitle.wrap(raw.title),
    body: isoBody.wrap(raw.body ?? ''),
    state: raw.state === 'closed' ? ('closed' as const) : ('open' as const),
    status: extractStatusFromFieldValue(O.fromNullable(statusValue)),
    type: extractTypeFromLabels(labels),
    labels,
    subIssueNumbers: subIssueNumbers.map(isoIssueNumber.wrap),
    blockedByNumbers: blockedByNumbers.map(isoIssueNumber.wrap),
    blockingNumbers: blockingNumbers.map(isoIssueNumber.wrap),
    linkedPrNumber: O.none,
    parentNumber: O.none,
    updatedAt: isoIsoTimestamp.wrap(raw.updated_at),
  };
}

export class OctokitGitHubAdapter implements GitHubPort {
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;
  private readonly statusFieldName: string;
  private cachedStatusField: {
    id: string;
    optionsByName: ReadonlyMap<string, string>;
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

  private async findStatusFieldViaGraphql() {
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
          nodes: ReadonlyArray<{
            __typename?: string;
            id?: string;
            name?: string;
            options?: ReadonlyArray<{ id: string; name: string }>;
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
      return null;
    }

    this.cachedStatusField = {
      id: match.id,
      optionsByName: new Map(match.options.map((opt) => [opt.name, opt.id])),
    };
    return this.cachedStatusField;
  }

  private async resolveStatusField() {
    const field = await this.findStatusFieldViaGraphql();
    if (!field) {
      throw new Error(
        `Issue field "${this.statusFieldName}" not found in organization "${this.owner}". Run "pr-flow fields sync --repo ${this.owner}/${this.repo}" with an org-admin token or create it in Organization Settings -> Issue Fields.`,
      );
    }
    return field;
  }

  private getIssueStatusFieldValue(issueNumber: number) {
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
              issueFieldValues: { nodes: ReadonlyArray<GraphQLIssueFieldValueNode> };
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
      (err) => toGitHubError(`Failed to fetch issue field values for #${String(issueNumber)}`, err),
    );
  }

  setIssueStatus(issueNumber: number, status: IssueStatus) {
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
          throw new Error(`Issue #${String(issueNumber)} not found in ${this.owner}/${this.repo}.`);
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
      (err) =>
        toGitHubError(
          `Failed to set "${this.statusFieldName}" on #${String(issueNumber)} to "${status}"`,
          err,
        ),
    );
  }

  ensureStatusField() {
    return TE.tryCatch(
      async () => {
        const existing = await this.findStatusFieldViaGraphql();
        if (existing) {
          const missing = PR_FLOW_STATUS_OPTIONS.filter(
            (opt) => !existing.optionsByName.has(isoFieldOptionName.unwrap(opt.name)),
          );
          if (missing.length > 0) {
            throw new Error(
              `Issue field "${this.statusFieldName}" exists in "${this.owner}" but is missing required options: ${missing.map((m) => isoFieldOptionName.unwrap(m.name)).join(', ')}. ` +
                `Add them at https://github.com/organizations/${this.owner}/settings/issue-fields.`,
            );
          }
          return;
        }
        await this.octokit.request('POST /orgs/{org}/issue-fields', {
          org: this.owner,
          name: this.statusFieldName,
          data_type: 'single_select',
          description: 'pr-flow automated Issue-to-PR lifecycle status',
          options: PR_FLOW_STATUS_OPTIONS.map((opt) => ({
            name: isoFieldOptionName.unwrap(opt.name),
            color: isoHexColor.unwrap(opt.color),
            description: isoMessage.unwrap(opt.description),
          })),
        });
      },
      (err) => {
        const baseErr = toGitHubError(
          `Failed to ensure "${this.statusFieldName}" issue field in org "${this.owner}"`,
          err,
        );
        if (O.isSome(baseErr.status) && isoCount.unwrap(baseErr.status.value) === 403) {
          const optionNames = PR_FLOW_STATUS_OPTIONS.map((o) =>
            isoFieldOptionName.unwrap(o.name),
          ).join(', ');
          return {
            ...baseErr,
            message: isoMessage.wrap(
              `Failed to create "${this.statusFieldName}" issue field in org "${this.owner}" (HTTP 403: token lacks organization-admin permissions to create org-level Issue Fields). ` +
                `Run \`GITHUB_TOKEN=$(gh auth token) npx --yes github:mye-org/pr-flow#v1 fields sync --repo ${this.owner}/${this.repo}\` with an org-admin token, ` +
                `or create the single-select field "${this.statusFieldName}" (options: ${optionNames}) at https://github.com/organizations/${this.owner}/settings/issue-fields.`,
            ),
          };
        }
        if (O.isSome(baseErr.status) && isoCount.unwrap(baseErr.status.value) === 404) {
          return {
            ...baseErr,
            message: isoMessage.wrap(
              `Failed to ensure "${this.statusFieldName}" issue field in org "${this.owner}" (HTTP 404: "${this.owner}" may be a personal account rather than a GitHub Organization, or Issue Fields are not enabled).`,
            ),
          };
        }
        return baseErr;
      },
    );
  }

  getIssue(issueNumber: number) {
    return pipe(
      TE.tryCatch(
        () =>
          this.octokit.rest.issues.get({
            owner: this.owner,
            repo: this.repo,
            issue_number: issueNumber,
          }),
        (err) => toGitHubError(`Failed to fetch issue #${String(issueNumber)}`, err),
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
              blockedBy.map((b) => isoIssueNumber.unwrap(b.number)),
              blocking,
              statusValue,
            ),
          ),
        ),
      ),
    );
  }

  listAllIssues(
    state: 'open' | 'closed' | 'all' = 'all',
  ) {
    return TE.tryCatch(
      async () => {
        const states = (() => {
          if (state === 'open') return ['OPEN'];
          if (state === 'closed') return ['CLOSED'];
          return ['OPEN', 'CLOSED'];
        })();
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

        let results: ReadonlyArray<IssueNode> = [];
        let after: string | null = null;

        for (;;) {
          const data: {
            repository: {
              issues: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
                nodes: ReadonlyArray<GraphQLIssueNode>;
              };
            };
          } = await this.octokit.graphql(query, {
            owner: this.owner,
            repo: this.repo,
            states,
            after,
            headers: { 'GraphQL-Features': 'issue_fields' },
          });

          const pageNodes: ReadonlyArray<IssueNode> = data.repository.issues.nodes.map((node) => {
            const labels = node.labels.nodes.map((l) => isoLabelName.wrap(l.name));
            const statusValue = extractStatusFieldValueFromGraphQL(
              node.issueFieldValues?.nodes,
              this.statusFieldName,
            );
            return {
              number: isoIssueNumber.wrap(node.number),
              title: isoTitle.wrap(node.title),
              body: isoBody.wrap(node.body ?? ''),
              state: node.state === 'CLOSED' ? ('closed' as const) : ('open' as const),
              status: extractStatusFromFieldValue(O.fromNullable(statusValue)),
              type: extractTypeFromLabels(labels),
              labels,
              subIssueNumbers: [],
              blockedByNumbers: [],
              blockingNumbers: [],
              linkedPrNumber: O.none,
              parentNumber: O.none,
              updatedAt: isoIsoTimestamp.wrap(node.updatedAt),
            };
          });
          results = [...results, ...pageNodes];

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

  createIssue(
    input: CreateIssueInput,
  ) {
    return TE.tryCatch(
      async () => {
        const res = await this.octokit.rest.issues.create({
          owner: this.owner,
          repo: this.repo,
          title: input.title,
          body: input.body,
          labels: [...input.labels],
        });
        return { number: res.data.number, url: res.data.html_url };
      },
      (err) => toGitHubError(`Failed to create issue "${input.title}"`, err),
    );
  }

  closeIssue(issueNumber: number) {
    return TE.tryCatch(
      async () => {
        await this.octokit.rest.issues.update({
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
          state: 'closed',
        });
      },
      (err) => toGitHubError(`Failed to close issue #${String(issueNumber)}`, err),
    );
  }

  reopenIssue(issueNumber: number) {
    return TE.tryCatch(
      async () => {
        await this.octokit.rest.issues.update({
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
          state: 'open',
        });
      },
      (err) => toGitHubError(`Failed to reopen issue #${String(issueNumber)}`, err),
    );
  }

  addLabels(issueNumber: number, labels: ReadonlyArray<string>) {
    if (labels.length === 0) return TE.right(undefined);
    return TE.tryCatch(
      async () => {
        await this.octokit.rest.issues.addLabels({
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
          labels: [...labels],
        });
      },
      (err) => toGitHubError(`Failed to add labels to #${String(issueNumber)}`, err),
    );
  }

  removeLabel(issueNumber: number, label: string) {
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
      (err) => toGitHubError(`Failed to remove label "${label}" from #${String(issueNumber)}`, err),
    );
  }

  addComment(issueNumber: number, body: string) {
    return this.addCommentImpl(issueNumber, body);
  }

  private addCommentImpl(issueNumber: number, body: string) {
    return TE.tryCatch(
      async () => {
        await this.octokit.rest.issues.createComment({
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
          body,
        });
      },
      (err) => toGitHubError(`Failed to comment on #${String(issueNumber)}`, err),
    );
  }

  listIssueComments(issueNumber: number) {
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
      (err) => toGitHubError(`Failed to list comments for #${String(issueNumber)}`, err),
    );
  }

  dispatchWorkflow(
    workflowFile: string,
    ref: string,
    inputs: Readonly<Record<string, string>>,
  ) {
    return TE.tryCatch(
      async () => {
        await this.octokit.rest.actions.createWorkflowDispatch({
          owner: this.owner,
          repo: this.repo,
          workflow_id: workflowFile,
          ref,
          inputs: { ...inputs },
        });
      },
      (err) => toGitHubError(`Failed to dispatch workflow ${workflowFile}`, err),
    );
  }

  ensureLabels(labels: ReadonlyArray<LabelDefinition>) {
    return TE.tryCatch(
      async () => {
        const existing = await this.octokit.paginate(this.octokit.rest.issues.listLabelsForRepo, {
          owner: this.owner,
          repo: this.repo,
          per_page: 100,
        });
        const existingByName = new Map(existing.map((l) => [l.name, l]));

        for (const label of labels) {
          const name = isoLabelName.unwrap(label.name);
          const color = isoHexColor.unwrap(label.color);
          const description = isoMessage.unwrap(label.description);
          const current = existingByName.get(name);
          if (!current) {
            await this.octokit.rest.issues.createLabel({
              owner: this.owner,
              repo: this.repo,
              name,
              color,
              description,
            });
          } else if (current.color.toLowerCase() !== color.toLowerCase()) {
            await this.octokit.rest.issues.updateLabel({
              owner: this.owner,
              repo: this.repo,
              name,
              color,
              description,
            });
          }
        }
      },
      (err) => toGitHubError('Failed to ensure repository labels', err),
    );
  }

  listSubIssues(issueNumber: number) {
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
          const data = res.data as ReadonlyArray<{ number: number }>;
          return data.map((d) => d.number);
        } catch (err: unknown) {
          if (typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 404) {
            return [];
          }
          throw err;
        }
      },
      (err) => toGitHubError(`Failed to list sub-issues for #${String(issueNumber)}`, err),
    );
  }

  addSubIssue(parentNumber: number, childNumber: number) {
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
      (err) =>
        toGitHubError(
          `Failed to link sub-issue #${String(childNumber)} to #${String(parentNumber)}`,
          err,
        ),
    );
  }

  listBlockedBy(issueNumber: number) {
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
          const data = res.data as ReadonlyArray<RawGitHubIssue>;
          return data.map((d) => mapRawIssue(d));
        } catch (err: unknown) {
          if (typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 404) {
            return [];
          }
          throw err;
        }
      },
      (err) => toGitHubError(`Failed to list blocked_by for #${String(issueNumber)}`, err),
    );
  }

  listBlocking(issueNumber: number) {
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
          const data = res.data as ReadonlyArray<{ number: number }>;
          return data.map((d) => d.number);
        } catch (err: unknown) {
          if (typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 404) {
            return [];
          }
          throw err;
        }
      },
      (err) => toGitHubError(`Failed to list blocking issues for #${String(issueNumber)}`, err),
    );
  }

  addBlockedBy(issueNumber: number, blockerNumber: number) {
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
      (err) =>
        toGitHubError(
          `Failed to add blocked_by #${String(blockerNumber)} on #${String(issueNumber)}`,
          err,
        ),
    );
  }

  listOpenPrsForIssue(issueNumber: number) {
    return TE.tryCatch(
      async () => {
        const branch = isoBranchName.unwrap(branchNameForIssue(isoIssueNumber.wrap(issueNumber)));
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
          state: pr.state === 'closed' ? ('closed' as const) : ('open' as const),
          merged: false,
        }));
      },
      (err) => toGitHubError(`Failed to list open PRs for #${String(issueNumber)}`, err),
    );
  }

  listOpenAiManagedPrs() {
    return TE.tryCatch(
      async () => {
        const prs = await this.octokit.paginate(this.octokit.rest.pulls.list, {
          owner: this.owner,
          repo: this.repo,
          state: 'open',
          per_page: 100,
        });
        let results: ReadonlyArray<ManagedPrSummary> = [];
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
          const latestReviewState = decisive[decisive.length - 1]?.state ?? null;

          results = [
            ...results,
            {
              number: pr.number,
              headRef: pr.head.ref,
              issueNumber,
              updatedAt: pr.updated_at,
              latestReviewState,
            },
          ];
        }
        return results;
      },
      (err) => toGitHubError('Failed to list open ai-managed PRs', err),
    );
  }

  createPullRequest(input: CreatePullRequestInput) {
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
            labels: [...input.labels],
          });
        }
        return {
          number: res.data.number,
          url: res.data.html_url,
          headRef: res.data.head.ref,
          state: res.data.state === 'closed' ? ('closed' as const) : ('open' as const),
          merged: res.data.merged,
        };
      },
      (err) => toGitHubError(`Failed to create PR for branch ${input.head}`, err),
    );
  }

  mergePullRequest(
    prNumber: number,
    method: 'squash' | 'merge' | 'rebase',
  ) {
    return TE.tryCatch(
      async () => {
        await this.octokit.rest.pulls.merge({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
          merge_method: method,
        });
      },
      (err) => toGitHubError(`Failed to merge PR #${String(prNumber)}`, err),
    );
  }

  addPrComment(prNumber: number, body: string) {
    return this.addComment(prNumber, body);
  }

  getPrReviewComments(prNumber: number) {
    return TE.tryCatch(
      async () => {
        const [reviews, issueComments] = await Promise.all([
          this.octokit.rest.pulls.listReviews({
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

        // Find the timestamp of the latest pr-flow bot review-fix comment to avoid re-sending prior rounds
        let lastFixAtMs = 0;
        for (const ic of issueComments.data) {
          if (
            ic.user?.type === 'Bot' &&
            (ic.body ?? '').includes('Applied review fixes on `') &&
            ic.created_at
          ) {
            const ts = Date.parse(ic.created_at);
            if (!Number.isNaN(ts) && ts > lastFixAtMs) {
              lastFixAtMs = ts;
            }
          }
        }

        let collected: ReadonlyArray<string> = [];
        for (const r of reviews.data) {
          if (!r.body || r.body.trim().length === 0) continue;
          if (r.state === 'APPROVED' || r.state === 'DISMISSED') continue;
          const submittedMs = r.submitted_at ? Date.parse(r.submitted_at) : Number.NaN;
          if (lastFixAtMs > 0 && !Number.isNaN(submittedMs) && submittedMs <= lastFixAtMs) {
            continue;
          }
          collected = [...collected, `[Review ${r.state} by ${r.user?.login ?? 'unknown'}]: ${r.body}`];
        }

        // Prefer GraphQL reviewThreads so we can skip resolved threads
        let usedGraphqlThreads = false;
        try {
          const threadData = await this.octokit.graphql<{
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: ReadonlyArray<{
                    isResolved: boolean;
                    isOutdated: boolean;
                    comments: {
                      nodes: ReadonlyArray<{
                        path?: string | null;
                        line?: number | null;
                        originalLine?: number | null;
                        body: string;
                        author?: { login?: string | null } | null;
                      }>;
                    };
                  }>;
                };
              } | null;
            };
          }>(
            `
            query GetPrReviewThreads($owner: String!, $repo: String!, $number: Int!) {
              repository(owner: $owner, name: $repo) {
                pullRequest(number: $number) {
                  reviewThreads(first: 100) {
                    nodes {
                      isResolved
                      isOutdated
                      comments(first: 20) {
                        nodes {
                          path
                          line
                          originalLine
                          body
                          author {
                            login
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
            `,
            { owner: this.owner, repo: this.repo, number: prNumber },
          );

          const threads = threadData.repository.pullRequest?.reviewThreads.nodes;
          if (threads !== undefined) {
            usedGraphqlThreads = true;
            for (const thread of threads) {
              if (thread.isResolved) continue;
              for (const rc of thread.comments.nodes) {
                const loc = `${rc.path ?? '?'}:${String(rc.line ?? rc.originalLine ?? '?')}`;
                const outdatedTag = thread.isOutdated ? ' (outdated)' : '';
                collected = [
                  ...collected,
                  `[Inline comment on ${loc}${outdatedTag} by ${rc.author?.login ?? 'unknown'}]: ${rc.body}`,
                ];
              }
            }
          }
        } catch {
          // Fall back to REST listReviewComments if GraphQL is unavailable
        }

        if (!usedGraphqlThreads) {
          const reviewComments = await this.octokit.rest.pulls.listReviewComments({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
          });
          for (const rc of reviewComments.data) {
            const createdMs = rc.created_at ? Date.parse(rc.created_at) : Number.NaN;
            if (lastFixAtMs > 0 && !Number.isNaN(createdMs) && createdMs <= lastFixAtMs) {
              continue;
            }
            collected = [
              ...collected,
              `[Inline comment on ${rc.path}:${String(rc.line ?? rc.original_line ?? '?')} by ${rc.user.login}]: ${rc.body}`,
            ];
          }
        }

        for (const ic of issueComments.data) {
          if (ic.user?.type === 'Bot') continue;
          const createdMs = ic.created_at ? Date.parse(ic.created_at) : Number.NaN;
          if (lastFixAtMs > 0 && !Number.isNaN(createdMs) && createdMs <= lastFixAtMs) {
            continue;
          }
          collected = [...collected, `[PR comment by ${ic.user?.login ?? 'unknown'}]: ${ic.body ?? ''}`];
        }
        return collected;
      },
      (err) => toGitHubError(`Failed to fetch review comments for PR #${String(prNumber)}`, err),
    );
  }

  getPrReviewThreads(prNumber: number) {
    return TE.tryCatch(
      async () => {
        const query = `
          query($owner: String!, $repo: String!, $prNumber: Int!, $cursor: String) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $prNumber) {
                reviewThreads(first: 100, after: $cursor) {
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                  nodes {
                    id
                    isResolved
                    isOutdated
                    path
                    line
                    originalLine
                    comments(first: 50) {
                      nodes {
                        id
                        databaseId
                        body
                        author {
                          login
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        `;

        let threads: ReadonlyArray<PrReviewThread> = [];
        let cursor: string | null = null;
        let hasNextPage = true;

        while (hasNextPage) {
          const res: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: boolean; endCursor: string | null };
                  nodes: ReadonlyArray<{
                    id: string;
                    isResolved: boolean;
                    isOutdated: boolean;
                    path: string;
                    line: number | null;
                    originalLine: number | null;
                    comments: {
                      nodes: ReadonlyArray<{
                        id: string;
                        databaseId: number | null;
                        body: string;
                        author: { login: string } | null;
                      }>;
                    };
                  }>;
                };
              } | null;
            } | null;
          } = await this.octokit.graphql(query, {
            owner: this.owner,
            repo: this.repo,
            prNumber,
            cursor,
          });

          const connection = res.repository?.pullRequest?.reviewThreads;
          if (!connection) break;

          const pageThreads: ReadonlyArray<PrReviewThread> = connection.nodes.map((node) => ({
            threadId: node.id,
            isResolved: node.isResolved,
            isOutdated: node.isOutdated,
            path: node.path,
            line: node.line ?? node.originalLine ?? null,
            comments: node.comments.nodes.map((c) => ({
              id: c.id,
              databaseId: c.databaseId ?? null,
              author: c.author?.login ?? 'unknown',
              body: c.body,
            })),
          }));
          threads = [...threads, ...pageThreads];

          hasNextPage = connection.pageInfo.hasNextPage;
          cursor = connection.pageInfo.endCursor;
        }

        return threads;
      },
      (err) => toGitHubError(`Failed to fetch review threads for PR #${String(prNumber)}`, err),
    );
  }

  getPrReviewFeedback(prNumber: number) {
    return pipe(
      this.getPrReviewThreads(prNumber),
      TE.chain((allThreads) =>
        TE.tryCatch(
          async () => {
            const [reviews, issueComments] = await Promise.all([
              this.octokit.rest.pulls.listReviews({
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

            const reviewTexts: ReadonlyArray<string> = reviews.data
              .filter((r) => Boolean(r.body && r.body.trim().length > 0))
              .map((r) => `[Review ${r.state} by ${r.user?.login ?? 'unknown'}]: ${r.body}`);
            const issueTexts: ReadonlyArray<string> = issueComments.data
              .filter((ic) => ic.user?.type !== 'Bot')
              .map((ic) => `[PR comment by ${ic.user?.login ?? 'unknown'}]: ${ic.body ?? ''}`);
            const generalComments: ReadonlyArray<string> = [...reviewTexts, ...issueTexts];

            const unresolvedThreads = allThreads.filter(
              (t) => !t.isResolved && t.comments.length > 0,
            );

            return {
              unresolvedThreads,
              generalComments,
            };
          },
          (err) => toGitHubError(`Failed to fetch review feedback for PR #${String(prNumber)}`, err),
        ),
      ),
    );
  }

  replyToReviewThread(threadId: string, body: string) {
    return TE.tryCatch(
      async () => {
        const mutation = `
          mutation($threadId: ID!, $body: String!) {
            addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
              comment {
                id
              }
            }
          }
        `;
        await this.octokit.graphql(mutation, { threadId, body });
      },
      (err) => toGitHubError(`Failed to reply to review thread ${threadId}`, err),
    );
  }

  resolveReviewThread(threadId: string) {
    return TE.tryCatch(
      async () => {
        const mutation = `
          mutation($threadId: ID!) {
            resolveReviewThread(input: { threadId: $threadId }) {
              thread {
                id
                isResolved
              }
            }
          }
        `;
        await this.octokit.graphql(mutation, { threadId });
      },
      (err) => toGitHubError(`Failed to resolve review thread ${threadId}`, err),
    );
  }

  checkSetupPrerequisites(opts: {
    prFlowOwner: string;
    expectedLabels?: ReadonlyArray<LabelDefinition>;
    secretName?: string;
  }) {
    return TE.tryCatch(
      async () => {
        let results: ReadonlyArray<PreflightCheckResult> = [];
        const addResult = (r: PreflightCheckResult) => {
          results = [...results, r];
        };
        const secretName = opts.secretName ?? 'GEMINI_API_KEY';

        // 1. Check pr-flow repository visibility (if target is a different repo)
        if (`${this.owner}/${this.repo}` !== `${opts.prFlowOwner}/pr-flow`) {
          try {
            const res = await this.octokit.request('GET /repos/{owner}/{repo}', {
              owner: opts.prFlowOwner,
              repo: 'pr-flow',
            });
            const isPrivate = Boolean((res.data as { private?: boolean }).private);
            if (isPrivate) {
              addResult({
                name: 'pr-flow repository visibility',
                status: 'warn',
                message: `Repository "${opts.prFlowOwner}/pr-flow" is private. Consuming repos cannot clone it with their default GITHUB_TOKEN.`,
                remediation: `Make "${opts.prFlowOwner}/pr-flow" public, or configure a read token for actions/checkout in reusable workflows.`,
              });
            } else {
              addResult({
                name: 'pr-flow repository visibility',
                status: 'pass',
                message: `"${opts.prFlowOwner}/pr-flow" is public and accessible to consuming workflows.`,
              });
            }
          } catch {
            addResult({
              name: 'pr-flow repository visibility',
              status: 'warn',
              message: `Could not verify visibility of "${opts.prFlowOwner}/pr-flow".`,
            });
          }
        }

        // 2. Check GitHub Actions workflow PR permissions on target repo
        try {
          const wfPerms = await this.octokit.request(
            'GET /repos/{owner}/{repo}/actions/permissions/workflow',
            { owner: this.owner, repo: this.repo },
          );
          const canCreatePr = Boolean(
            (wfPerms.data as { can_approve_pull_request_reviews?: boolean })
              .can_approve_pull_request_reviews,
          );
          if (canCreatePr) {
            addResult({
              name: 'Actions PR permissions',
              status: 'pass',
              message: `GitHub Actions is permitted to create and approve pull requests on "${this.owner}/${this.repo}".`,
            });
          } else {
            addResult({
              name: 'Actions PR permissions',
              status: 'fail',
              message: `GitHub Actions is NOT permitted to create or approve pull requests on "${this.owner}/${this.repo}" (finalize will fail with HTTP 403).`,
              remediation: `Enable "Allow GitHub Actions to create and approve pull requests" at https://github.com/${this.owner}/${this.repo}/settings/actions (or run: gh api -X PUT repos/${this.owner}/${this.repo}/actions/permissions/workflow -F can_approve_pull_request_reviews=true).`,
            });
          }
        } catch {
          addResult({
            name: 'Actions PR permissions',
            status: 'warn',
            message: `Could not inspect Actions workflow permissions (token may lack administration:read).`,
            remediation: `Verify "Allow GitHub Actions to create and approve pull requests" is enabled at https://github.com/${this.owner}/${this.repo}/settings/actions.`,
          });
        }

        // 3. Check pr-flow-status Issue Field via GraphQL
        try {
          const field = await this.findStatusFieldViaGraphql();
          if (!field) {
            addResult({
              name: `${this.statusFieldName} Issue Field`,
              status: 'fail',
              message: `Issue Field "${this.statusFieldName}" was not found on "${this.owner}/${this.repo}".`,
              remediation: `Run \`GITHUB_TOKEN=$(gh auth token) npx --yes github:${opts.prFlowOwner}/pr-flow#v1 fields sync --repo ${this.owner}/${this.repo}\` with an org-admin token, or create it at https://github.com/organizations/${this.owner}/settings/issue-fields.`,
            });
          } else {
            const missingOpts = PR_FLOW_STATUS_OPTIONS.filter(
              (opt) => !field.optionsByName.has(isoFieldOptionName.unwrap(opt.name)),
            );
            if (missingOpts.length > 0) {
              addResult({
                name: `${this.statusFieldName} Issue Field`,
                status: 'fail',
                message: `Issue Field "${this.statusFieldName}" is missing options: ${missingOpts.map((m) => isoFieldOptionName.unwrap(m.name)).join(', ')}.`,
                remediation: `Add missing options at https://github.com/organizations/${this.owner}/settings/issue-fields.`,
              });
            } else {
              addResult({
                name: `${this.statusFieldName} Issue Field`,
                status: 'pass',
                message: `Issue Field "${this.statusFieldName}" is configured with all ${String(PR_FLOW_STATUS_OPTIONS.length)} status options.`,
              });
            }
          }
        } catch (err) {
          addResult({
            name: `${this.statusFieldName} Issue Field`,
            status: 'warn',
            message: `Could not query "${this.statusFieldName}" via GraphQL: ${err instanceof Error ? err.message : String(err)}`,
          });
        }

        // 4. Check required labels
        if (opts.expectedLabels && opts.expectedLabels.length > 0) {
          try {
            const existing = await this.octokit.request('GET /repos/{owner}/{repo}/labels', {
              owner: this.owner,
              repo: this.repo,
              per_page: 100,
            });
            const existingNames = new Set(
              (existing.data as ReadonlyArray<{ name: string }>).map((l) => l.name),
            );
            const missingLabels = opts.expectedLabels.filter(
              (l) => !existingNames.has(isoLabelName.unwrap(l.name)),
            );
            if (missingLabels.length > 0) {
              addResult({
                name: 'Required labels',
                status: 'fail',
                message: `Missing labels on "${this.owner}/${this.repo}": ${missingLabels.map((l) => isoLabelName.unwrap(l.name)).join(', ')}.`,
                remediation: `Run \`GITHUB_TOKEN=$(gh auth token) npx --yes github:${opts.prFlowOwner}/pr-flow#v1 labels sync --repo ${this.owner}/${this.repo}\`.`,
              });
            } else {
              addResult({
                name: 'Required labels',
                status: 'pass',
                message: `All ${String(opts.expectedLabels.length)} required pr-flow labels exist.`,
              });
            }
          } catch {
            addResult({
              name: 'Required labels',
              status: 'warn',
              message: `Could not list labels on "${this.owner}/${this.repo}".`,
            });
          }
        }

        // 5. Check Actions secret (e.g. GEMINI_API_KEY)
        try {
          await this.octokit.request('GET /repos/{owner}/{repo}/actions/secrets/{secret_name}', {
            owner: this.owner,
            repo: this.repo,
            secret_name: secretName,
          });
          addResult({
            name: `Actions secret (${secretName})`,
            status: 'pass',
            message: `Actions secret "${secretName}" is configured on "${this.owner}/${this.repo}".`,
          });
        } catch (err) {
          const status =
            typeof err === 'object' && err !== null && 'status' in err
              ? Number((err).status)
              : undefined;
          if (status === 404) {
            addResult({
              name: `Actions secret (${secretName})`,
              status: 'fail',
              message: `Actions secret "${secretName}" is not configured on "${this.owner}/${this.repo}".`,
              remediation: `Add "${secretName}" at https://github.com/${this.owner}/${this.repo}/settings/secrets/actions (or run: gh secret set ${secretName} --repo ${this.owner}/${this.repo}).`,
            });
          } else {
            addResult({
              name: `Actions secret (${secretName})`,
              status: 'warn',
              message: `Could not inspect Actions secret "${secretName}" (token may lack secrets:read).`,
              remediation: `Verify "${secretName}" is set at https://github.com/${this.owner}/${this.repo}/settings/secrets/actions.`,
            });
          }
        }

        return results;
      },
      (err) => toGitHubError(`Failed to run setup preflight checks for ${this.owner}/${this.repo}`, err),
    );
  }
}
