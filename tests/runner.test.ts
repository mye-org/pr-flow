import { describe, expect, it } from 'vitest';
import { isTransientAgentError } from '../src/adapters/agent/runner.js';

describe('isTransientAgentError', () => {
  it('detects 503, 429, UNAVAILABLE, fetch failed, and timeouts as transient', () => {
    expect(isTransientAgentError('Attempt 1 failed with status 503. Service Unavailable', false)).toBe(true);
    expect(isTransientAgentError('status: 429 Too Many Requests', false)).toBe(true);
    expect(isTransientAgentError('TypeError: fetch failed sending request', false)).toBe(true);
    expect(isTransientAgentError('', true)).toBe(true);
  });

  it('does not classify non-transient errors as retryable', () => {
    expect(isTransientAgentError('TypeError: Cannot read properties of undefined', false)).toBe(false);
    expect(isTransientAgentError('SyntaxError: Unexpected token', false)).toBe(false);
  });
});
