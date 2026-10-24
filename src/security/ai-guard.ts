import { CREDENTIAL_MARKERS } from './exclusions.js';

// Heuristic tripwires, not proof that arbitrary natural language is safe.
const INJECTION_PATTERNS = [
  /\b(?:ignore|disregard|forget|override)\b.{0,60}\b(?:previous|prior|system|developer|all)\b.{0,40}\b(?:instructions?|prompts?|rules?)\b/i,
  /\b(?:reveal|print|show|expose|repeat)\b.{0,50}\b(?:system prompt|developer message|api keys?|access tokens?|secrets?|credentials)\b/i,
  /\b(?:send|upload|exfiltrate)\b.{0,60}\b(?:secrets?|credentials|tokens?|environment variables)\b/i,
  /\b(?:you are now|act as|switch (?:your )?role to)\b/i,
  /\b(?:do not|don't|stop)\s+(?:review|reviewing)\b/i,
  /\b(?:write|compose|tell me)\s+(?:a |an )?(?:poem|joke|story|recipe)\b/i,
  /(?:<\/?(?:system|developer|assistant)>|\[INST\]|<\|(?:im_start|im_end|system|assistant)\|>)/i,
];

export function hasPromptInjection(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F]/g, ' ');
  return INJECTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isUnsafeReviewOutput(text: string): boolean {
  return hasPromptInjection(text) || CREDENTIAL_MARKERS.some((pattern) => pattern.test(text)) ||
    /\b(?:here is|here's)\s+(?:your |a |an )?(?:poem|joke|story|recipe)\b/i.test(text);
}

export function assertReviewOnlyInput(input: { language: string; files: ReadonlyArray<{ path: string; patch: string }> }): void {
  if (!/^[\p{L}\p{M} -]{1,64}$/u.test(input.language) || hasPromptInjection(input.language)) {
    throw new Error('ai_guard_invalid_language');
  }
  if (input.files.some((file) => hasPromptInjection(file.path + '\n' + file.patch))) {
    throw new Error('ai_guard_prompt_injection');
  }
}
