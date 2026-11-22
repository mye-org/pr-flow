import * as E from 'fp-ts/lib/Either';
import { flow } from 'fp-ts/lib/function';
import * as RA from 'fp-ts/lib/ReadonlyArray';
import { match } from 'ts-pattern';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { DomainError } from './errors.js';
import { isoMessage } from './newtypes.js';

export const PrFlowConfigSchema = z.object({
  version: z.literal(1),
  wipLimit: z.number().int().min(1).default(4),
  baseBranch: z.string().min(1).default('main'),
  statusFieldName: z.string().min(1).default('pr-flow-status'),
  workspace: z.object({
    setupCommand: z.string().default(''),
    verifyCommand: z.string().min(1),
  }),
  agent: z
    .object({
      provider: z.enum(['gemini', 'custom']).default('gemini'),
      model: z.string().default('gemini-3.8-flash'),
      fallbackModels: z.array(z.string().min(1)).default([]),
      maxRetries: z.number().int().min(0).default(3),
      maxVerifyRetries: z.number().int().min(0).default(10),
      command: z.string().optional(),
      timeoutMinutes: z.number().int().min(1).default(20),
      maxSessionTurns: z.number().int().min(1).default(25),
      compressionThreshold: z.number().min(0.05).max(0.95).default(0.2),
      thinkingBudget: z.number().int().min(0).optional(),
    })
    .prefault({}),
  triggers: z
    .object({
      reviewMode: z.enum(['changes_requested', 'comment', 'both']).default('changes_requested'),
      autoPickup: z.boolean().default(true),
      autoMergeOnApprove: z.boolean().default(true),
      mergeMethod: z.enum(['squash', 'merge', 'rebase']).default('squash'),
    })
    .prefault({}),
});

export type PrFlowConfig = z.infer<typeof PrFlowConfigSchema>;

const formatZodIssue = (issue: z.core.$ZodIssue) =>
  `${issue.path.join('.')}: ${issue.message}`;

const joinIssueMessages = (parts: ReadonlyArray<string>) => parts.join('; ');

const prefixInvalidConfig = (detail: string) => `Invalid pr-flow.config.yml: ${detail}`;

const formatInvalidConfigMessage = flow(
  RA.map(formatZodIssue),
  joinIssueMessages,
  prefixInvalidConfig,
);

const toInvalidConfigError = (issues: ReadonlyArray<z.core.$ZodIssue>) =>
  ({
    type: 'CONFIG_ERROR',
    message: isoMessage.wrap(formatInvalidConfigMessage(issues)),
  }) satisfies DomainError;

const formatParseConfigMessage = (errMessage: string) =>
  `Failed to parse pr-flow.config.yml: ${errMessage}`;

const toParseConfigError = (errMessage: string) =>
  ({
    type: 'CONFIG_ERROR',
    message: isoMessage.wrap(formatParseConfigMessage(errMessage)),
  }) satisfies DomainError;

const buildParseConfigError = flow(
  E.toError,
  (err) => err.message,
  toParseConfigError,
);

const validateCustomAgentCommand = (config: PrFlowConfig) =>
  match(config.agent.provider === 'custom' && !config.agent.command)
    .with(true, () =>
      E.left<DomainError, PrFlowConfig>({
        type: 'CONFIG_ERROR',
        message: isoMessage.wrap('agent.command is required when agent.provider is "custom".'),
      }),
    )
    .with(false, () => E.right(config))
    .exhaustive();

const validateConfigSchema = (parsed: z.ZodSafeParseResult<PrFlowConfig>) =>
  match(parsed)
    .with({ success: true }, ({ data }) => validateCustomAgentCommand(data))
    .with({ success: false }, ({ error }) =>
      E.left<DomainError, PrFlowConfig>(toInvalidConfigError(error.issues)),
    )
    .exhaustive();

const tryParseConfigYaml = (yamlContent: string) =>
  E.tryCatch(
    () => PrFlowConfigSchema.safeParse(parseYaml(yamlContent)),
    buildParseConfigError,
  );

export const parseConfig = flow(tryParseConfigYaml, E.flatMap(validateConfigSchema));
