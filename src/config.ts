import * as core from '@actions/core';
import { z } from 'zod';
import { Config } from './types.js';

// Upper validation ceilings to prevent accidental unbounded settings (ARCHITECTURE §7)
export const LIMIT_CEILINGS = {
  MAX_FILES: 100,
  MAX_FILE_BYTES: 100 * 1024, // 100 KiB
  MAX_INPUT_BYTES: 500 * 1024, // 500 KiB
  MAX_INPUT_TOKENS: 100000,
  MAX_OUTPUT_TOKENS: 8192,
  MAX_REQUESTS: 1, // Fixed ceiling of 1 in the MVP
  MAX_FINDINGS: 50,
} as const;

export const ConfigSchema = z.object({
  githubToken: z.string().min(1, 'github-token is required'),
  provider: z.string().min(1, 'provider is required'),
  model: z.string().min(
    1,
    'model must be explicitly specified (no silent substitution). Configure via "model" input or GitHub variable / env var (e.g. AI_MODEL, MODEL, GEMINI_MODEL)'
  ),
  providerApiKey: z.string().default(''),
  providerBaseUrl: z.string().default('http://127.0.0.1:11434'),
  allowExternalProvider: z.boolean().default(false),
  maxFiles: z.number().int().positive().max(LIMIT_CEILINGS.MAX_FILES),
  maxFileBytes: z.number().int().positive().max(LIMIT_CEILINGS.MAX_FILE_BYTES),
  maxInputBytes: z.number().int().positive().max(LIMIT_CEILINGS.MAX_INPUT_BYTES),
  maxInputTokens: z.number().int().positive().max(LIMIT_CEILINGS.MAX_INPUT_TOKENS),
  maxOutputTokens: z.number().int().positive().max(LIMIT_CEILINGS.MAX_OUTPUT_TOKENS),
  maxRequests: z.number().int().positive().max(LIMIT_CEILINGS.MAX_REQUESTS, 'max-requests cannot exceed 1 in MVP'),
  maxFindings: z.number().int().positive().max(LIMIT_CEILINGS.MAX_FINDINGS),
  reviewLanguage: z.string().min(1).default('English'),
  excludePatterns: z.array(z.string()).default([]),
  mode: z.literal('comment', {
    message: 'Only "comment" mode is supported (merge gating and approval are excluded)',
  }),
  staticReportPaths: z.array(z.string()).default([]),
  failOnError: z.boolean().default(false),
});

function parseSplitLines(raw: string): string[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseBooleanInput(raw: string | boolean | undefined, defaultValue: boolean): boolean {
  if (typeof raw === 'boolean') return raw;
  if (!raw) return defaultValue;
  const lower = raw.trim().toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return defaultValue;
}

function parseNumberInput(raw: string | number | undefined, defaultValue: number): number {
  if (typeof raw === 'number') return raw;
  if (!raw || !raw.trim()) return defaultValue;
  return /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
}

export function parseConfig(overrides?: Partial<Config>): Config {
  const githubToken = overrides?.githubToken ?? (core.getInput('github-token') || process.env.GITHUB_TOKEN || '');
  const provider = (overrides?.provider ?? (core.getInput('provider') || 'gemini')).trim().toLowerCase();
  const model = (
    overrides?.model ??
    (core.getInput('model') ||
      process.env.AI_MODEL ||
      process.env.MODEL ||
      process.env.GEMINI_MODEL ||
      process.env.VARS_AI_MODEL ||
      process.env.VARS_MODEL ||
      '')
  ).trim();
  const keyEnv: Record<string, string> = { gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', ollama: 'OLLAMA_API_KEY' };
  const providerApiKey = overrides?.providerApiKey ?? (core.getInput('provider-api-key') || process.env[keyEnv[provider] ?? 'AI_PROVIDER_API_KEY'] || '');
  const providerBaseUrl = overrides?.providerBaseUrl ?? (core.getInput('provider-base-url') || 'http://127.0.0.1:11434');

  const allowExternal = overrides?.allowExternalProvider !== undefined
    ? overrides.allowExternalProvider
    : parseBooleanInput(core.getInput('allow-external-provider'), false);

  const maxFiles = overrides?.maxFiles ?? parseNumberInput(core.getInput('max-files'), 20);
  const maxFileBytes = overrides?.maxFileBytes ?? parseNumberInput(core.getInput('max-file-bytes'), 20 * 1024);
  const maxInputBytes = overrides?.maxInputBytes ?? parseNumberInput(core.getInput('max-input-bytes'), 80 * 1024);
  const maxInputTokens = overrides?.maxInputTokens ?? parseNumberInput(core.getInput('max-input-tokens'), 24000);
  const maxOutputTokens = overrides?.maxOutputTokens ?? parseNumberInput(core.getInput('max-output-tokens'), 4000);
  const maxRequests = overrides?.maxRequests ?? parseNumberInput(core.getInput('max-requests'), 1);
  const maxFindings = overrides?.maxFindings ?? parseNumberInput(core.getInput('max-findings'), 10);

  const reviewLanguage = (overrides?.reviewLanguage ?? (core.getInput('review-language') || 'English')).trim();
  const modeRaw = (overrides?.mode ?? (core.getInput('mode') || 'comment')).trim();

  const excludePatterns = overrides?.excludePatterns ?? parseSplitLines(core.getInput('exclude-patterns'));
  const staticReportPaths = overrides?.staticReportPaths ?? parseSplitLines(core.getInput('static-report-paths'));
  const failOnError = overrides?.failOnError !== undefined
    ? overrides.failOnError
    : parseBooleanInput(core.getInput('fail-on-error'), false);

  // Mask sensitive values
  if (providerApiKey) {
    core.setSecret(providerApiKey);
  }
  if (githubToken) {
    core.setSecret(githubToken);
  }

  const rawConfig = {
    githubToken,
    provider,
    model,
    providerApiKey,
    providerBaseUrl,
    allowExternalProvider: allowExternal,
    maxFiles,
    maxFileBytes,
    maxInputBytes,
    maxInputTokens,
    maxOutputTokens,
    maxRequests,
    maxFindings,
    reviewLanguage,
    excludePatterns,
    mode: modeRaw,
    staticReportPaths,
    failOnError,
  };

  const parsed = ConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    const errorMessages = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid configuration: ${errorMessages}`);
  }

  return parsed.data as Config;
}
