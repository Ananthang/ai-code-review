import { describe, expect, it } from 'vitest';
import { normalizeRepoPath, PathExclusionFilter } from '../src/security/exclusions.js';
import { PATCH_WITH_SECRET } from './fixtures/patches.js';

describe('Exclusions & security screening', () => {
  it('normalizes safe paths and rejects path traversal', () => {
    expect(normalizeRepoPath('src/index.ts')).toBe('src/index.ts');
    expect(normalizeRepoPath('./src/utils/math.ts')).toBe('src/utils/math.ts');
    expect(normalizeRepoPath('src\\windows\\path.ts')).toBe('src/windows/path.ts');
    expect(normalizeRepoPath('../outside.ts')).toBeNull();
    expect(normalizeRepoPath('src/../../etc/passwd')).toBeNull();
  });

  it('excludes mandatory secret patterns unconditionally', () => {
    const filter = new PathExclusionFilter();

    expect(filter.testPath('.env').excluded).toBe(true);
    expect(filter.testPath('.env.production').excluded).toBe(true);
    expect(filter.testPath('config/.env.local').excluded).toBe(true);
    expect(filter.testPath('certs/server.key').excluded).toBe(true);
    expect(filter.testPath('.ssh/id_rsa').excluded).toBe(true);
    expect(filter.testPath('.aws/credentials').excluded).toBe(true);
    expect(filter.testPath('config/credentials.json').excluded).toBe(true);
  });

  it('user exclusion cannot re-include mandatory secret patterns', () => {
    // Even if user specifies patterns or try to override, mandatory patterns stay excluded
    const filter = new PathExclusionFilter(['!**/.env']);
    expect(filter.testPath('.env').excluded).toBe(true);
    expect(filter.testPath('.env').reason).toBe('mandatory_secret');
  });

  it('excludes default binary, archive, lockfile, and vendor patterns', () => {
    const filter = new PathExclusionFilter();

    expect(filter.testPath('package-lock.json').excluded).toBe(true);
    expect(filter.testPath('yarn.lock').excluded).toBe(true);
    expect(filter.testPath('Gemfile.lock').excluded).toBe(true);
    expect(filter.testPath('node_modules/package/index.js').excluded).toBe(true);
    expect(filter.testPath('dist/bundle.js').excluded).toBe(true);
    expect(filter.testPath('public/avatar.png').excluded).toBe(true);
    expect(filter.testPath('assets/archive.tar.gz').excluded).toBe(true);
    expect(filter.testPath('lib/app.wasm').excluded).toBe(true);
  });

  it('supports custom user exclusion patterns', () => {
    const filter = new PathExclusionFilter(['docs/**', '**/*.generated.ts']);

    expect(filter.testPath('docs/guide.md').excluded).toBe(true);
    expect(filter.testPath('src/api.generated.ts').excluded).toBe(true);
    expect(filter.testPath('src/main.ts').excluded).toBe(false);
  });

  it('screens patches for high-confidence credential markers', () => {
    const filter = new PathExclusionFilter();

    const cleanResult = filter.testPatchContent('export const a = 1;');
    expect(cleanResult.hasMarker).toBe(false);

    const secretResult = filter.testPatchContent(PATCH_WITH_SECRET);
    expect(secretResult.hasMarker).toBe(true);

    const sshKeyResult = filter.testPatchContent('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----');
    expect(sshKeyResult.hasMarker).toBe(true);

    const tokenResult = filter.testPatchContent('const token = "ghp_123456789012345678901234567890123456";');
    expect(tokenResult.hasMarker).toBe(true);
  });
});
