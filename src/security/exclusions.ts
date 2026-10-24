import picomatch from 'picomatch';

// Mandatory secret patterns that CANNOT be overridden by user inclusion
export const MANDATORY_SECRET_PATTERNS = [
  '**/.env*',
  '**/*.env',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/id_ecdsa*',
  '**/id_dsa*',
  '**/*.kdbx',
  '**/credentials.json',
  '**/service-account*.json',
  '**/.aws/**',
  '**/.ssh/**',
  '**/secring.gpg',
  '**/.gnupg/**',
];

// Default excluded patterns for binaries, archives, vendor dirs, lockfiles
export const DEFAULT_EXCLUDED_PATTERNS = [
  ...MANDATORY_SECRET_PATTERNS,
  // Lockfiles (diffs are large and not relevant for manual logic review)
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/Gemfile.lock',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/composer.lock',
  '**/go.sum',
  // Vendor & build artifacts
  '**/node_modules/**',
  '**/vendor/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/target/**',
  '**/coverage/**',
  // Git & IDE internals
  '**/.git/**',
  '**/.idea/**',
  '**/.vscode/**',
  // Binaries, fonts, media, archives
  '**/*.png',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.gif',
  '**/*.ico',
  '**/*.svg',
  '**/*.webp',
  '**/*.avif',
  '**/*.mp4',
  '**/*.webm',
  '**/*.mov',
  '**/*.pdf',
  '**/*.zip',
  '**/*.tar',
  '**/*.gz',
  '**/*.tgz',
  '**/*.jar',
  '**/*.war',
  '**/*.wasm',
  '**/*.dylib',
  '**/*.so',
  '**/*.dll',
  '**/*.exe',
  '**/*.woff',
  '**/*.woff2',
  '**/*.ttf',
  '**/*.eot',
  // Minified files
  '**/*.min.js',
  '**/*.min.css',
];

// High-confidence credential marker regular expressions
export const CREDENTIAL_MARKERS: RegExp[] = [
  /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----/,
  /-----BEGIN OPENSSH PRIVATE KEY-----/,
  /-----BEGIN PGP PRIVATE KEY BLOCK-----/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS Access Key ID
  /\bghp_[0-9a-zA-Z]{36}\b/, // GitHub Personal Access Token
  /\bgho_[0-9a-zA-Z]{36}\b/, // GitHub OAuth Token
  /\bgithub_pat_[0-9a-zA-Z_]{82}\b/, // Fine-grained PAT
  /\bAIza[0-9A-Za-z\\-_]{35}\b/, // Google API key
  /\bxox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,32}\b/, // Slack Token
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
];

export interface ExclusionResult {
  excluded: boolean;
  reason?: 'mandatory_secret' | 'default_pattern' | 'user_pattern' | 'invalid_path' | 'credential_marker';
}

/**
 * Normalize repository file paths safely:
 * - Reject traversal (contains '..')
 * - Normalize slashes and trim leading slashes/current directory markers
 */
export function normalizeRepoPath(rawPath: string): string | null {
  if (!rawPath || typeof rawPath !== 'string') return null;
  const normalized = rawPath.replace(/\\/g, '/').trim();
  const segments = normalized.split('/').filter((s) => Boolean(s) && s !== '.');

  if (segments.some((s) => s === '..')) {
    return null; // Path traversal disallowed
  }

  const clean = segments.join('/');
  return clean.length > 0 ? clean : null;
}

export class PathExclusionFilter {
  private readonly isMandatorySecret: (path: string) => boolean;
  private readonly isDefaultExcluded: (path: string) => boolean;
  private readonly isUserExcluded?: (path: string) => boolean;

  constructor(userPatterns: string[] = []) {
    this.isMandatorySecret = picomatch(MANDATORY_SECRET_PATTERNS, { dot: true });
    this.isDefaultExcluded = picomatch(DEFAULT_EXCLUDED_PATTERNS, { dot: true });

    if (userPatterns.length > 0) {
      this.isUserExcluded = picomatch(userPatterns, { dot: true });
    }
  }

  /**
   * Evaluates path against exclusion rules.
   */
  public testPath(rawPath: string): ExclusionResult {
    const cleanPath = normalizeRepoPath(rawPath);
    if (!cleanPath) {
      return { excluded: true, reason: 'invalid_path' };
    }

    if (this.isMandatorySecret(cleanPath)) {
      return { excluded: true, reason: 'mandatory_secret' };
    }

    if (this.isUserExcluded && this.isUserExcluded(cleanPath)) {
      return { excluded: true, reason: 'user_pattern' };
    }

    if (this.isDefaultExcluded(cleanPath)) {
      return { excluded: true, reason: 'default_pattern' };
    }

    return { excluded: false };
  }

  /**
   * Defense-in-depth screen for high confidence credential markers within a patch.
   */
  public testPatchContent(patch: string): { hasMarker: boolean; markerFound?: string } {
    if (!patch) return { hasMarker: false };
    for (const marker of CREDENTIAL_MARKERS) {
      const match = patch.match(marker);
      if (match) {
        return { hasMarker: true, markerFound: marker.source };
      }
    }
    return { hasMarker: false };
  }
}
