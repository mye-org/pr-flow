import * as E from 'fp-ts/Either';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { DomainError } from './errors.js';

export const PlanPrioritySchema = z.enum(['p0', 'p1', 'p2', 'p3']);
export const PlanIssueTypeSchema = z.enum(['epic', 'story', 'task', 'bug']);

export const PlanIssueNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().default(''),
  type: PlanIssueTypeSchema,
  priority: PlanPrioritySchema.default('p2'),
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
      priority: PlanPrioritySchema.default('p1'),
    })
    .optional(),
  issues: z.array(PlanIssueNodeSchema).min(1),
});

export type PlanIssueNode = z.infer<typeof PlanIssueNodeSchema>;
export type PlanManifest = z.infer<typeof PlanManifestSchema>;

export function parsePlanManifest(yamlContent: string): E.Either<DomainError, PlanManifest> {
  try {
    const raw = parseYaml(yamlContent);
    const parsed = PlanManifestSchema.safeParse(raw);
    if (!parsed.success) {
      return E.left({
        type: 'PLAN_VALIDATION_ERROR',
        message: 'Invalid plan manifest YAML',
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    return E.right(parsed.data);
  } catch (err) {
    return E.left({
      type: 'PLAN_VALIDATION_ERROR',
      message: `Failed to parse plan manifest YAML: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
