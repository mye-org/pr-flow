import * as E from 'fp-ts/lib/Either';
import { flow } from 'fp-ts/lib/function';
import * as RA from 'fp-ts/lib/ReadonlyArray';
import { match } from 'ts-pattern';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { DomainError } from './errors.js';
import { isoMessage } from './newtypes.js';

export const PlanIssueTypeSchema = z.enum(['epic', 'story', 'task', 'bug']);

export const PlanIssueNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().default(''),
  type: PlanIssueTypeSchema,
  parentId: z.string().min(1).optional(),
  blockedBy: z.array(z.string().min(1)).default([]),
  labels: z.array(z.string().min(1)).default([]),
});

export const PlanManifestSchema = z.object({
  version: z.literal(1),
  epic: z
    .object({
      id: z.string().min(1),
      title: z.string().min(1),
      body: z.string().default(''),
    })
    .optional(),
  issues: z.array(PlanIssueNodeSchema).min(1),
});

export type PlanIssueNode = z.infer<typeof PlanIssueNodeSchema>;
export type PlanManifest = z.infer<typeof PlanManifestSchema>;

const formatPlanIssueText = (issue: z.core.$ZodIssue) =>
  `${issue.path.join('.')}: ${issue.message}`;

const toPlanIssueMessage = flow(formatPlanIssueText, isoMessage.wrap);

const validatePlanSchema = (parsed: z.ZodSafeParseResult<PlanManifest>) =>
  match(parsed)
    .with({ success: true }, ({ data }) => E.right(data))
    .with({ success: false }, ({ error }) =>
      E.left<DomainError, PlanManifest>({
        type: 'PLAN_VALIDATION_ERROR',
        message: isoMessage.wrap('Invalid plan manifest YAML'),
        details: RA.map(toPlanIssueMessage)(error.issues),
      }),
    )
    .exhaustive();

const parsePlanYaml = flow(
  (s: string) => parseYaml(s) as z.input<typeof PlanManifestSchema>,
  (raw) => PlanManifestSchema.safeParse(raw),
);

const formatPlanYamlErrorMessage = (errMessage: string) =>
  `Failed to parse plan manifest YAML: ${errMessage}`;

const formatPlanYamlError = (errMessage: string) =>
  ({
    type: 'PLAN_VALIDATION_ERROR',
    message: isoMessage.wrap(formatPlanYamlErrorMessage(errMessage)),
    details: [],
  }) satisfies DomainError;

const toPlanYamlError = flow(E.toError, (err) => err.message, formatPlanYamlError);

const tryParsePlanYaml = (yamlContent: string) =>
  E.tryCatch(() => parsePlanYaml(yamlContent), toPlanYamlError);

export const parsePlanManifest = flow(tryParsePlanYaml, E.flatMap(validatePlanSchema));
