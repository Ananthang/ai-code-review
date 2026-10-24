import { describe, expect, it } from 'vitest';
import { LIMIT_CEILINGS, parseConfig } from '../src/config.js';

describe('Configuration parsing & limit ceilings', () => {
  it('parses valid configuration with defaults', () => {
    const config = parseConfig({
      githubToken: 'ghp_fake_token_for_testing_123456789012',
      provider: 'fake',
      model: 'fake-model-v1',
    });

    expect(config.githubToken).toBe('ghp_fake_token_for_testing_123456789012');
    expect(config.provider).toBe('fake');
    expect(config.model).toBe('fake-model-v1');
    expect(config.maxFiles).toBe(20);
    expect(config.maxFindings).toBe(10);
    expect(config.allowExternalProvider).toBe(false);
    expect(config.mode).toBe('comment');
  });

  it('throws when model is missing from all inputs and env vars', () => {
    delete process.env.AI_MODEL;
    delete process.env.MODEL;
    delete process.env.GEMINI_MODEL;
    delete process.env.VARS_AI_MODEL;
    expect(() =>
      parseConfig({
        githubToken: 'ghp_test',
        provider: 'gemini',
        model: '',
      })
    ).toThrow(/model must be explicitly specified/);
  });

  it('reads model from AI_MODEL environment or GitHub variable', () => {
    process.env.AI_MODEL = 'gemini-2.5-flash';
    const config = parseConfig({
      githubToken: 'ghp_test',
      provider: 'gemini',
    });
    expect(config.model).toBe('gemini-2.5-flash');
    delete process.env.AI_MODEL;
  });

  it('reads model from MODEL environment or GitHub variable', () => {
    delete process.env.AI_MODEL;
    process.env.MODEL = 'gemini-2.5-pro';
    const config = parseConfig({
      githubToken: 'ghp_test',
      provider: 'gemini',
    });
    expect(config.model).toBe('gemini-2.5-pro');
    delete process.env.MODEL;
  });

  it('reads model from GEMINI_MODEL environment or GitHub variable', () => {
    delete process.env.AI_MODEL;
    delete process.env.MODEL;
    process.env.GEMINI_MODEL = 'gemini-2.5-flash-custom';
    const config = parseConfig({
      githubToken: 'ghp_test',
      provider: 'gemini',
    });
    expect(config.model).toBe('gemini-2.5-flash-custom');
    delete process.env.GEMINI_MODEL;
  });

  it('throws when github-token is missing', () => {
    expect(() =>
      parseConfig({
        githubToken: '',
        model: 'gemini-2.5-flash',
      })
    ).toThrow(/github-token is required/);
  });

  it('enforces ceiling on max-requests (max 1 in MVP)', () => {
    expect(() =>
      parseConfig({
        githubToken: 'token',
        model: 'gemini-2.5-flash',
        maxRequests: 2,
      })
    ).toThrow(/max-requests cannot exceed 1/);
  });

  it('enforces ceiling on max-files', () => {
    expect(() =>
      parseConfig({
        githubToken: 'token',
        model: 'gemini-2.5-flash',
        maxFiles: LIMIT_CEILINGS.MAX_FILES + 1,
      })
    ).toThrow(/maxFiles/);
  });

  it('rejects unsupported mode', () => {
    expect(() =>
      parseConfig({
        githubToken: 'token',
        model: 'gemini-2.5-flash',
        mode: 'approve' as any,
      })
    ).toThrow(/Only "comment" mode is supported/);
  });
});
