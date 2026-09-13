/**
 * Recomputing hunk headers.
 *
 * Like diff.ts this is free of any vscode import, so the whole algorithm can
 * be tested without launching an editor host.
 */

import { formatHeader, HUNK_RE, type Hunk, measureBody, parseHeader, resolveCounts } from './diff';

/** A single header line that disagrees with its body. */
export interface HeaderFix {
  /** Line index of the @@ header. */
  line: number;
  current: string;
  corrected: string;
}

/**
 * Work out the correct header for every hunk in `lines`.
 *
 * Returns only the headers that need to change, so a caller can apply a
 * minimal edit and leave the user's cursor and undo history alone.
 */
export function computeFixes(lines: string[]): HeaderFix[] {
  const fixes: HeaderFix[] = [];

  // Running difference between old-side and new-side line numbering. It
  // accumulates across the hunks of one file and resets at each new file.
  let delta = 0;
  let i = 0;

  while (i < lines.length) {
    const declared = parseHeader(lines[i]);
    if (!declared) {
      if (lines[i].startsWith('--- ')) {
        delta = 0;
      }
      i += 1;
      continue;
    }

    const body = measureBody(lines, i + 1);
    const counts = resolveCounts(body, declared.oldCount, declared.newCount);

    let newStart = declared.oldStart + delta;
    if (counts.newCount === 0) {
      // Deleting a file: the new side is empty and starts at 0.
      newStart = 0;
    } else if (newStart === 0) {
      // Creating a file: -0,0 +1,N.
      newStart = 1;
    }
    delta += counts.newCount - counts.oldCount;

    const hunk: Hunk = {
      headerLine: i,
      bodyStart: i + 1,
      bodyEnd: body.end,
      oldStart: declared.oldStart,
      oldCount: counts.oldCount,
      newStart,
      newCount: counts.newCount,
      heading: declared.heading,
    };

    const corrected = formatHeader(hunk);
    if (corrected !== lines[i]) {
      fixes.push({ line: i, current: lines[i], corrected });
    }

    i = body.end;
  }

  return fixes;
}

/** Apply computeFixes to a whole document. */
export function recount(lines: string[]): string[] {
  const out = lines.slice();
  for (const fix of computeFixes(lines)) {
    out[fix.line] = fix.corrected;
  }
  return out;
}

/** Recount a patch held as a single string, preserving its trailing newline. */
export function recountText(text: string): string {
  const trailingNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (trailingNewline) {
    // split leaves a phantom empty element after the final newline, which
    // would otherwise count as a context line.
    lines.pop();
  }
  return recount(lines).join('\n') + (trailingNewline ? '\n' : '');
}

/** True if the text contains at least one hunk header. */
export function looksLikeDiff(text: string): boolean {
  return text.split('\n').some((line) => HUNK_RE.test(line));
}
