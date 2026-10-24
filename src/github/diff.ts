import { ParsedPatchFile } from '../types.js';

/**
 * Parses unified diff patch string into added lines map and structural metrics.
 *
 * Rules:
 * - Hunk headers format: @@ -oldStart[,oldCount] +newStart[,newCount] @@ [optional title]
 * - ' ' (context): advances both old and new line numbers
 * - '+' (addition): advances new line number, recorded as an added line eligible for review comments
 * - '-' (deletion): advances old line number
 * - '\' (e.g. '\ No newline at end of file'): does not advance line numbers
 */
export function parseUnifiedPatch(
  filePath: string,
  patch: string,
  status: ParsedPatchFile['status'] = 'modified',
  previousPath?: string
): { success: boolean; parsed?: ParsedPatchFile; error?: string } {
  if (!patch || typeof patch !== 'string') {
    return { success: false, error: 'Empty or missing patch' };
  }

  const lines = patch.replace(/\n$/, '').split('\n');
  const addedLines = new Set<number>();
  let hunkCount = 0;

  let inHunk = false;
  let currentNewStart = 0;
  let currentNewCount = 0;
  let currentOldStart = 0;
  let currentOldCount = 0;
  let hunkOldProcessed = 0;
  let hunkNewProcessed = 0;
  let currentNewLineNum = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('@@ ')) {
      // If we were in a hunk, verify hunk reconciliation
      if (inHunk && (hunkNewProcessed !== currentNewCount || hunkOldProcessed !== currentOldCount)) {
        return {
          success: false,
          error: `Hunk new line count mismatch: expected ${currentNewCount}, got ${hunkNewProcessed}`,
        };
      }

      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) {
        return { success: false, error: `Malformed hunk header: ${line}` };
      }

      hunkCount++;
      inHunk = true;
      currentOldStart = parseInt(match[1], 10);
      currentOldCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
      currentNewStart = parseInt(match[3], 10);
      currentNewCount = match[4] !== undefined ? parseInt(match[4], 10) : 1;

      currentNewLineNum = currentNewStart;
      hunkOldProcessed = 0;
      hunkNewProcessed = 0;
      continue;
    }

    if (!inHunk) {
      // File header lines (diff --git, index, ---, +++) before first hunk
      continue;
    }

    if (line.startsWith('+')) {
      addedLines.add(currentNewLineNum);
      currentNewLineNum++;
      hunkNewProcessed++;
    } else if (line.startsWith('-')) {
      hunkOldProcessed++;
    } else if (line.startsWith(' ')) {
      currentNewLineNum++;
      hunkNewProcessed++;
      hunkOldProcessed++;
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file"
      continue;
    } else {
      return { success: false, error: 'Invalid hunk line prefix' };
    }
  }

  if (inHunk && (hunkNewProcessed !== currentNewCount || hunkOldProcessed !== currentOldCount)) {
    return {
      success: false,
      error: `Final hunk new line count mismatch: expected ${currentNewCount}, got ${hunkNewProcessed}`,
    };
  }

  if (hunkCount === 0) {
    return { success: false, error: 'No hunks found in patch' };
  }

  const byteLength = Buffer.byteLength(patch, 'utf8');

  return {
    success: true,
    parsed: {
      path: filePath,
      status,
      previousPath,
      patch,
      addedLines,
      hunkCount,
      byteLength,
    },
  };
}
