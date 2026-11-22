import { pipe } from 'fp-ts/lib/function';
import * as RA from 'fp-ts/lib/ReadonlyArray';
import * as TE from 'fp-ts/lib/TaskEither';
import { match } from 'ts-pattern';
import type { GitHubEffectsPort } from '../adapters/github/types.js';
import type { Effect } from '../domain/effects.js';
import type { DomainError } from '../domain/errors.js';
import {
  isoBody,
  isoBranchName,
  isoIssueNumber,
  isoLabelName,
  isoPrNumber,
  isoTitle,
} from '../domain/newtypes.js';

export function executeEffect(
  effect: Effect,
  github: GitHubEffectsPort,
) {
  return match(effect)
    .with({ type: 'SET_STATUS_FIELD' }, (e) =>
      github.updateIssueStatus(isoIssueNumber.unwrap(e.issueNumber), e.transition.to),
    )
    .with({ type: 'ADD_COMMENT' }, (e) =>
      github.addComment(isoIssueNumber.unwrap(e.issueNumber), isoBody.unwrap(e.body)),
    )
    .with({ type: 'CLOSE_ISSUE' }, (e) => github.closeIssue(isoIssueNumber.unwrap(e.issueNumber)))
    .with({ type: 'REOPEN_ISSUE' }, (e) => github.reopenIssue(isoIssueNumber.unwrap(e.issueNumber)))
    .with({ type: 'CREATE_PR' }, (e) => {
      const content = e.draft.content;
      return pipe(
        github.createPullRequest({
          content: {
            title: isoTitle.unwrap(content.title),
            body: isoBody.unwrap(content.body),
            labels: pipe(content.labels, RA.map(isoLabelName.unwrap)),
          },
          head: isoBranchName.unwrap(e.draft.branch),
          base: isoBranchName.unwrap(e.draft.baseBranch),
        }),
        TE.map(() => undefined),
      );
    })
    .with({ type: 'ADD_PR_COMMENT' }, (e) =>
      github.addPrComment(isoPrNumber.unwrap(e.prNumber), isoBody.unwrap(e.body)),
    )
    .exhaustive();
}

export function executeEffects(
  effects: ReadonlyArray<Effect>,
  github: GitHubEffectsPort,
) {
  return pipe(
    effects,
    RA.reduce(TE.right(undefined) as TE.TaskEither<DomainError, void>, (acc, effect) =>
      pipe(
        acc,
        TE.chain(() => executeEffect(effect, github)),
      ),
    ),
  );
}
