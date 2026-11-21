import * as E from 'fp-ts/lib/Either';
import { pipe } from 'fp-ts/lib/function';
import * as O from 'fp-ts/lib/Option';
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

const validatePlanSchema = (
  parsed: z.SafeParseReturnType<z.input<typeof PlanManifestSchema>, PlanManifest>,
): E.Either<DomainError, PlanManifest> =>
  match(parsed)
    .with({ success: true }, ({ data }) => E.right(data))
    .with({ success: false }, ({ error }) =>
      E.left<DomainError, PlanManifest>({
        type: 'PLAN_VALIDATION_ERROR',
        message: isoMessage.wrap('Invalid plan manifest YAML'),
        details: O.some(
          pipe(
            error.issues,
            RA.map((i) => isoMessage.wrap(`${i.path.join('.')}: ${i.message}`)),
          ),
        ),
      }),
    )
    .exhaustive();

export function parsePlanManifest(yamlContent: string): E.Either<DomainError, PlanManifest> {
  return pipe(
    E.tryCatch(
      () => PlanManifestSchema.safeParse(parseYaml(yamlContent)),
      (err): DomainError => ({
        type: 'PLAN_VALIDATION_ERROR',
        message: isoMessage.wrap(
          `Failed to parse plan manifest YAML: ${err instanceof Error ? err.message : String(err)}`,
        ),
        details: O.none,
      }),
    ),
    E.chain(validatePlanSchema),
  );
}
