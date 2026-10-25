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
  MAX_REQUESTS: 2, // One primary request and one explicitly budgeted fallback
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
  maxRequests: z.number().int().positive().max(LIMIT_CEILINGS.MAX_REQUESTS, 'max-requests cannot exceed 2'),
  maxFindings: z.number().int().positive().max(LIMIT_CEILINGS.MAX_FINDINGS),
  reviewLanguage: z.string().min(1).default('English'),
  excludePatterns: z.array(z.string()).default([]),
  mode: z.literal('comment', {
    message: 'Only "comment" mode is supported (merge gating and approval are excluded)',
  }),
  staticReportPaths: z.array(z.string()).default([]),
  failOnError: z.boolean().default(false),
  thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).default('low'),
  customInstructions: z.string().optional(),
  fallbackModel: z.string().default(''),
  incremental: z.boolean().default(true),
  maxContextBytes: z.number().int().min(0).max(8192).default(2048),
  minSeverity: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
  requireEvidence: z.boolean().default(true),
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

function tryReadFile(filePath: string, workspaceRoot: string): string | undefined {
  if (filePath.length >= 260) return undefined;
  try {
    const root = path.resolve(workspaceRoot);
    const realRoot = fs.realpathSync(root);
    const requested = path.resolve(root, filePath);
    const withinRoot = (candidate: string, base = root) => {
      const relative = path.relative(base, candidate);
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    if (!withinRoot(requested)) return undefined;
    const resolved = fs.realpathSync(requested);
    if (!withinRoot(resolved, realRoot)) return undefined;
    // Use the resolved target and reject final-component symlink swaps.
    const fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 64 * 1024) return undefined;
      return fs.readFileSync(fd, 'utf8').trim();
    } finally { fs.closeSync(fd); }
  } catch { return undefined; }
  return undefined;
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
    const lines = input.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

    // Expand comma-separated file paths if present on a line (e.g. "docs/a.md, docs/b.md")
    const candidates: string[] = [];
    for (const line of lines) {
      if (line.includes(',') && !line.startsWith('-') && !line.startsWith('*') && !line.startsWith('#')) {
        const parts = line.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
        if (parts.some((p) => tryReadFile(p, workspaceRoot) !== undefined)) {
          candidates.push(...parts);
          continue;
        }
      }
      candidates.push(line);
    }

    const loadedSections: Array<{ label?: string; content: string }> = [];
    const inlineLines: string[] = [];

    for (const item of candidates) {
      const fileContent = tryReadFile(item, workspaceRoot);
      if (fileContent !== undefined) {
        if (inlineLines.length > 0) {
          loadedSections.push({ content: inlineLines.join('\n') });
          inlineLines.length = 0;
        }
        core.info(`Loaded custom review instructions from file: ${item}`);
        loadedSections.push({ label: item, content: fileContent });
      } else {
        if (item.endsWith('.md') || item.endsWith('.txt')) {
          core.warning(`Custom instructions file not found at "${item}". Treating input as raw text.`);
        }
        inlineLines.push(item);
      }
    }

    if (inlineLines.length > 0) {
      loadedSections.push({ content: inlineLines.join('\n') });
    }

    if (loadedSections.length === 1) {
      return loadedSections[0].content.slice(0, 16384);
    }

    if (loadedSections.length > 1) {
      const combined = loadedSections
        .map((s) => (s.label ? `### Guidelines from ${s.label}:\n${s.content}` : s.content))
        .join('\n\n');
      return combined.slice(0, 16384); // Bound to 16 KiB
    }

    return input.slice(0, 16384);
  }

  // 2. If no explicit input was provided, auto-detect default convention files in the repository:
  const defaultFileCandidates = [
    path.join(workspaceRoot, '.github', 'ai-review.md'),
    path.join(workspaceRoot, '.github', 'review-instructions.md'),
    path.join(workspaceRoot, '.github', 'ai-review.txt'),
  ];

  for (const candidate of defaultFileCandidates) {
    const content = tryReadFile(candidate, workspaceRoot);
    if (content !== undefined) {
      const rel = path.relative(workspaceRoot, candidate);
      core.info(`Loaded custom review instructions from repository file: ${rel}`);
      return content.slice(0, 16384);
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

  const fallbackModel = (
    overrides?.fallbackModel ??
    (core.getInput('fallback-model') ||
      process.env.AI_FALLBACK_MODEL ||
      process.env.FALLBACK_MODEL ||
      process.env.GEMINI_FALLBACK_MODEL ||
      '')
  ).trim();

  const maxFiles = overrides?.maxFiles ?? parseNumberInput(core.getInput('max-files'), 20);
  const maxFileBytes = overrides?.maxFileBytes ?? parseNumberInput(core.getInput('max-file-bytes'), 20 * 1024);
  const maxInputBytes = overrides?.maxInputBytes ?? parseNumberInput(core.getInput('max-input-bytes'), 80 * 1024);
  const maxInputTokens = overrides?.maxInputTokens ?? parseNumberInput(core.getInput('max-input-tokens'), 12000);
  const maxOutputTokens = overrides?.maxOutputTokens ?? parseNumberInput(core.getInput('max-output-tokens'), 2000);
  const maxRequestsDefault = 1;
  const maxRequests = overrides?.maxRequests ?? parseNumberInput(core.getInput('max-requests'), maxRequestsDefault);
  const maxFindings = overrides?.maxFindings ?? parseNumberInput(core.getInput('max-findings'), 5);

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
      'low')
  ).trim().toLowerCase();

  const thinkingLevel = ['minimal', 'low', 'medium', 'high'].includes(rawThinkingLevel)
    ? (rawThinkingLevel as 'minimal' | 'low' | 'medium' | 'high')
    : 'low';

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
    fallbackModel,
    incremental: overrides?.incremental ?? parseBooleanInput(core.getInput('incremental'), true),
    maxContextBytes: overrides?.maxContextBytes ?? parseNumberInput(core.getInput('max-context-bytes'), 2048),
    minSeverity: overrides?.minSeverity ?? (core.getInput('min-severity') || 'medium'),
    requireEvidence: overrides?.requireEvidence ?? parseBooleanInput(core.getInput('require-evidence'), true),
  };

  const parsed = ConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    const errorMessages = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid configuration: ${errorMessages}`);
  }

  return parsed.data as Config;
}
