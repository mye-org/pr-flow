import { describe, expect, it } from 'vitest';
import { isModelFallbackError, isTransientAgentError } from '../src/adapters/agent/runner.js';

describe('isTransientAgentError', () => {
  it('detects 503, 429, UNAVAILABLE, fetch failed, and timeouts as transient', () => {
    expect(isTransientAgentError('Attempt 1 failed with status 503. Service Unavailable', false)).toBe(true);
    expect(isTransientAgentError('status: 429 Too Many Requests', false)).toBe(true);
    expect(isTransientAgentError('TypeError: fetch failed sending request', false)).toBe(true);
    expect(isTransientAgentError('', true)).toBe(true);
  });

  it('does not classify 404 or non-transient code errors as retryable', () => {
    expect(isTransientAgentError('ModelNotFoundError: 404 is no longer available', false)).toBe(false);
    expect(isTransientAgentError('TypeError: Cannot read properties of undefined', false)).toBe(false);
    expect(isTransientAgentError('SyntaxError: Unexpected token', false)).toBe(false);
  });
});

describe('isModelFallbackError', () => {
  it('triggers fallback on transient errors and 404 ModelNotFoundError', () => {
    expect(isModelFallbackError('status 503 Service Unavailable', false)).toBe(true);
    expect(isModelFallbackError('ModelNotFoundError: This model is no longer available', false)).toBe(true);
    expect(isModelFallbackError('code: 404', false)).toBe(true);
    expect(isModelFallbackError('SyntaxError: Unexpected token', false)).toBe(false);
  });
});
