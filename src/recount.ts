/**
 * Recomputing hunk headers.
 *
 * Like diff.ts this is free of any vscode import, so the whole algorithm can
 * be tested without launching an editor host.
 */

import {
  type BodyCounts,
  type Counts,
  disownsBlanks,
  formatHeader,
  HUNK_RE,
  type Hunk,
  hunkSites,
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
 * someone comes to apply it. refusal() has the other headers we will not write.
 */
export function checkHeaders(lines: string[]): HeaderCheck {
  const fixes: HeaderFix[] = [];
  const refused: RefusedHeader[] = [];

  // Running difference between old-side and new-side line numbering. It
  // accumulates across the hunks of one file and resets at each new file.
  let delta = 0;

  for (const { line: i, declared, body, firstInFile } of hunkSites(lines)) {
    if (firstInFile) {
      delta = 0;
    }
    const counts = resolveCounts(body, declared);

    // An empty range is written as the line before it, so an empty side moves
    // the other side's start by one: creation's -0,0 +1,N, deletion's
    // -1,N +0,0, and anywhere in a patch made with -U0, such as -3,0 +4,2.
    const afterEmptyOld = counts.oldCount === 0 ? 1 : 0;
    const beforeEmptyNew = counts.newCount === 0 ? 1 : 0;
    const newStart = declared.oldStart + delta + afterEmptyOld - beforeEmptyNew;

    const reason = refusal(declared, body, counts, newStart);
    if (reason !== undefined) {
      refused.push({ line: i, current: lines[i], reason });
      // The header stays as written, and git will read it that way, so later
      // hunks in this file are numbered from what it declares.
      delta += declared.newCount - declared.oldCount;
      continue;
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
  }

  return { fixes, refused };
}

/**
 * Why the header for these counts cannot be written, if it cannot.
 *
 * The computed start is checked as well as the declared one. Hunks out of
 * order -- which git diff never writes, but a patch assembled by hand can
 * hold -- leave the running offset meaningless, and the start it gives can
 * fall before the first line. For a hunk with an empty old side that would be
 * placed silently at the top of the file, where a header git rejects outright
 * is the better outcome; refusing is better still.
 *
 * A blank line between a hunk that disowns it and the next hunk belongs to
 * neither. Counted in, git places the hunk by it alone; left out, git rejects
 * the patch, and GNU patch skips every later hunk of the file without a word.
 * No header makes that right, so the blank is reported instead.
 */
function refusal(
  declared: Hunk,
  body: BodyCounts,
  counts: Counts,
  newStart: number,
): string | undefined {
  if (body.blankBeforeHunk && disownsBlanks(body, declared)) {
    return (
      'the blank line before the next hunk belongs to neither, and this hunk has no ' +
      'context to place it by; delete the blank line'
    );
  }
  const side = zeroSideWithLines(declared, counts);
  if (side !== undefined) {
    const count = side === 'old' ? counts.oldCount : counts.newCount;
    return (
      `the body has ${count} ${side} line${count === 1 ? '' : 's'}, but the ${side} ` +
      'side starts at 0 and so must be empty; correct the header by hand'
    );
  }
  if (counts.oldCount === 0 && counts.newCount === 0) {
    return 'the hunk has no lines on either side; remove it or correct it by hand';
  }
  if (newStart < 0 || (newStart === 0 && counts.newCount !== 0)) {
    return (
      `its new side would start at ${newStart}, before the first line, which an earlier ` +
      'hunk out of order can cause; correct the header by hand'
    );
  }
  return undefined;
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
