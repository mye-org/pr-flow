import * as E from 'fp-ts/Either';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { DomainError } from './errors.js';

export const PrFlowConfigSchema = z.object({
  version: z.literal(1),
  wipLimit: z.number().int().min(1).default(4),
  baseBranch: z.string().min(1).default('main'),
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
      command: z.string().optional(),
      timeoutMinutes: z.number().int().min(1).default(20),
    })
    .default({}),
  triggers: z
    .object({
      reviewMode: z.enum(['changes_requested', 'comment', 'both']).default('changes_requested'),
      autoPickup: z.boolean().default(true),
    })
    .default({}),
});

export type PrFlowConfig = z.infer<typeof PrFlowConfigSchema>;

export function parseConfig(yamlContent: string): E.Either<DomainError, PrFlowConfig> {
  try {
    const raw = parseYaml(yamlContent);
    const parsed = PrFlowConfigSchema.safeParse(raw);
    if (!parsed.success) {
      const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return E.left({
        type: 'CONFIG_ERROR',
        message: `Invalid pr-flow.config.yml: ${details}`,
      });
    }
    if (parsed.data.agent.provider === 'custom' && !parsed.data.agent.command) {
      return E.left({
        type: 'CONFIG_ERROR',
        message: 'agent.command is required when agent.provider is "custom".',
      });
    }
    return E.right(parsed.data);
  } catch (err) {
    return E.left({
      type: 'CONFIG_ERROR',
      message: `Failed to parse pr-flow.config.yml: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
