import fs from 'node:fs';
import path from 'node:path';
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
  thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).default('medium'),
  customInstructions: z.string().optional(),
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

export function resolveCustomInstructions(
  rawInput?: string,
  workspaceRoot: string = process.env.GITHUB_WORKSPACE ? path.resolve(process.env.GITHUB_WORKSPACE) : process.cwd()
): string | undefined {
  const input = rawInput?.trim();

  // Explicit opt-out via configuration
  if (input && (input.toLowerCase() === 'none' || input.toLowerCase() === 'off')) {
    return undefined;
  }

  // 1. If explicit input was provided:
  if (input) {
    // Check if input looks like a potential relative/workspace file path (single line, no newlines, reasonable length)
    if (!input.includes('\n') && input.length < 260) {
      const resolvedPath = path.resolve(workspaceRoot, input);
      // Ensure path stays within workspace boundaries for security
      if (resolvedPath.startsWith(workspaceRoot) && fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
        try {
          const content = fs.readFileSync(resolvedPath, 'utf8').trim();
          core.info(`Loaded custom review instructions from file: ${input}`);
          return content.slice(0, 8192); // Bound to 8 KiB
        } catch {
          core.warning(`Failed reading custom instructions file: ${input}`);
        }
      } else if (input.endsWith('.md') || input.endsWith('.txt')) {
        core.warning(`Custom instructions file not found at "${input}". Treating input as raw text.`);
      }
    }
    // Return direct raw text instructions (capped at 8 KiB)
    return input.slice(0, 8192);
  }

  // 2. If no explicit input was provided, auto-detect default convention files in the repository:
  const defaultFileCandidates = [
    path.join(workspaceRoot, '.github', 'ai-review.md'),
    path.join(workspaceRoot, '.github', 'review-instructions.md'),
    path.join(workspaceRoot, '.github', 'ai-review.txt'),
  ];

  for (const candidate of defaultFileCandidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      try {
        const content = fs.readFileSync(candidate, 'utf8').trim();
        const rel = path.relative(workspaceRoot, candidate);
        core.info(`Loaded custom review instructions from repository file: ${rel}`);
        return content.slice(0, 8192);
      } catch {
        // Fallback to next candidate
      }
    }
  }

  return undefined;
}

export function parseConfig(overrides?: Partial<Config>, workspaceRoot?: string): Config {
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
  const rawThinkingLevel = (
    overrides?.thinkingLevel ??
    (core.getInput('thinking-level') ||
      core.getInput('thinking-effort') ||
      core.getInput('effort') ||
      'medium')
  ).trim().toLowerCase();

  const thinkingLevel = ['minimal', 'low', 'medium', 'high'].includes(rawThinkingLevel)
    ? (rawThinkingLevel as 'minimal' | 'low' | 'medium' | 'high')
    : 'medium';

  const rawCustomInstructions = overrides?.customInstructions !== undefined
    ? overrides.customInstructions
    : core.getInput('custom-instructions');
  const customInstructions = resolveCustomInstructions(rawCustomInstructions, workspaceRoot);

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
    thinkingLevel,
    customInstructions,
  };

  const parsed = ConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    const errorMessages = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid configuration: ${errorMessages}`);
  }

  return parsed.data as Config;
}
