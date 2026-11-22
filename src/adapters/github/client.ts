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
  ManagedPrSummary,
  PreflightCheckResult,
  PrReviewThread,
} from './types.js';

const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

const REVIEW_DECISION_STATES: ReadonlySet<string> = new Set([
  'CHANGES_REQUESTED',
  'APPROVED',
  'DISMISSED',
]);

const NON_ACTIONABLE_REVIEW_STATES: ReadonlySet<string> = new Set([
  'APPROVED',
  'DISMISSED',
]);

function getHttpStatus(err: unknown) {
  if (typeof err !== 'object' || err === null || !('status' in err)) {
    return undefined;
  }
  const code = Number(err.status);
  return Number.isFinite(code) ? code : undefined;
}

function isNotFoundError(err: unknown) {
  return getHttpStatus(err) === HTTP_NOT_FOUND;
}

function hasNonEmptyBody(r: { readonly body?: string | null }): r is { readonly body: string } {
  return Boolean(r.body && r.body.trim().length > 0);
}

export function isUnresolvedThreadWithComments(t: PrReviewThread) {
  return !t.isResolved && t.comments.length > 0;
}

function toIssueState(rawState: string) {
  return rawState.toLowerCase() === 'closed' ? ('closed' as const) : ('open' as const);
}

function toGitHubError(context: string, err: unknown) {
  const status = getHttpStatus(err);
  const message = err instanceof Error ? err.message : String(err);
  return {
    type: 'GITHUB_API_ERROR',
    message: isoMessage.wrap(`${context}: ${message}`),
    httpStatus:
      status !== undefined
        ? ({ kind: 'known', code: isoCount.wrap(status) } as const)
        : ({ kind: 'unknown' } as const),
    cause: { kind: 'present', detail: isoMessage.wrap(message) } as const,
  } satisfies DomainError;
}

type RawIssueText = Pick<CreateIssueInput, 'title'> & {
  body?: string | null;
};

type RawGitHubIssue = RawIssueText & {
  number: number;
  id: number;
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

type GraphQLIssueNode = RawIssueText & {
  number: number;
  state: 'OPEN' | 'CLOSED';
  updatedAt: string;
  labels: { nodes: ReadonlyArray<{ name: string }> };
  issueFieldValues?: { nodes: ReadonlyArray<GraphQLIssueFieldValueNode> };
};

type GraphQLReviewCommentNode = {
  readonly id?: string;
  readonly databaseId?: number | null;
  readonly path?: string | null;
  readonly line?: number | null;
  readonly originalLine?: number | null;
  readonly body: string;
  readonly author?: { readonly login?: string | null } | null;
};

type GraphQLReviewThreadNode = {
  readonly id?: string;
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  readonly path?: string;
  readonly line?: number | null;
  readonly originalLine?: number | null;
  readonly comments: {
    readonly nodes: ReadonlyArray<GraphQLReviewCommentNode>;
  };
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
    content: {
      title: isoTitle.wrap(raw.title),
      body: isoBody.wrap(raw.body ?? ''),
      labels,
    },
    state: toIssueState(raw.state),
    status: extractStatusFromFieldValue(O.fromNullable(statusValue)),
    type: extractTypeFromLabels(labels),
    subIssueNumbers: subIssueNumbers.map(isoIssueNumber.wrap),
    blockedByNumbers: blockedByNumbers.map(isoIssueNumber.wrap),
    blockingNumbers: blockingNumbers.map(isoIssueNumber.wrap),
    links: {
      linkedPr: { kind: 'none' as const },
      parent: { kind: 'root' as const },
    },
    lastUpdatedAt: isoIsoTimestamp.wrap(raw.updated_at),
  };
}

async function paginateRestPages<T>(
  fetchPage: (page: number) => Promise<ReadonlyArray<T>>,
  perPage = 100,
) {
  let all: ReadonlyArray<T> = [];
  let page = 1;
  for (;;) {
    const items = await fetchPage(page);
    all = [...all, ...items];
    if (items.length < perPage) {
      break;
    }
    page++;
  }
  return all;
}

type IssueCommentLike = {
  readonly user?: { readonly type?: string | null; readonly login?: string | null } | null;
  readonly body?: string | null;
  readonly created_at?: string | null;
};

function findLastFixCommentTimestamp(issueComments: ReadonlyArray<IssueCommentLike>) {
  let lastFixAtMs = 0;
  let lastFixIso: string | null = null;
  for (const ic of issueComments) {
    if (
      ic.user?.type === 'Bot' &&
      (ic.body ?? '').includes('Applied review fixes on `') &&
      ic.created_at
    ) {
      const ts = Date.parse(ic.created_at);
      if (!Number.isNaN(ts) && ts > lastFixAtMs) {
        lastFixAtMs = ts;
        lastFixIso = ic.created_at;
      }
    }
  }
  return { ms: lastFixAtMs, iso: lastFixIso };
}

export type OctokitAdapterOptions = {
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly statusFieldName?: string;
  readonly octokit?: Octokit;
};

export function createOctokitGitHubAdapter(options: OctokitAdapterOptions) {
  const octokit = options.octokit ?? new Octokit({ auth: options.token });
  const issuesApi = octokit.rest.issues;
  const pullsApi = octokit.rest.pulls;
  const actionsApi = octokit.rest.actions;
  const { owner, repo } = options;
  const repoParams = { owner, repo };
  const statusFieldName = options.statusFieldName ?? PR_FLOW_STATUS_FIELD_NAME;

  let cachedStatusField: {
    id: string;
    optionsByName: ReadonlyMap<string, string>;
  } | null = null;

  async function findStatusFieldViaGraphql() {
    if (cachedStatusField !== null) {
      return cachedStatusField;
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
    const data = await octokit.graphql<{
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
      owner,
      repo,
      headers: { 'GraphQL-Features': 'issue_fields' },
    });

    const repoData = data.repository;
    const fieldNodes = repoData.issueFields.nodes;
    const matched = fieldNodes.find(
      (f) => f.__typename === 'IssueFieldSingleSelect' && f.name === statusFieldName,
    );
    if (!matched || !matched.id || !matched.options) {
      return null;
    }

    cachedStatusField = {
      id: matched.id,
      optionsByName: new Map(matched.options.map((opt) => [opt.name, opt.id])),
    };
    return cachedStatusField;
  }

  async function resolveStatusField() {
    const field = await findStatusFieldViaGraphql();
    if (!field) {
      throw new Error(
        `Issue field "${statusFieldName}" not found in organization "${owner}". Run "pr-flow fields sync --repo ${owner}/${repo}" with an org-admin token or create it in Organization Settings -> Issue Fields.`,
      );
    }
    return field;
  }

  function getIssueStatusFieldValue(issueNumber: number) {
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
        const data = await octokit.graphql<{
          repository: {
            issue: {
              issueFieldValues: { nodes: ReadonlyArray<GraphQLIssueFieldValueNode> };
            } | null;
          };
        }>(query, {
          owner,
          repo,
          number: issueNumber,
          headers: { 'GraphQL-Features': 'issue_fields' },
        });
        const repoData = data.repository;
        const issueData = repoData.issue;
        const fieldValues = issueData?.issueFieldValues;
        return extractStatusFieldValueFromGraphQL(fieldValues?.nodes, statusFieldName);
      },
      (err) => toGitHubError(`Failed to fetch issue field values for #${String(issueNumber)}`, err),
    );
  }

  function updateIssueStatus(issueNumber: number, status: IssueStatus) {
    return TE.tryCatch(
      async () => {
        const { id: fieldId, optionsByName } = await resolveStatusField();
        const optionName = STATUS_TO_FIELD_VALUE[status];
        const singleSelectOptionId = optionsByName.get(optionName);
        if (!singleSelectOptionId) {
          throw new Error(
            `Option "${optionName}" not found on issue field "${statusFieldName}". Run "pr-flow fields sync --repo ${owner}/${repo}" with an org-admin token.`,
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
        const issueData = await octokit.graphql<{
          repository: { issue: { id: string } | null };
        }>(issueQuery, {
          owner,
          repo,
          number: issueNumber,
        });
        const repoData = issueData.repository;
        const issueId = repoData.issue?.id;
        if (!issueId) {
          throw new Error(`Issue #${String(issueNumber)} not found in ${owner}/${repo}.`);
        }

        const mutation = `
          mutation SetIssueFieldValue($input: SetIssueFieldValueInput!) {
            setIssueFieldValue(input: $input) {
              clientMutationId
            }
          }
        `;
        await octokit.graphql(mutation, {
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
          `Failed to set "${statusFieldName}" on #${String(issueNumber)} to "${status}"`,
          err,
        ),
    );
  }

  function ensureStatusField() {
    return TE.tryCatch(
      async () => {
        const existing = await findStatusFieldViaGraphql();
        if (existing) {
          const missing = PR_FLOW_STATUS_OPTIONS.filter(
            (opt) => !existing.optionsByName.has(isoFieldOptionName.unwrap(opt.name)),
          );
          if (missing.length > 0) {
            throw new Error(
              `Issue field "${statusFieldName}" exists in "${owner}" but is missing required options: ${missing.map((m) => isoFieldOptionName.unwrap(m.name)).join(', ')}. ` +
                `Add them at https://github.com/organizations/${owner}/settings/issue-fields.`,
            );
          }
          return;
        }
        await octokit.request('POST /orgs/{org}/issue-fields', {
          org: owner,
          name: statusFieldName,
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
          `Failed to ensure "${statusFieldName}" issue field in org "${owner}"`,
          err,
        );
        if (
          baseErr.httpStatus.kind === 'known' &&
          isoCount.unwrap(baseErr.httpStatus.code) === HTTP_FORBIDDEN
        ) {
          const optionNames = PR_FLOW_STATUS_OPTIONS.map((o) =>
            isoFieldOptionName.unwrap(o.name),
          ).join(', ');
          return {
            ...baseErr,
            message: isoMessage.wrap(
              `Failed to create "${statusFieldName}" issue field in org "${owner}" (HTTP 403: token lacks organization-admin permissions to create org-level Issue Fields). ` +
                `Run \`GITHUB_TOKEN=$(gh auth token) npx --yes github:mye-org/pr-flow#v1 fields sync --repo ${owner}/${repo}\` with an org-admin token, ` +
                `or create the single-select field "${statusFieldName}" (options: ${optionNames}) at https://github.com/organizations/${owner}/settings/issue-fields.`,
            ),
          };
        }
        if (
          baseErr.httpStatus.kind === 'known' &&
          isoCount.unwrap(baseErr.httpStatus.code) === HTTP_NOT_FOUND
        ) {
          return {
            ...baseErr,
            message: isoMessage.wrap(
              `Failed to ensure "${statusFieldName}" issue field in org "${owner}" (HTTP 404: "${owner}" may be a personal account rather than a GitHub Organization, or Issue Fields are not enabled).`,
            ),
          };
        }
        return baseErr;
      },
    );
  }

  function listSubIssues(issueNumber: number) {
    return TE.tryCatch(
      async () => {
        try {
          const data = await paginateRestPages(async (page) => {
            const res = await octokit.request(
              'GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues',
              {
                ...repoParams,
                issue_number: issueNumber,
                per_page: 100,
                page,
              },
            );
            return res.data;
          });
          return data.map((d) => d.number);
        } catch (err: unknown) {
          if (isNotFoundError(err)) {
            return [];
          }
          throw err;
        }
      },
      (err) => toGitHubError(`Failed to list sub-issues for #${String(issueNumber)}`, err),
    );
  }

  function addSubIssue(parentNumber: number, childNumber: number) {
    return TE.tryCatch(
      async () => {
        const child = await issuesApi.get({
          ...repoParams,
          issue_number: childNumber,
        });
        await octokit.request(
          'POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues',
          {
            ...repoParams,
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

  function listBlockedBy(issueNumber: number) {
    return TE.tryCatch(
      async () => {
        try {
          const data = await paginateRestPages(async (page) => {
            const res = await octokit.request(
              'GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by',
              {
                ...repoParams,
                issue_number: issueNumber,
                per_page: 100,
                page,
              },
            );
            return res.data as ReadonlyArray<RawGitHubIssue>;
          });
          return data.map((d) => mapRawIssue(d));
        } catch (err: unknown) {
          if (isNotFoundError(err)) {
            return [];
          }
          throw err;
        }
      },
      (err) => toGitHubError(`Failed to list blocked_by for #${String(issueNumber)}`, err),
    );
  }

  function listBlocking(issueNumber: number) {
    return TE.tryCatch(
      async () => {
        try {
          const data = await paginateRestPages(async (page) => {
            const res = await octokit.request(
              'GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocking',
              {
                ...repoParams,
                issue_number: issueNumber,
                per_page: 100,
                page,
              },
            );
            return res.data as ReadonlyArray<{ number: number }>;
          });
          return data.map((d) => d.number);
        } catch (err: unknown) {
          if (isNotFoundError(err)) {
            return [];
          }
          throw err;
        }
      },
      (err) => toGitHubError(`Failed to list blocking issues for #${String(issueNumber)}`, err),
    );
  }

  function addBlockedBy(issueNumber: number, blockerNumber: number) {
    return TE.tryCatch(
      async () => {
        const blocker = await issuesApi.get({
          ...repoParams,
          issue_number: blockerNumber,
        });
        await octokit.request(
          'POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by',
          {
            ...repoParams,
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

  function getIssue(issueNumber: number) {
    return pipe(
      TE.tryCatch(
        () =>
          issuesApi.get({
            ...repoParams,
            issue_number: issueNumber,
          }),
        (err) => toGitHubError(`Failed to fetch issue #${String(issueNumber)}`, err),
      ),
      TE.flatMap((res) =>
        pipe(
          TE.Do,
          TE.apS('subIssues', listSubIssues(issueNumber)),
          TE.apS('blockedBy', listBlockedBy(issueNumber)),
          TE.apS('blocking', listBlocking(issueNumber)),
          TE.apS('statusValue', getIssueStatusFieldValue(issueNumber)),
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

  function listAllIssues(state: 'open' | 'closed' | 'all' = 'all') {
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
          } = await octokit.graphql(query, {
            owner,
            repo,
            states,
            after,
            headers: { 'GraphQL-Features': 'issue_fields' },
          });

          const repoData = data.repository;
          const issuesPage = repoData.issues;
          const pageNodes: ReadonlyArray<IssueNode> = issuesPage.nodes.map((node) => {
            const labels = node.labels.nodes.map((l) => isoLabelName.wrap(l.name));
            const statusValue = extractStatusFieldValueFromGraphQL(
              node.issueFieldValues?.nodes,
              statusFieldName,
            );
            return {
              number: isoIssueNumber.wrap(node.number),
              content: {
                title: isoTitle.wrap(node.title),
                body: isoBody.wrap(node.body ?? ''),
                labels,
              },
              state: toIssueState(node.state),
              status: extractStatusFromFieldValue(O.fromNullable(statusValue)),
              type: extractTypeFromLabels(labels),
              subIssueNumbers: [],
              blockedByNumbers: [],
              blockingNumbers: [],
              links: {
                linkedPr: { kind: 'none' },
                parent: { kind: 'root' },
              },
              lastUpdatedAt: isoIsoTimestamp.wrap(node.updatedAt),
            };
          });
          results = [...results, ...pageNodes];

          const pageInfo = issuesPage.pageInfo;
          if (!pageInfo.hasNextPage) {
            break;
          }
          after = pageInfo.endCursor;
        }

        return results;
      },
      (err) => toGitHubError('Failed to list repository issues', err),
    );
  }

  function createIssue(input: CreateIssueInput) {
    return TE.tryCatch(
      async () => {
        const res = await issuesApi.create({
          ...repoParams,
          title: input.title,
          body: input.body,
          labels: [...input.labels],
        });
        const created = res.data;
        return { number: created.number, url: created.html_url };
      },
      (err) => toGitHubError(`Failed to create issue "${input.title}"`, err),
    );
  }

  function closeIssue(issueNumber: number) {
    return TE.tryCatch(
      async () => {
        await issuesApi.update({
          ...repoParams,
          issue_number: issueNumber,
          state: 'closed',
        });
      },
      (err) => toGitHubError(`Failed to close issue #${String(issueNumber)}`, err),
    );
  }

  function reopenIssue(issueNumber: number) {
    return TE.tryCatch(
      async () => {
        await issuesApi.update({
          ...repoParams,
          issue_number: issueNumber,
          state: 'open',
        });
      },
      (err) => toGitHubError(`Failed to reopen issue #${String(issueNumber)}`, err),
    );
  }

  function addLabels(issueNumber: number, labels: ReadonlyArray<string>) {
    if (labels.length === 0) return TE.right(undefined);
    return TE.tryCatch(
      async () => {
        await issuesApi.addLabels({
          ...repoParams,
          issue_number: issueNumber,
          labels: [...labels],
        });
      },
      (err) => toGitHubError(`Failed to add labels to #${String(issueNumber)}`, err),
    );
  }

  function removeLabel(issueNumber: number, label: string) {
    return TE.tryCatch(
      async () => {
        try {
          await issuesApi.removeLabel({
            ...repoParams,
            issue_number: issueNumber,
            name: label,
          });
        } catch (err: unknown) {
          if (isNotFoundError(err)) {
            return;
          }
          throw err;
        }
      },
      (err) => toGitHubError(`Failed to remove label "${label}" from #${String(issueNumber)}`, err),
    );
  }

  function addComment(issueNumber: number, body: string) {
    return TE.tryCatch(
      async () => {
        await issuesApi.createComment({
          ...repoParams,
          issue_number: issueNumber,
          body,
        });
      },
      (err) => toGitHubError(`Failed to comment on #${String(issueNumber)}`, err),
    );
  }

  function listIssueComments(issueNumber: number) {
    return TE.tryCatch(
      async () => {
        const comments = await octokit.paginate(issuesApi.listComments, {
          ...repoParams,
          issue_number: issueNumber,
          per_page: 100,
        });
        return comments.map((c) => c.body ?? '');
      },
      (err) => toGitHubError(`Failed to list comments for #${String(issueNumber)}`, err),
    );
  }

  function dispatchWorkflow(
    workflowFile: string,
    ref: string,
    inputs: Readonly<Record<string, string>>,
  ) {
    return TE.tryCatch(
      async () => {
        await actionsApi.createWorkflowDispatch({
          ...repoParams,
          workflow_id: workflowFile,
          ref,
          inputs: { ...inputs },
        });
      },
      (err) => toGitHubError(`Failed to dispatch workflow ${workflowFile}`, err),
    );
  }

  function ensureLabels(labels: ReadonlyArray<LabelDefinition>) {
    return TE.tryCatch(
      async () => {
        const existing = await octokit.paginate(issuesApi.listLabelsForRepo, {
          ...repoParams,
          per_page: 100,
        });
        const existingByName = new Map(existing.map((l) => [l.name, l]));

        for (const label of labels) {
          const name = isoLabelName.unwrap(label.name);
          const color = isoHexColor.unwrap(label.color);
          const description = isoMessage.unwrap(label.description);
          const current = existingByName.get(name);
          if (!current) {
            await issuesApi.createLabel({
              ...repoParams,
              name,
              color,
              description,
            });
          } else if (current.color.toLowerCase() !== color.toLowerCase()) {
            await issuesApi.updateLabel({
              ...repoParams,
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

  function getPullRequest(prNumber: number) {
    return TE.tryCatch(
      async () => {
        const res = await pullsApi.get({
          ...repoParams,
          pull_number: prNumber,
        });
        const pr = res.data;
        const head = pr.head;
        return {
          number: pr.number,
          url: pr.html_url,
          headRef: head.ref,
          state: toIssueState(pr.state),
          merged: pr.merged,
        };
      },
      (err) => toGitHubError(`Failed to fetch PR #${String(prNumber)}`, err),
    );
  }

  function listOpenPrsForIssue(issueNumber: number) {
    return TE.tryCatch(
      async () => {
        const branch = isoBranchName.unwrap(branchNameForIssue(isoIssueNumber.wrap(issueNumber)));
        const prs = await pullsApi.list({
          ...repoParams,
          state: 'open',
          head: `${owner}:${branch}`,
        });
        return prs.data.map((pr) => {
          const head = pr.head;
          return {
            number: pr.number,
            url: pr.html_url,
            headRef: head.ref,
            state: toIssueState(pr.state),
            merged: false,
          };
        });
      },
      (err) => toGitHubError(`Failed to list open PRs for #${String(issueNumber)}`, err),
    );
  }

  function listOpenAiManagedPrs() {
    return TE.tryCatch(
      async () => {
        const prs = await octokit.paginate(pullsApi.list, {
          ...repoParams,
          state: 'open',
          per_page: 100,
        });
        let results: ReadonlyArray<ManagedPrSummary> = [];
        for (const pr of prs) {
          const hasLabel = pr.labels.some((l) => l.name === 'ai-managed');
          const head = pr.head;
          const matched = /^ai\/issue-(\d+)$/.exec(head.ref);
          if (!hasLabel || !matched) continue;
          const issueNumber = Number(matched[1]);

          const [reviews, issueComments] = await Promise.all([
            paginateRestPages(async (page) => {
              const res = await pullsApi.listReviews({
                ...repoParams,
                pull_number: pr.number,
                per_page: 100,
                page,
              });
              return res.data;
            }),
            paginateRestPages(async (page) => {
              const res = await issuesApi.listComments({
                ...repoParams,
                issue_number: pr.number,
                per_page: 100,
                page,
              });
              return res.data;
            }),
          ]);

          const decisive = reviews.filter((r) => REVIEW_DECISION_STATES.has(r.state));
          const latestDecisive = decisive[decisive.length - 1];
          const latestReviewState = latestDecisive?.state ?? null;
          const latestReviewSubmittedAt = latestDecisive?.submitted_at ?? null;
          const lastFixCommentAt = findLastFixCommentTimestamp(issueComments).iso;

          results = [
            ...results,
            {
              number: pr.number,
              headRef: head.ref,
              issueNumber,
              updatedAt: pr.updated_at,
              latestReviewState,
              latestReviewSubmittedAt,
              lastFixCommentAt,
            },
          ];
        }
        return results;
      },
      (err) => toGitHubError('Failed to list open ai-managed PRs', err),
    );
  }

  function createPullRequest(input: CreatePullRequestInput) {
    const content = input.content;
    return TE.tryCatch(
      async () => {
        const res = await pullsApi.create({
          ...repoParams,
          title: content.title,
          body: content.body,
          head: input.head,
          base: input.base,
          ...(input.draft !== undefined ? { draft: input.draft } : {}),
        });
        const pr = res.data;
        if (content.labels.length > 0) {
          await issuesApi.addLabels({
            ...repoParams,
            issue_number: pr.number,
            labels: [...content.labels],
          });
        }
        const head = pr.head;
        return {
          number: pr.number,
          url: pr.html_url,
          headRef: head.ref,
          state: toIssueState(pr.state),
          merged: pr.merged,
        };
      },
      (err) => toGitHubError(`Failed to create PR for branch ${input.head}`, err),
    );
  }

  function mergePullRequest(prNumber: number, method: 'squash' | 'merge' | 'rebase') {
    return TE.tryCatch(
      async () => {
        await pullsApi.merge({
          ...repoParams,
          pull_number: prNumber,
          merge_method: method,
        });
      },
      (err) => toGitHubError(`Failed to merge PR #${String(prNumber)}`, err),
    );
  }

  function addPrComment(prNumber: number, body: string) {
    return addComment(prNumber, body);
  }

  function getPrReviewComments(prNumber: number) {
    return TE.tryCatch(
      async () => {
        const [reviews, issueComments] = await Promise.all([
          paginateRestPages(async (page) => {
            const res = await pullsApi.listReviews({
              ...repoParams,
              pull_number: prNumber,
              per_page: 100,
              page,
            });
            return res.data;
          }),
          paginateRestPages(async (page) => {
            const res = await issuesApi.listComments({
              ...repoParams,
              issue_number: prNumber,
              per_page: 100,
              page,
            });
            return res.data;
          }),
        ]);

        const { ms: lastFixAtMs } = findLastFixCommentTimestamp(issueComments);

        let collected: ReadonlyArray<string> = [];
        for (const r of reviews) {
          if (!hasNonEmptyBody(r)) continue;
          if (NON_ACTIONABLE_REVIEW_STATES.has(r.state)) continue;
          const submittedMs = r.submitted_at ? Date.parse(r.submitted_at) : Number.NaN;
          if (lastFixAtMs > 0 && !Number.isNaN(submittedMs) && submittedMs <= lastFixAtMs) {
            continue;
          }
          collected = [
            ...collected,
            `[Review ${r.state} by ${r.user?.login ?? 'unknown'}]: ${r.body}`,
          ];
        }

        let usedGraphqlThreads = false;
        try {
          const threadData = await octokit.graphql<{
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: ReadonlyArray<GraphQLReviewThreadNode>;
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
            { owner, repo, number: prNumber },
          );

          const repoData = threadData.repository;
          const prData = repoData.pullRequest;
          const threads = prData?.reviewThreads.nodes;
          if (threads !== undefined) {
            usedGraphqlThreads = true;
            for (const thread of threads) {
              if (thread.isResolved) continue;
              const threadComments = thread.comments;
              for (const rc of threadComments.nodes) {
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
          const reviewComments = await paginateRestPages(async (page) => {
            const res = await pullsApi.listReviewComments({
              ...repoParams,
              pull_number: prNumber,
              per_page: 100,
              page,
            });
            return res.data;
          });
          for (const rc of reviewComments) {
            const createdMs = rc.created_at ? Date.parse(rc.created_at) : Number.NaN;
            if (lastFixAtMs > 0 && !Number.isNaN(createdMs) && createdMs <= lastFixAtMs) {
              continue;
            }
            const user = rc.user;
            collected = [
              ...collected,
              `[Inline comment on ${rc.path}:${String(rc.line ?? rc.original_line ?? '?')} by ${user.login}]: ${rc.body}`,
            ];
          }
        }

        for (const ic of issueComments) {
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

  function getPrReviewThreads(prNumber: number) {
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
                  nodes: ReadonlyArray<GraphQLReviewThreadNode>;
                };
              } | null;
            } | null;
          } = await octokit.graphql(query, {
            owner,
            repo,
            prNumber,
            cursor,
          });

          const repoData = res.repository;
          const prData = repoData?.pullRequest;
          const connection = prData?.reviewThreads;
          if (!connection) break;

          const pageThreads: ReadonlyArray<PrReviewThread> = connection.nodes.map((node) => {
            const nodeComments = node.comments;
            return {
              threadId: node.id ?? '',
              isResolved: node.isResolved,
              isOutdated: node.isOutdated,
              path: node.path ?? '',
              line: node.line ?? node.originalLine ?? null,
              comments: nodeComments.nodes.map((c) => ({
                id: c.id ?? '',
                databaseId: c.databaseId ?? null,
                author: c.author?.login ?? 'unknown',
                body: c.body,
              })),
            };
          });
          threads = [...threads, ...pageThreads];

          const pageInfo = connection.pageInfo;
          hasNextPage = pageInfo.hasNextPage;
          cursor = pageInfo.endCursor;
        }

        return threads;
      },
      (err) => toGitHubError(`Failed to fetch review threads for PR #${String(prNumber)}`, err),
    );
  }

  function getPrReviewFeedback(prNumber: number) {
    return pipe(
      getPrReviewThreads(prNumber),
      TE.flatMap((allThreads) =>
        TE.tryCatch(
          async () => {
            const [reviews, issueComments] = await Promise.all([
              paginateRestPages(async (page) => {
                const res = await pullsApi.listReviews({
                  ...repoParams,
                  pull_number: prNumber,
                  per_page: 100,
                  page,
                });
                return res.data;
              }),
              paginateRestPages(async (page) => {
                const res = await issuesApi.listComments({
                  ...repoParams,
                  issue_number: prNumber,
                  per_page: 100,
                  page,
                });
                return res.data;
              }),
            ]);

            const { ms: lastFixAtMs } = findLastFixCommentTimestamp(issueComments);

            const reviewTexts: ReadonlyArray<string> = reviews
              .filter((r) => {
                if (!hasNonEmptyBody(r)) return false;
                if (NON_ACTIONABLE_REVIEW_STATES.has(r.state)) return false;
                const submittedMs = r.submitted_at ? Date.parse(r.submitted_at) : Number.NaN;
                if (lastFixAtMs > 0 && !Number.isNaN(submittedMs) && submittedMs <= lastFixAtMs) {
                  return false;
                }
                return true;
              })
              .map((r) => `[Review ${r.state} by ${r.user?.login ?? 'unknown'}]: ${r.body}`);

            const issueTexts: ReadonlyArray<string> = issueComments
              .filter((ic) => {
                if (ic.user?.type === 'Bot') return false;
                const createdMs = ic.created_at ? Date.parse(ic.created_at) : Number.NaN;
                if (lastFixAtMs > 0 && !Number.isNaN(createdMs) && createdMs <= lastFixAtMs) {
                  return false;
                }
                return true;
              })
              .map((ic) => `[PR comment by ${ic.user?.login ?? 'unknown'}]: ${ic.body ?? ''}`);

            const generalComments: ReadonlyArray<string> = [...reviewTexts, ...issueTexts];
            const unresolvedThreads = allThreads.filter(isUnresolvedThreadWithComments);

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

  function replyToReviewThread(threadId: string, body: string) {
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
        await octokit.graphql(mutation, { threadId, body });
      },
      (err) => toGitHubError(`Failed to reply to review thread ${threadId}`, err),
    );
  }

  function resolveReviewThread(threadId: string) {
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
        await octokit.graphql(mutation, { threadId });
      },
      (err) => toGitHubError(`Failed to resolve review thread ${threadId}`, err),
    );
  }

  function checkSetupPrerequisites(opts: {
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
        if (`${owner}/${repo}` !== `${opts.prFlowOwner}/pr-flow`) {
          try {
            const res = await octokit.request('GET /repos/{owner}/{repo}', {
              owner: opts.prFlowOwner,
              repo: 'pr-flow',
            });
            const isPrivate = Boolean((res.data as { private?: boolean }).private);
            if (isPrivate) {
              addResult({
                name: 'pr-flow repository visibility',
                outcome: 'warn',
                message: `Repository "${opts.prFlowOwner}/pr-flow" is private. Consuming repos cannot clone it with their default GITHUB_TOKEN.`,
                remediation: `Make "${opts.prFlowOwner}/pr-flow" public, or configure a read token for actions/checkout in reusable workflows.`,
              });
            } else {
              addResult({
                name: 'pr-flow repository visibility',
                outcome: 'pass',
                message: `"${opts.prFlowOwner}/pr-flow" is public and accessible to consuming workflows.`,
              });
            }
          } catch {
            addResult({
              name: 'pr-flow repository visibility',
              outcome: 'warn',
              message: `Could not verify visibility of "${opts.prFlowOwner}/pr-flow".`,
            });
          }
        }

        // 2. Check GitHub Actions workflow PR permissions on target repo
        try {
          const wfPerms = await octokit.request(
            'GET /repos/{owner}/{repo}/actions/permissions/workflow',
            repoParams,
          );
          const canCreatePr = Boolean(
            (wfPerms.data as { can_approve_pull_request_reviews?: boolean })
              .can_approve_pull_request_reviews,
          );
          if (canCreatePr) {
            addResult({
              name: 'Actions PR permissions',
              outcome: 'pass',
              message: `GitHub Actions is permitted to create and approve pull requests on "${owner}/${repo}".`,
            });
          } else {
            addResult({
              name: 'Actions PR permissions',
              outcome: 'fail',
              message: `GitHub Actions is NOT permitted to create or approve pull requests on "${owner}/${repo}" (finalize will fail with HTTP 403).`,
              remediation: `Enable "Allow GitHub Actions to create and approve pull requests" at https://github.com/${owner}/${repo}/settings/actions (or run: gh api -X PUT repos/${owner}/${repo}/actions/permissions/workflow -F can_approve_pull_request_reviews=true).`,
            });
          }
        } catch {
          addResult({
            name: 'Actions PR permissions',
            outcome: 'warn',
            message: `Could not inspect Actions workflow permissions (token may lack administration:read).`,
            remediation: `Verify "Allow GitHub Actions to create and approve pull requests" is enabled at https://github.com/${owner}/${repo}/settings/actions.`,
          });
        }

        // 3. Check pr-flow-status Issue Field via GraphQL
        try {
          const field = await findStatusFieldViaGraphql();
          if (!field) {
            addResult({
              name: `${statusFieldName} Issue Field`,
              outcome: 'fail',
              message: `Issue Field "${statusFieldName}" was not found on "${owner}/${repo}".`,
              remediation: `Run \`GITHUB_TOKEN=$(gh auth token) npx --yes github:${opts.prFlowOwner}/pr-flow#v1 fields sync --repo ${owner}/${repo}\` with an org-admin token, or create it at https://github.com/organizations/${owner}/settings/issue-fields.`,
            });
          } else {
            const missingOpts = PR_FLOW_STATUS_OPTIONS.filter(
              (opt) => !field.optionsByName.has(isoFieldOptionName.unwrap(opt.name)),
            );
            if (missingOpts.length > 0) {
              addResult({
                name: `${statusFieldName} Issue Field`,
                outcome: 'fail',
                message: `Issue Field "${statusFieldName}" is missing options: ${missingOpts.map((m) => isoFieldOptionName.unwrap(m.name)).join(', ')}.`,
                remediation: `Add missing options at https://github.com/organizations/${owner}/settings/issue-fields.`,
              });
            } else {
              addResult({
                name: `${statusFieldName} Issue Field`,
                outcome: 'pass',
                message: `Issue Field "${statusFieldName}" is configured with all ${String(PR_FLOW_STATUS_OPTIONS.length)} status options.`,
              });
            }
          }
        } catch (err) {
          addResult({
            name: `${statusFieldName} Issue Field`,
            outcome: 'warn',
            message: `Could not query "${statusFieldName}" via GraphQL: ${err instanceof Error ? err.message : String(err)}`,
          });
        }

        // 4. Check required labels
        if (opts.expectedLabels && opts.expectedLabels.length > 0) {
          try {
            const existing = await paginateRestPages(async (page) => {
              const res = await octokit.request('GET /repos/{owner}/{repo}/labels', {
                ...repoParams,
                per_page: 100,
                page,
              });
              return res.data;
            });
            const existingNames = new Set(existing.map((l) => l.name));
            const missingLabels = opts.expectedLabels.filter(
              (l) => !existingNames.has(isoLabelName.unwrap(l.name)),
            );
            if (missingLabels.length > 0) {
              addResult({
                name: 'Required labels',
                outcome: 'fail',
                message: `Missing labels on "${owner}/${repo}": ${missingLabels.map((l) => isoLabelName.unwrap(l.name)).join(', ')}.`,
                remediation: `Run \`GITHUB_TOKEN=$(gh auth token) npx --yes github:${opts.prFlowOwner}/pr-flow#v1 labels sync --repo ${owner}/${repo}\`.`,
              });
            } else {
              addResult({
                name: 'Required labels',
                outcome: 'pass',
                message: `All ${String(opts.expectedLabels.length)} required pr-flow labels exist.`,
              });
            }
          } catch {
            addResult({
              name: 'Required labels',
              outcome: 'warn',
              message: `Could not list labels on "${owner}/${repo}".`,
            });
          }
        }

        // 5. Check Actions secret (e.g. GEMINI_API_KEY)
        try {
          await octokit.request('GET /repos/{owner}/{repo}/actions/secrets/{secret_name}', {
            ...repoParams,
            secret_name: secretName,
          });
          addResult({
            name: `Actions secret (${secretName})`,
            outcome: 'pass',
            message: `Actions secret "${secretName}" is configured on "${owner}/${repo}".`,
          });
        } catch (err) {
          if (isNotFoundError(err)) {
            addResult({
              name: `Actions secret (${secretName})`,
              outcome: 'fail',
              message: `Actions secret "${secretName}" is not configured on "${owner}/${repo}".`,
              remediation: `Add "${secretName}" at https://github.com/${owner}/${repo}/settings/secrets/actions (or run: gh secret set ${secretName} --repo ${owner}/${repo}).`,
            });
          } else {
            addResult({
              name: `Actions secret (${secretName})`,
              outcome: 'warn',
              message: `Could not inspect Actions secret "${secretName}" (token may lack secrets:read).`,
              remediation: `Verify "${secretName}" is set at https://github.com/${owner}/${repo}/settings/secrets/actions.`,
            });
          }
        }

        return results;
      },
      (err) => toGitHubError(`Failed to run setup preflight checks for ${owner}/${repo}`, err),
    );
  }

  function listPrReviewers(prNumber: number) {
    return TE.tryCatch(
      async () => {
        const [prRes, reviews] = await Promise.all([
          pullsApi.get({
            ...repoParams,
            pull_number: prNumber,
          }),
          paginateRestPages(async (page) => {
            const res = await pullsApi.listReviews({
              ...repoParams,
              pull_number: prNumber,
              per_page: 100,
              page,
            });
            return res.data;
          }),
        ]);
        const prData = prRes.data;
        const prUser = prData.user;
        const prAuthor = prUser.login;
        const latestStateByUser = new Map<string, string>();
        for (const r of reviews) {
          if (!r.user) continue;
          const login = r.user.login;
          if (!login || r.user.type === 'Bot' || login === prAuthor) continue;
          if (REVIEW_DECISION_STATES.has(r.state)) {
            latestStateByUser.set(login, r.state);
          }
        }
        return Array.from(latestStateByUser.entries())
          .filter(([, state]) => state === 'CHANGES_REQUESTED')
          .map(([login]) => login);
      },
      (err) => toGitHubError(`Failed to list reviewers for PR #${String(prNumber)}`, err),
    );
  }

  function requestReviewers(prNumber: number, reviewers: ReadonlyArray<string>) {
    return TE.tryCatch(
      async () => {
        if (reviewers.length === 0) return;
        await pullsApi.requestReviewers({
          ...repoParams,
          pull_number: prNumber,
          reviewers: [...reviewers],
        });
      },
      (err) => toGitHubError(`Failed to request reviewers on PR #${String(prNumber)}`, err),
    );
  }

  return {
    getIssue,
    listAllIssues,
    createIssue,
    closeIssue,
    reopenIssue,
    updateIssueStatus,
    ensureStatusField,
    addLabels,
    removeLabel,
    addComment,
    listIssueComments,
    ensureLabels,
    dispatchWorkflow,
    listSubIssues,
    addSubIssue,
    listBlockedBy,
    listBlocking,
    addBlockedBy,
    getPullRequest,
    listOpenPrsForIssue,
    listOpenAiManagedPrs,
    createPullRequest,
    mergePullRequest,
    checkSetupPrerequisites,
    addPrComment,
    getPrReviewComments,
    getPrReviewThreads,
    getPrReviewFeedback,
    replyToReviewThread,
    resolveReviewThread,
    listPrReviewers,
    requestReviewers,
  };
}
