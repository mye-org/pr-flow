import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { match } from 'ts-pattern';
import type { GitHubPort } from '../adapters/github/types.js';
import type { Effect } from '../domain/effects.js';
import type { DomainError } from '../domain/errors.js';

export function executeEffect(
  effect: Effect,
  github: GitHubPort,
): TE.TaskEither<DomainError, void> {
  return match(effect)
    .with({ type: 'SET_STATUS_FIELD' }, (e) => github.setIssueStatus(e.issueNumber, e.to))
    .with({ type: 'ADD_COMMENT' }, (e) => github.addComment(e.issueNumber, e.body))
    .with({ type: 'CLOSE_ISSUE' }, (e) => github.closeIssue(e.issueNumber))
    .with({ type: 'REOPEN_ISSUE' }, (e) => github.reopenIssue(e.issueNumber))
    .with({ type: 'CREATE_PR' }, (e) =>
      pipe(
        github.createPullRequest({
          title: e.title,
          body: e.body,
          head: e.branch,
          base: e.baseBranch,
          labels: e.labels,
        }),
        TE.map(() => undefined),
      ),
    )
    .with({ type: 'ADD_PR_COMMENT' }, (e) => github.addPrComment(e.prNumber, e.body))
    .exhaustive();
}

export function executeEffects(
  effects: readonly Effect[],
  github: GitHubPort,
): TE.TaskEither<DomainError, void> {
  return effects.reduce<TE.TaskEither<DomainError, void>>(
    (acc, effect) => pipe(acc, TE.chain(() => executeEffect(effect, github))),
    TE.right(undefined),
  );
}
