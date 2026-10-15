/**
 * Recomputing hunk headers.
 *
 * Like diff.ts this is free of any vscode import, so the whole algorithm can
 * be tested without launching an editor host.
 */

import {
  formatHeader,
  HUNK_RE,
  type Hunk,
  measureBody,
  parseHeader,
  resolveCounts,
  splitPatch,
  zeroSideWithLines,
} from './diff';

/** A single header line that disagrees with its body. */
export interface HeaderFix {
  /** Line index of the @@ header. */
  line: number;
  current: string;
  corrected: string;
}

/**
 * A header we will not rewrite, because the counts its body implies cannot be
 * written as a valid header.
 */
export interface RefusedHeader {
  /** Line index of the @@ header. */
  line: number;
  current: string;
  reason: string;
}

/** Every header in a document, sorted into those we can fix and those we must not touch. */
export interface HeaderCheck {
  fixes: HeaderFix[];
  refused: RefusedHeader[];
}

/**
 * Work out the correct header for every hunk in `lines`.
 *
 * Returns only the headers that need to change, so a caller can apply a
 * minimal edit and leave the user's cursor and undo history alone.
 */
export function computeFixes(lines: string[]): HeaderFix[] {
  return checkHeaders(lines).fixes;
}

/**
 * As computeFixes, but also report the headers we refused to rewrite.
 *
 * A range that starts at line 0 must be empty: the old side of a creation,
 * the new side of a deletion. resolveCounts already prefers a reading that
 * keeps it so; if none does, the body really has lines on that side, because
 * it was edited into something that is no longer a creation or deletion. The
 * right start is not ours to guess, so the header is left as it is and
 * reported, where writing it would have produced a patch git rejects only once
 * someone comes to apply it.
 */
export function checkHeaders(lines: string[]): HeaderCheck {
  const fixes: HeaderFix[] = [];
  const refused: RefusedHeader[] = [];

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
    const counts = resolveCounts(body, declared);

    const side = zeroSideWithLines(declared, counts);
    if (side !== undefined) {
      const count = side === 'old' ? counts.oldCount : counts.newCount;
      refused.push({
        line: i,
        current: lines[i],
        reason:
          `the body has ${count} ${side} line${count === 1 ? '' : 's'}, but the ${side} ` +
          'side starts at 0 and so must be empty; correct the header by hand',
      });
      // The header stays as written, and git will read it that way, so later
      // hunks in this file are numbered from what it declares.
      delta += declared.newCount - declared.oldCount;
      i = body.end;
      continue;
    }

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

    // A caller that split on '\n' alone leaves a CRLF file's CR on the end of
    // the header line, and HUNK_RE tolerates that rather than ignoring the
    // file. Put the CR back on the replacement: handing back a header without
    // one would leave the file with mixed line endings, which is a worse
    // outcome than the no-op it replaced. recountText never reaches this --
    // splitPatch hands it terminator-free lines.
    const carriageReturn = lines[i].endsWith('\r') ? '\r' : '';
    const corrected = formatHeader(hunk) + carriageReturn;
    if (corrected !== lines[i]) {
      fixes.push({ line: i, current: lines[i], corrected });
    }

    i = body.end;
  }

  return { fixes, refused };
}

/** Apply computeFixes to a whole document. */
export function recount(lines: string[]): string[] {
  const out = lines.slice();
  for (const fix of computeFixes(lines)) {
    out[fix.line] = fix.corrected;
  }
  return out;
}

/**
 * Recount a patch held as a single string, preserving its line endings.
 *
 * Each line is rejoined with the terminator it arrived with, so CRLF stays
 * CRLF, a file with no final newline still has none, and a header we correct
 * is the only thing that changes. Rejoining with one terminator chosen for the
 * whole file would be a silent rewrite of every other line.
 */
export function recountText(text: string): string {
  const { lines, endings } = splitPatch(text);
  const fixed = recount(lines);

  const out: string[] = [];
  for (let i = 0; i < fixed.length; i += 1) {
    out.push(fixed[i], endings[i]);
  }
  return out.join('');
}

/** True if the text contains at least one hunk header. */
export function looksLikeDiff(text: string): boolean {
  return splitPatch(text).lines.some((line) => HUNK_RE.test(line));
}
