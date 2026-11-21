import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { buildImplementPrompt, buildReviewPrompt } from '../adapters/agent/prompts.js';
import { runAgentExecution } from '../adapters/agent/runner.js';
import { OctokitGitHubAdapter } from '../adapters/github/client.js';
import type { GitHubPort } from '../adapters/github/types.js';
import { parseConfig, type PrFlowConfig } from '../domain/config.js';
import { formatGuardError, type DomainError } from '../domain/errors.js';
import {
  AgentResultSchema,
  AI_MANAGED_LABEL,
  branchNameForIssue,
  DEFAULT_LABELS,
  FIELD_VALUE_TO_STATUS,
  isContainerIssue,
  isExecutableLeaf,
  STATUS_TO_FIELD_VALUE,
  type IssueNode,
  type IssueStatus,
} from '../domain/issue.js';
import { parsePlanManifest } from '../domain/plan.js';
import { executeEffects } from '../interpreter/executeEffects.js';
import { checkPickupEligibility } from '../machine/guards.js';
import { transitionIssue } from '../machine/issueMachine.js';
import { materializePlan } from '../planner/materialize.js';
import { validatePlanDag } from '../planner/validateDag.js';
import { computeRollupEffects } from '../rollup/computeRollup.js';
import { generateInitFiles } from './init.js';

function formatDomainError(err: DomainError): string {
  switch (err.type) {
    case 'CONFIG_ERROR':
      return `Configuration error: ${err.message}`;
    case 'PLAN_VALIDATION_ERROR':
      return `Plan validation error: ${err.message}${err.details ? `\n  - ${err.details.join('\n  - ')}` : ''}`;
    case 'GITHUB_API_ERROR':
      return `GitHub API error: ${err.message}`;
    case 'AGENT_EXECUTION_ERROR':
      return `Agent execution error: ${err.message}`;
    case 'GUARD_ERROR':
      return `Guard blocked transition: ${formatGuardError(err.guard)}`;
    case 'GIT_ERROR':
      return `Git error: ${err.message}`;
  }
}

function fail(err: DomainError): never {
  console.error(formatDomainError(err));
  process.exit(1);
}

function loadConfigFromDisk(configPath = 'pr-flow.config.yml'): PrFlowConfig {
  const abs = path.resolve(configPath);
  if (!fs.existsSync(abs)) {
    fail({ type: 'CONFIG_ERROR', message: `File not found: ${abs}` });
  }
  const content = fs.readFileSync(abs, 'utf-8');
  const parsed = parseConfig(content);
  if (E.isLeft(parsed)) {
    fail(parsed.left);
  }
  return parsed.right;
}

function createGitHubFromEnv(repoFlag?: string, statusFieldName?: string): GitHubPort {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    fail({ type: 'CONFIG_ERROR', message: 'GITHUB_TOKEN (or GH_TOKEN) environment variable is required.' });
  }
  const repoSlug = repoFlag || process.env.GITHUB_REPOSITORY;
  if (!repoSlug || !repoSlug.includes('/')) {
    fail({ type: 'CONFIG_ERROR', message: 'Repository must be specified via --repo owner/name or GITHUB_REPOSITORY.' });
  }
  const [owner, repo] = repoSlug.split('/', 2) as [string, string];
  return new OctokitGitHubAdapter({ token, owner, repo, statusFieldName });
}

async function runOrExit<T>(task: TE.TaskEither<DomainError, T>): Promise<T> {
  const res = await task();
  if (E.isLeft(res)) {
    fail(res.left);
  }
  return res.right;
}

function runGit(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const program = new Command();

program
  .name('pr-flow')
  .description('Project-agnostic Agile Issue-to-PR workflow engine')
  .version('1.0.0');

function printPreflightReport(
  checks: ReadonlyArray<{
    name: string;
    status: 'pass' | 'warn' | 'fail';
    message: string;
    remediation?: string;
  }>,
): boolean {
  console.log('\npr-flow Preflight Checks:');
  let hasFailures = false;
  for (const check of checks) {
    const tag = check.status === 'pass' ? '[PASS]' : check.status === 'warn' ? '[WARN]' : '[FAIL]';
    console.log(`  ${tag} ${check.name}: ${check.message}`);
    if (check.remediation) {
      console.log(`         Fix: ${check.remediation}`);
    }
    if (check.status === 'fail') {
      hasFailures = true;
    }
  }
  return hasFailures;
}

program
  .command('init')
  .description('Bootstrap pr-flow config, AGENTS.md, workflows, and agent skills in a target repository')
  .option('--dir <path>', 'Target repository directory', '.')
  .option('--owner <owner>', 'GitHub owner of the pr-flow repository', 'mye-org')
  .option('--ref <ref>', 'Git ref/tag of pr-flow workflows', 'v1')
  .option('--base-branch <branch>', 'Default base branch', 'main')
  .option('--wip-limit <n>', 'Max concurrent in-progress issues', '4')
  .option('--setup-command <cmd>', 'Workspace setup command', 'npm ci')
  .option('--verify-command <cmd>', 'Workspace verification command', 'npm test')
  .option('--review-mode <mode>', 'Review trigger mode (changes_requested|comment|both)', 'changes_requested')
  .option('--force', 'Overwrite existing files', false)
  .option('--sync-labels', 'Also sync GitHub labels via GITHUB_TOKEN', false)
  .option('--create-custom-field', 'Also create/verify the pr-flow-status organization Issue Field via GITHUB_TOKEN', false)
  .option('--skip-checks', 'Skip GitHub repository preflight checks', false)
  .option('--repo <owner/repo>', 'Target GitHub repository for --sync-labels / --create-custom-field / preflight checks')
  .action(async (opts) => {
    const result = generateInitFiles({
      targetDir: path.resolve(opts.dir),
      prFlowOwner: opts.owner,
      prFlowRef: opts.ref,
      baseBranch: opts.baseBranch,
      wipLimit: Number(opts.wipLimit),
      setupCommand: opts.setupCommand,
      verifyCommand: opts.verifyCommand,
      reviewMode: opts.reviewMode,
      force: Boolean(opts.force),
    });

    console.log('Initialized pr-flow files:');
    for (const f of result.written) console.log(`  + ${path.relative(process.cwd(), f)}`);
    for (const f of result.skipped) console.log(`  ~ ${path.relative(process.cwd(), f)} (skipped; use --force to overwrite)`);

    if (opts.syncLabels) {
      const github = createGitHubFromEnv(opts.repo);
      await runOrExit(github.ensureLabels(DEFAULT_LABELS));
      console.log(`Synced ${DEFAULT_LABELS.length} pr-flow labels to GitHub.`);
    }

    if (opts.createCustomField) {
      const github = createGitHubFromEnv(opts.repo);
      await runOrExit(github.ensureStatusField());
      console.log('Synced pr-flow-status organization Issue Field.');
    }

    const repoSlug = opts.repo ?? process.env.GITHUB_REPOSITORY;
    if (!opts.skipChecks && process.env.GITHUB_TOKEN && repoSlug) {
      const github = createGitHubFromEnv(repoSlug);
      const checks = await runOrExit(
        github.checkSetupPrerequisites({
          prFlowOwner: opts.owner,
          expectedLabels: DEFAULT_LABELS,
        }),
      );
      const hasFailures = printPreflightReport(checks);
      if (hasFailures) {
        process.exitCode = 1;
      }
    } else if (!opts.skipChecks) {
      console.log(
        `\nTip: Run \`GITHUB_TOKEN=$(gh auth token) npx --yes github:${opts.owner}/pr-flow#${opts.ref} doctor --repo <owner>/<repo>\` to verify GitHub Actions permissions, Issue Field, labels, and secrets.`,
      );
    }
  });

program
  .command('doctor')
  .description('Verify GitHub repository prerequisites (pr-flow visibility, Actions PR permissions, Issue Field, labels, secrets)')
  .option('--repo <owner/repo>', 'GitHub repository (defaults to GITHUB_REPOSITORY)')
  .option('--owner <owner>', 'GitHub owner of the pr-flow repository', 'mye-org')
  .option('--field-name <name>', 'Issue Field name', 'pr-flow-status')
  .option('--secret-name <name>', 'Required Actions secret name', 'GEMINI_API_KEY')
  .action(async (opts) => {
    const github = createGitHubFromEnv(opts.repo, opts.fieldName);
    const checks = await runOrExit(
      github.checkSetupPrerequisites({
        prFlowOwner: opts.owner,
        expectedLabels: DEFAULT_LABELS,
        secretName: opts.secretName,
      }),
    );
    const hasFailures = printPreflightReport(checks);
    if (hasFailures) {
      process.exit(1);
    }
  });

const labelsCmd = program.command('labels').description('Manage pr-flow GitHub labels');

labelsCmd
  .command('sync')
  .description('Idempotently create or update all pr-flow labels in the target GitHub repository')
  .option('--repo <owner/repo>', 'GitHub repository (defaults to GITHUB_REPOSITORY)')
  .action(async (opts) => {
    const github = createGitHubFromEnv(opts.repo);
    await runOrExit(github.ensureLabels(DEFAULT_LABELS));
    console.log(`Synced ${DEFAULT_LABELS.length} labels.`);
  });

const fieldsCmd = program.command('fields').description('Manage pr-flow GitHub organization Issue Fields');

fieldsCmd
  .command('sync')
  .description('Idempotently create the pr-flow-status Single-Select Issue Field in the target GitHub organization')
  .option('--field-name <name>', 'Issue Field name', 'pr-flow-status')
  .option('--repo <owner/repo>', 'GitHub repository (defaults to GITHUB_REPOSITORY)')
  .action(async (opts) => {
    const github = createGitHubFromEnv(opts.repo, opts.fieldName);
    await runOrExit(github.ensureStatusField());
    console.log(`Synced "${opts.fieldName}" Issue Field.`);
  });

const statusCmd = program.command('status').description('Manage pr-flow-status Issue Field values on issues');

statusCmd
  .command('set')
  .description('Set the pr-flow-status Issue Field on a GitHub issue')
  .requiredOption('--issue <number>', 'Issue number')
  .requiredOption(
    '--status <value>',
    'Target status (backlog|blocked-dep|ready|in-progress|review-pending|fixed|needs-human)',
  )
  .option('--field-name <name>', 'Issue Field name', 'pr-flow-status')
  .option('--repo <owner/repo>', 'GitHub repository (defaults to GITHUB_REPOSITORY)')
  .action(async (opts) => {
    const rawStatus = String(opts.status).trim();
    const resolvedStatus: IssueStatus | undefined =
      FIELD_VALUE_TO_STATUS[rawStatus] ??
      (Object.prototype.hasOwnProperty.call(STATUS_TO_FIELD_VALUE, rawStatus)
        ? (rawStatus as IssueStatus)
        : undefined);

    if (!resolvedStatus) {
      fail({
        type: 'CONFIG_ERROR',
        message: `Invalid status "${rawStatus}". Expected one of: ${Object.values(STATUS_TO_FIELD_VALUE).join(', ')}.`,
      });
    }

    const issueNumber = Number(opts.issue);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      fail({
        type: 'CONFIG_ERROR',
        message: `Invalid issue number "${opts.issue}".`,
      });
    }

    const github = createGitHubFromEnv(opts.repo, opts.fieldName);
    await runOrExit(github.setIssueStatus(issueNumber, resolvedStatus));
    console.log(
      JSON.stringify({
        updated: true,
        issue: issueNumber,
        field: opts.fieldName,
        status: STATUS_TO_FIELD_VALUE[resolvedStatus],
      }),
    );
  });

const planCmd = program.command('plan').description('Validate and materialize plan manifests');

planCmd
  .command('validate')
  .description('Validate a plan-manifest.yml schema and dependency DAG')
  .requiredOption('--file <path>', 'Path to plan-manifest.yml')
  .action((opts) => {
    const content = fs.readFileSync(path.resolve(opts.file), 'utf-8');
    const res = pipe(parsePlanManifest(content), E.chain(validatePlanDag));
    if (E.isLeft(res)) fail(res.left);
    console.log(`Plan manifest valid (${res.right.issues.length} issues).`);
  });

planCmd
  .command('materialize')
  .description('Create GitHub issues, sub-issue links, and blocked_by dependencies from a plan manifest')
  .requiredOption('--file <path>', 'Path to plan-manifest.yml')
  .option('--repo <owner/repo>', 'GitHub repository (defaults to GITHUB_REPOSITORY)')
  .action(async (opts) => {
    const content = fs.readFileSync(path.resolve(opts.file), 'utf-8');
    const parsed = pipe(parsePlanManifest(content), E.chain(validatePlanDag));
    if (E.isLeft(parsed)) fail(parsed.left);

    const github = createGitHubFromEnv(opts.repo);
    const result = await runOrExit(materializePlan(parsed.right, github));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('claim')
  .description('Run deterministic FSM pickup guards and claim an issue into pr-flow-status: in-progress')
  .requiredOption('--issue <number>', 'Issue number')
  .option('--config <path>', 'Path to pr-flow.config.yml', 'pr-flow.config.yml')
  .option('--repo <owner/repo>', 'GitHub repository')
  .action(async (opts) => {
    const issueNumber = Number(opts.issue);
    const config = loadConfigFromDisk(opts.config);
    const github = createGitHubFromEnv(opts.repo);

    const data = await runOrExit(
      pipe(
        TE.Do,
        TE.apS('issue', github.getIssue(issueNumber)),
        TE.apS('allOpen', github.listAllIssues('open')),
        TE.apS('blockedBy', github.listBlockedBy(issueNumber)),
        TE.apS('openPrs', github.listOpenPrsForIssue(issueNumber)),
      ),
    );

    const wipCount = data.allOpen.filter(
      (i) => i.status === 'in_progress' && i.number !== issueNumber,
    ).length;
    const openBlockers = data.blockedBy.filter((b) => b.state === 'open').map((b) => b.number);
    const allBlockersClosed = openBlockers.length === 0;

    const guardCheck = checkPickupEligibility({
      issue: data.issue,
      wipCount,
      wipLimit: config.wipLimit,
      openPrCount: data.openPrs.length,
      allBlockersClosed,
      blockingIssues: openBlockers,
    });

    if (E.isLeft(guardCheck)) {
      console.log(JSON.stringify({ claimed: false, reason: formatGuardError(guardCheck.left) }));
      return;
    }

    const transition = transitionIssue(data.issue, {
      type: 'PICKUP_REQUESTED',
      wipCount,
      wipLimit: config.wipLimit,
      openPrCount: data.openPrs.length,
      isLeaf: isExecutableLeaf(data.issue),
      allBlockersClosed,
    });

    if (!transition.changed) {
      console.log(JSON.stringify({ claimed: false, reason: 'No state transition occurred.' }));
      return;
    }

    await runOrExit(executeEffects(transition.effects, github));
    console.log(
      JSON.stringify({
        claimed: true,
        issueNumber,
        previousStatus: transition.previousStatus,
        nextStatus: transition.nextStatus,
        wipCount: wipCount + 1,
        wipLimit: config.wipLimit,
      }),
    );
  });

program
  .command('execute')
  .description('Run AI coding agent + verifyCommand with zero GitHub write tokens, exporting changes.patch & result.json')
  .requiredOption('--issue <number>', 'Issue number')
  .option('--pr <number>', 'PR number (for review follow-up mode)')
  .option('--config <path>', 'Path to pr-flow.config.yml', 'pr-flow.config.yml')
  .option('--output-dir <dir>', 'Directory for result.json and changes.patch', '.pr-flow-out')
  .option('--repo <owner/repo>', 'GitHub repository')
  .action(async (opts) => {
    const issueNumber = Number(opts.issue);
    const prNumber = opts.pr ? Number(opts.pr) : undefined;
    const config = loadConfigFromDisk(opts.config);
    const github = createGitHubFromEnv(opts.repo);
    const cwd = process.cwd();
    const outputDir = path.resolve(opts.outputDir);
    const resultFilePath = path.join(outputDir, 'result.json');

    const issue = await runOrExit(github.getIssue(issueNumber));
    const agentsMd = fs.existsSync(path.join(cwd, 'AGENTS.md'))
      ? fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf-8')
      : undefined;

    let prompt: string;
    if (prNumber) {
      const reviewComments = await runOrExit(github.getPrReviewComments(prNumber));
      prompt = buildReviewPrompt({
        issue,
        prNumber,
        reviewComments,
        verifyCommand: config.workspace.verifyCommand,
        agentsMd,
        resultFilePath,
      });
    } else {
      prompt = buildImplementPrompt({
        issue,
        verifyCommand: config.workspace.verifyCommand,
        agentsMd,
        resultFilePath,
      });
    }

    const runResult = runAgentExecution({
      config,
      prompt,
      cwd,
      outputDir,
    });

    if (E.isLeft(runResult)) {
      const isRetryable =
        runResult.left.type === 'AGENT_EXECUTION_ERROR' && runResult.left.retryable === true;
      const resultStatus = isRetryable ? 'retryable' : 'failed';
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(
        resultFilePath,
        JSON.stringify(
          {
            status: resultStatus,
            summary: isRetryable
              ? 'Agent execution hit a transient API/network error.'
              : 'Agent execution errored before verification.',
            reason: formatDomainError(runResult.left),
            testsRun: false,
          },
          null,
          2,
        ),
      );
      fs.writeFileSync(path.join(outputDir, 'changes.patch'), '', 'utf-8');
      console.log(JSON.stringify({ status: resultStatus, reason: formatDomainError(runResult.left) }));
      return;
    }

    console.log(
      JSON.stringify({
        status: runResult.right.result.status,
        hasChanges: runResult.right.hasChanges,
        resultPath: runResult.right.resultPath,
        patchPath: runResult.right.patchPath,
      }),
    );
  });

program
  .command('finalize')
  .description('Apply changes.patch, push ai/issue-<N>, open/update PR, and transition issue state')
  .requiredOption('--issue <number>', 'Issue number')
  .requiredOption('--result <path>', 'Path to result.json')
  .requiredOption('--patch <path>', 'Path to changes.patch')
  .option('--pr <number>', 'Existing PR number (review follow-up mode)')
  .option('--config <path>', 'Path to pr-flow.config.yml', 'pr-flow.config.yml')
  .option('--repo <owner/repo>', 'GitHub repository')
  .action(async (opts) => {
    const issueNumber = Number(opts.issue);
    const existingPr = opts.pr ? Number(opts.pr) : undefined;
    const config = loadConfigFromDisk(opts.config);
    const github = createGitHubFromEnv(opts.repo);
    const cwd = process.cwd();

    const rawResult = JSON.parse(fs.readFileSync(path.resolve(opts.result), 'utf-8'));
    const parsedResult = AgentResultSchema.safeParse(rawResult);
    if (!parsedResult.success) {
      fail({ type: 'CONFIG_ERROR', message: 'Invalid result.json format' });
    }

    const agentResult = parsedResult.data;
    const issue = await runOrExit(github.getIssue(issueNumber));
    const branch = branchNameForIssue(issueNumber);

    if (agentResult.status !== 'success') {
      if (agentResult.status === 'retryable') {
        const comments = await runOrExit(github.listIssueComments(issueNumber));
        let retryCount = 0;
        for (const body of comments) {
          const matches = body.matchAll(/<!--\s*pr-flow:retries=(\d+)\s*-->/g);
          for (const m of matches) {
            const n = Number(m[1]);
            if (!Number.isNaN(n) && n > retryCount) retryCount = n;
          }
        }
        const transition = transitionIssue(issue, {
          type: 'TRANSIENT_EXECUTION_FAILED',
          reason: agentResult.reason ?? agentResult.summary,
          retryCount,
          maxRetries: config.agent.maxRetries,
        });
        await runOrExit(executeEffects(transition.effects, github));
        console.log(
          JSON.stringify({
            finalized: true,
            status: transition.nextStatus,
            retryCount: retryCount + 1,
            maxRetries: config.agent.maxRetries,
          }),
        );
        return;
      }

      const event =
        agentResult.status === 'needs_human'
          ? ({ type: 'NEEDS_HUMAN_DETECTED', reason: agentResult.reason ?? agentResult.summary } as const)
          : ({ type: 'EXECUTION_FAILED', reason: agentResult.reason ?? agentResult.summary } as const);

      const transition = transitionIssue(issue, event);
      await runOrExit(executeEffects(transition.effects, github));
      console.log(JSON.stringify({ finalized: true, status: transition.nextStatus }));
      return;
    }

    const patchContent = fs.readFileSync(path.resolve(opts.patch), 'utf-8');
    if (patchContent.trim().length === 0) {
      const transition = transitionIssue(issue, {
        type: 'NEEDS_HUMAN_DETECTED',
        reason: 'Agent reported success but produced an empty diff (no file changes).',
      });
      await runOrExit(executeEffects(transition.effects, github));
      console.log(JSON.stringify({ finalized: true, status: transition.nextStatus }));
      return;
    }

    try {
      runGit('config user.name "pr-flow[bot]"', cwd);
      runGit('config user.email "pr-flow[bot]@users.noreply.github.com"', cwd);

      if (existingPr) {
        runGit(`fetch origin ${branch}`, cwd);
        runGit(`checkout -B ${branch} origin/${branch}`, cwd);
      } else {
        runGit(`fetch origin ${config.baseBranch}`, cwd);
        runGit(`checkout -B ${branch} origin/${config.baseBranch}`, cwd);
      }

      execSync(`git apply --index ${JSON.stringify(path.resolve(opts.patch))}`, {
        cwd,
        stdio: 'pipe',
      });
      const commitMsg = existingPr
        ? `fix: address review feedback for #${issueNumber}`
        : `feat: implement #${issueNumber} (${issue.title})`;
      runGit(`commit -m ${JSON.stringify(commitMsg)}`, cwd);
      runGit(existingPr ? `push origin ${branch}` : `push --force origin ${branch}`, cwd);
    } catch (err) {
      const transition = transitionIssue(issue, {
        type: 'EXECUTION_FAILED',
        reason: `Failed to apply patch or push branch ${branch}: ${err instanceof Error ? err.message : String(err)}`,
      });
      await runOrExit(executeEffects(transition.effects, github));
      fail({
        type: 'GIT_ERROR',
        message: `Git finalization failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    let prNumber = existingPr;
    if (!prNumber) {
      const openPrs = await runOrExit(github.listOpenPrsForIssue(issueNumber));
      if (openPrs.length > 0) {
        prNumber = openPrs[0]!.number;
      } else {
        const createdPr = await runOrExit(
          github.createPullRequest({
            title: `${issue.title} (#${issueNumber})`,
            body: `Closes #${issueNumber}\n\n### Summary\n${agentResult.summary}\n\n---\n*Automated by \`pr-flow\`.*`,
            head: branch,
            base: config.baseBranch,
            labels: [AI_MANAGED_LABEL],
          }),
        );
        prNumber = createdPr.number;
      }
    } else {
      await runOrExit(
        github.addPrComment(
          prNumber,
          `Applied review fixes on \`${branch}\`.\n\n**Summary:** ${agentResult.summary}`,
        ),
      );
    }

    const transition = transitionIssue(issue, {
      type: 'EXECUTION_SUCCEEDED',
      prNumber,
      branch,
      summary: agentResult.summary,
    });
    await runOrExit(executeEffects(transition.effects, github));

    console.log(
      JSON.stringify({
        finalized: true,
        issueNumber,
        prNumber,
        branch,
        status: transition.nextStatus,
      }),
    );
  });

program
  .command('merge')
  .description('Merge an approved ai-managed pull request and transition its linked issue to pr-flow-status: fixed')
  .requiredOption('--pr <number>', 'Pull request number')
  .option('--issue <number>', 'Linked issue number (optional)', '0')
  .option('--config <path>', 'Path to pr-flow.config.yml', 'pr-flow.config.yml')
  .option('--repo <owner/repo>', 'GitHub repository')
  .action(async (opts) => {
    const prNumber = Number(opts.pr);
    const issueNumber = Number(opts.issue);
    const configPath = path.resolve(opts.config);
    const config = fs.existsSync(configPath) ? loadConfigFromDisk(opts.config) : null;
    const autoMerge = config ? config.triggers.autoMergeOnApprove : true;
    const mergeMethod = config ? config.triggers.mergeMethod : 'squash';

    if (!autoMerge) {
      console.log(JSON.stringify({ merged: false, reason: 'triggers.autoMergeOnApprove is false' }));
      return;
    }

    const github = createGitHubFromEnv(opts.repo);
    await runOrExit(github.mergePullRequest(prNumber, mergeMethod));

    if (issueNumber > 0) {
      const issue = await runOrExit(github.getIssue(issueNumber));
      const tr = transitionIssue(issue, { type: 'PR_MERGED', prNumber });
      await runOrExit(executeEffects(tr.effects, github));
    }

    console.log(JSON.stringify({ merged: true, prNumber, mergeMethod, issueNumber }));
  });

program
  .command('sync')
  .description('Synchronize dependency states and parent rollups after issue or PR events')
  .option('--issue <number>', 'Issue number that changed', '0')
  .option('--pr <number>', 'PR number that closed/merged', '0')
  .option('--pr-merged', 'Whether the closed PR was merged', false)
  .option('--repo <owner/repo>', 'GitHub repository')
  .action(async (opts) => {
    const github = createGitHubFromEnv(opts.repo);
    const issueNumber = Number(opts.issue);

    const allIssues = await runOrExit(github.listAllIssues('all'));
    const byNumber = new Map<number, IssueNode>(allIssues.map((i) => [i.number, i]));

    // If an issue closed or merged, unblock downstream issues whose blockers are all closed
    if (issueNumber > 0) {
      const target = await runOrExit(github.getIssue(issueNumber));
      for (const downstreamNum of target.blockingNumbers) {
        const downstream = await runOrExit(github.getIssue(downstreamNum));
        if (downstream.status === 'blocked_dep') {
          const blockers = await runOrExit(github.listBlockedBy(downstreamNum));
          if (blockers.every((b) => b.state === 'closed')) {
            const tr = transitionIssue(downstream, { type: 'DEPS_RESOLVED' });
            await runOrExit(executeEffects(tr.effects, github));
          }
        }
      }
    }

    // Recompute rollups for any container issues
    for (const candidate of allIssues) {
      if (candidate.type === 'epic' || candidate.type === 'story') {
        const subNums = await runOrExit(github.listSubIssues(candidate.number));
        if (subNums.length === 0) continue;
        const children = subNums
          .map((n) => byNumber.get(n))
          .filter((n): n is IssueNode => Boolean(n));
        if (children.length === 0) continue;
        const { effects } = computeRollupEffects(candidate, children);
        await runOrExit(executeEffects(effects, github));
      }
    }

    console.log(JSON.stringify({ synced: true, issueNumber, prNumber: Number(opts.pr), prMerged: Boolean(opts.prMerged) }));
  });

program
  .command('reconcile')
  .description('Reconcile blocked_dep issues, container rollups, and dispatch ready issues')
  .option('--config <path>', 'Path to pr-flow.config.yml', 'pr-flow.config.yml')
  .option('--cooldown-minutes <n>', 'Minimum minutes since last update before auto-dispatching ready issues', '10')
  .option('--repo <owner/repo>', 'GitHub repository')
  .action(async (opts) => {
    const github = createGitHubFromEnv(opts.repo);
    const configPath = path.resolve(opts.config);
    const config = fs.existsSync(configPath) ? loadConfigFromDisk(opts.config) : null;
    const allIssues = await runOrExit(github.listAllIssues('all'));
    const byNumber = new Map<number, IssueNode>(allIssues.map((i) => [i.number, i]));

    let unblocked = 0;
    let rolledUp = 0;
    let dispatched = 0;

    for (const issue of allIssues) {
      if (issue.state === 'open' && issue.status === 'blocked_dep') {
        const blockers = await runOrExit(github.listBlockedBy(issue.number));
        if (blockers.every((b) => b.state === 'closed')) {
          const tr = transitionIssue(issue, { type: 'DEPS_RESOLVED' });
          await runOrExit(executeEffects(tr.effects, github));
          issue.status = 'ready';
          unblocked++;
        }
      }
    }

    for (const candidate of allIssues) {
      if (isContainerIssue(candidate) || candidate.type === 'story') {
        const subNums = await runOrExit(github.listSubIssues(candidate.number));
        if (subNums.length === 0) continue;
        const children = subNums
          .map((n) => byNumber.get(n))
          .filter((n): n is IssueNode => Boolean(n));
        if (children.length === 0) continue;
        const { effects } = computeRollupEffects(candidate, children);
        if (effects.length > 0) {
          await runOrExit(executeEffects(effects, github));
          rolledUp++;
        }
      }
    }

    if (config && config.triggers.autoPickup) {
      const wipCount = allIssues.filter((i) => i.state === 'open' && i.status === 'in_progress').length;
      let availableSlots = Math.max(0, config.wipLimit - wipCount);
      const cooldownMs = Number(opts.cooldownMinutes) * 60_000;
      const now = Date.now();

      for (const issue of allIssues) {
        if (availableSlots <= 0) break;
        if (issue.state !== 'open' || issue.status !== 'ready') continue;
        if (!isExecutableLeaf(issue)) continue;
        const ageMs = now - Date.parse(issue.updatedAt);
        if (!Number.isNaN(ageMs) && ageMs < cooldownMs) continue;

        const blockers = await runOrExit(github.listBlockedBy(issue.number));
        if (!blockers.every((b) => b.state === 'closed')) continue;

        const openPrs = await runOrExit(github.listOpenPrsForIssue(issue.number));
        if (openPrs.length > 0) continue;

        await runOrExit(
          github.dispatchWorkflow('pr-flow-implement.yml', config.baseBranch, {
            issue_number: String(issue.number),
          }),
        );
        availableSlots--;
        dispatched++;
      }

      // Also auto-retry open ai-managed PRs with unaddressed CHANGES_REQUESTED past cooldown
      const managedPrs = await runOrExit(github.listOpenAiManagedPrs());
      for (const pr of managedPrs) {
        if (pr.latestReviewState !== 'CHANGES_REQUESTED') continue;
        const linkedIssue = byNumber.get(pr.issueNumber);
        if (!linkedIssue || linkedIssue.state !== 'open' || linkedIssue.status !== 'review_pending') {
          continue;
        }
        const ageMs = now - Date.parse(pr.updatedAt);
        if (!Number.isNaN(ageMs) && ageMs < cooldownMs) continue;

        const comments = await runOrExit(github.listIssueComments(pr.issueNumber));
        let retryCount = 0;
        for (const body of comments) {
          const matches = body.matchAll(/<!--\s*pr-flow:retries=(\d+)\s*-->/g);
          for (const m of matches) {
            const n = Number(m[1]);
            if (!Number.isNaN(n) && n > retryCount) retryCount = n;
          }
        }
        if (retryCount >= config.agent.maxRetries) continue;

        await runOrExit(
          github.dispatchWorkflow('pr-flow-review.yml', config.baseBranch, {
            pr_number: String(pr.number),
          }),
        );
        dispatched++;
      }
    }

    console.log(JSON.stringify({ reconciled: true, unblocked, rolledUp, dispatched }));
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
