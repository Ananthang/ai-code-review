import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIMIT_CEILINGS, parseConfig, resolveCustomInstructions } from '../src/config.js';

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
    expect(config.maxFindings).toBe(5);
    expect(config.allowExternalProvider).toBe(false);
    expect(config.mode).toBe('comment');
    expect(config.thinkingLevel).toBe('low');
    expect(config.fallbackModel).toBe('');
  });

  it('parses explicit fallback-model when provided', () => {
    const config = parseConfig({
      githubToken: 'ghp_fake_token',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      fallbackModel: 'gemini-2.5-flash-lite',
    });
    expect(config.fallbackModel).toBe('gemini-2.5-flash-lite');
    expect(config.maxRequests).toBe(1);
  });

  it('parses upgrade-notice override and environment variable', () => {
    const config = parseConfig({
      githubToken: 'ghp_fake_token',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      upgradeNotice: 'Version 2.0 released',
    });
    expect(config.upgradeNotice).toBe('Version 2.0 released');

    process.env.AI_UPGRADE_NOTICE = 'Env upgrade alert';
    const configEnv = parseConfig({
      githubToken: 'ghp_fake_token',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
    });
    expect(configEnv.upgradeNotice).toBe('Env upgrade alert');
    delete process.env.AI_UPGRADE_NOTICE;
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

  it('enforces ceiling on max-requests (maximum 2)', () => {
    expect(() =>
      parseConfig({
        githubToken: 'token',
        model: 'gemini-2.5-flash',
        maxRequests: 3,
      })
    ).toThrow(/max-requests cannot exceed 2/);
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

  describe('Custom instructions resolution', () => {
    it('returns direct raw text when inline string is provided', () => {
      const instructions = resolveCustomInstructions('- Ensure all DB queries are parameterized');
      expect(instructions).toBe('- Ensure all DB queries are parameterized');
    });

    it('returns direct raw text for multiline instructions', () => {
      const multiline = `- Check for XSS\n- Check for SQL injection\n- Flag console.log`;
      const instructions = resolveCustomInstructions(multiline);
      expect(instructions).toBe(multiline);
    });

    it('loads custom instructions from a project file outside .github', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-test-'));
      const rulesDir = path.join(tmpDir, 'docs', 'rules');
      fs.mkdirSync(rulesDir, { recursive: true });
      const ruleFilePath = path.join(rulesDir, 'team-standards.md');
      fs.writeFileSync(ruleFilePath, 'Enforce strict schema validation on all API endpoints');

      const instructions = resolveCustomInstructions('docs/rules/team-standards.md', tmpDir);
      expect(instructions).toBe('Enforce strict schema validation on all API endpoints');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('auto-detects .github/ai-review.md when no explicit input is provided', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-test-'));
      const ghDir = path.join(tmpDir, '.github');
      fs.mkdirSync(ghDir, { recursive: true });
      fs.writeFileSync(path.join(ghDir, 'ai-review.md'), 'Default repository review rules');

      const instructions = resolveCustomInstructions('', tmpDir);
      expect(instructions).toBe('Default repository review rules');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('rejects directory traversal attempts outside the workspace', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-test-'));
      const outsideFile = path.join(os.tmpdir(), 'outside-secret.txt');
      fs.writeFileSync(outsideFile, 'secret-data');

      // Attempting to read outside workspace via relative path
      const instructions = resolveCustomInstructions('../outside-secret.txt', tmpDir);
      // Because it escapes workspace, it should not read the file contents, treating it as raw text
      expect(instructions).toBe('../outside-secret.txt');

      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(outsideFile, { force: true });
    });

    it('loads custom instructions from multiple project files line-by-line or comma-separated', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-test-'));
      fs.mkdirSync(path.join(tmpDir, 'rules'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'rules', 'sec.md'), 'Rule 1: No SQLi');
      fs.writeFileSync(path.join(tmpDir, 'rules', 'style.md'), 'Rule 2: No any');

      // 1. Line-by-line
      const lineInput = `rules/sec.md\nrules/style.md`;
      const combinedLine = resolveCustomInstructions(lineInput, tmpDir);
      expect(combinedLine).toContain('### Guidelines from rules/sec.md:\nRule 1: No SQLi');
      expect(combinedLine).toContain('### Guidelines from rules/style.md:\nRule 2: No any');

      // 2. Comma-separated
      const commaInput = `rules/sec.md, rules/style.md`;
      const combinedComma = resolveCustomInstructions(commaInput, tmpDir);
      expect(combinedComma).toContain('### Guidelines from rules/sec.md:\nRule 1: No SQLi');
      expect(combinedComma).toContain('### Guidelines from rules/style.md:\nRule 2: No any');

      // 3. Mixed files and inline bullet points
      const mixedInput = `rules/sec.md\n- Flag console.log in API routes`;
      const combinedMixed = resolveCustomInstructions(mixedInput, tmpDir);
      expect(combinedMixed).toContain('### Guidelines from rules/sec.md:\nRule 1: No SQLi');
      expect(combinedMixed).toContain('- Flag console.log in API routes');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns undefined when explicitly disabled with none or off', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-test-'));
      const ghDir = path.join(tmpDir, '.github');
      fs.mkdirSync(ghDir, { recursive: true });
      fs.writeFileSync(path.join(ghDir, 'ai-review.md'), 'Default rules');

      expect(resolveCustomInstructions('none', tmpDir)).toBeUndefined();
      expect(resolveCustomInstructions('off', tmpDir)).toBeUndefined();

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});

describe('Instruction file boundaries', () => {
  it('rejects sibling-prefix escapes and symlinks for explicit and default files', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'review-boundary-'));
    try {
      const root = path.join(base, 'repo');
      const outside = path.join(base, 'repo-private');
      fs.mkdirSync(path.join(root, '.github'), { recursive: true });
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'rules.md'), 'OUTSIDE_SENTINEL');
      expect(resolveCustomInstructions('../repo-private/rules.md', root)).not.toContain('OUTSIDE_SENTINEL');
      fs.symlinkSync(path.join(outside, 'rules.md'), path.join(root, 'linked.md'));
      expect(resolveCustomInstructions('linked.md', root)).not.toContain('OUTSIDE_SENTINEL');
      fs.symlinkSync(path.join(outside, 'rules.md'), path.join(root, '.github/ai-review.md'));
      expect(resolveCustomInstructions('', root)).toBeUndefined();
      fs.symlinkSync(outside, path.join(root, 'linked-directory'));
      expect(resolveCustomInstructions('linked-directory/rules.md', root)).not.toContain('OUTSIDE_SENTINEL');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});
