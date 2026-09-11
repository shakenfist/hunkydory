/**
 * Parsing and counting rules for unified diffs.
 *
 * This module is deliberately free of any vscode import so that it can be
 * exercised by a plain node test runner.
 */

export const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Lines that end a hunk body even though they may start with a diff marker. */
const FILE_START = ['--- ', 'diff --git ', 'index ', 'Index: '];

/** git format-patch ends a diff with "-- " followed by the git version. */
const VERSION_RE = /^\d+\.\d/;

export interface Hunk {
  /** Index into the document's line array of the @@ line itself. */
  headerLine: number;
  /** First line of the body, and one past its last line. */
  bodyStart: number;
  bodyEnd: number;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Everything after the closing @@, which git uses for a function hint. */
  heading: string;
}

/**
 * Render one side of a hunk header.
 *
 * Unified diff elides a count of exactly 1, so `-1,1` is written `-1`.
 */
export function formatRange(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

export function formatHeader(hunk: Hunk): string {
  return (
    `@@ -${formatRange(hunk.oldStart, hunk.oldCount)}` +
    ` +${formatRange(hunk.newStart, hunk.newCount)} @@${hunk.heading}`
  );
}

function isSignature(lines: string[], i: number): boolean {
  return lines[i] === '-- ' && i + 1 < lines.length && VERSION_RE.test(lines[i + 1]);
}

function startsFile(line: string): boolean {
  return FILE_START.some((p) => line.startsWith(p));
}

/**
 * Counts for a hunk body, expressed as a function of how many trailing
 * whitespace-only lines are treated as falling outside the hunk.
 *
 * Index 0 is "count every line"; index k is "ignore the last k blank lines".
 * See resolveCounts for why more than one answer exists.
 */
export interface BodyCounts {
  end: number;
  byTrailingBlanks: Array<{ oldCount: number; newCount: number }>;
}

/** Find where the hunk body starting at `start` ends, and count its lines. */
export function measureBody(lines: string[], start: number): BodyCounts {
  let i = start;
  let oldCount = 0;
  let newCount = 0;
  const perLine: Array<{ line: string; old: number; nw: number }> = [];

  while (i < lines.length) {
    const line = lines[i];
    if (isSignature(lines, i) || HUNK_RE.test(line) || startsFile(line)) {
      break;
    }
    if (line.startsWith('\\')) {
      // "\ No newline at end of file" annotates the previous line and counts
      // on neither side.
      i += 1;
      continue;
    }
    const marker = line.charAt(0);
    if (marker === '-') {
      oldCount += 1;
      perLine.push({ line, old: 1, nw: 0 });
    } else if (marker === '+') {
      newCount += 1;
      perLine.push({ line, old: 0, nw: 1 });
    } else if (marker === ' ' || line === '') {
      // Context. A bare empty line is a context line whose single leading
      // space was stripped, which some editors and mail paths do.
      oldCount += 1;
      newCount += 1;
      perLine.push({ line, old: 1, nw: 1 });
    } else {
      // Prose after the final hunk, such as a commit trailer.
      break;
    }
    i += 1;
  }

  const byTrailingBlanks = [{ oldCount, newCount }];
  let o = oldCount;
  let n = newCount;
  for (let k = perLine.length - 1; k >= 0; k -= 1) {
    const entry = perLine[k];
    if (entry.line.trim() !== '') {
      break;
    }
    o -= entry.old;
    n -= entry.nw;
    byTrailingBlanks.push({ oldCount: o, newCount: n });
  }

  return { end: i, byTrailingBlanks };
}

/**
 * Decide how many trailing whitespace-only lines fall outside the hunk.
 *
 * This is the one genuinely ambiguous part of recounting. git reads a hunk by
 * consuming exactly as many lines as the header declares and ignoring whatever
 * follows, so a blank line between the last real body line and the next
 * `diff --git` may or may not belong to the hunk. The body alone cannot say.
 *
 * We break the tie with the header we were given: if ignoring k trailing
 * blanks makes both sides agree with the declared counts, that was the
 * author's intent and we preserve it. After a body edit no interpretation
 * matches and we fall back to counting every line, which is the safe
 * direction: an over-large count makes git reject the patch loudly, while an
 * under-large one makes it silently truncate the hunk.
 */
export function resolveCounts(
  counts: BodyCounts,
  declaredOld: number,
  declaredNew: number
): { oldCount: number; newCount: number } {
  for (const candidate of counts.byTrailingBlanks) {
    if (candidate.oldCount === declaredOld && candidate.newCount === declaredNew) {
      return candidate;
    }
  }
  return counts.byTrailingBlanks[0];
}

/** Parse every hunk in a document, in order. */
export function parseHunks(lines: string[]): Hunk[] {
  const hunks: Hunk[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = HUNK_RE.exec(lines[i]);
    if (!match) {
      continue;
    }
    const declaredOld = match[2] === undefined ? 1 : parseInt(match[2], 10);
    const declaredNew = match[4] === undefined ? 1 : parseInt(match[4], 10);
    const body = measureBody(lines, i + 1);
    const resolved = resolveCounts(body, declaredOld, declaredNew);
    hunks.push({
      headerLine: i,
      bodyStart: i + 1,
      bodyEnd: body.end,
      oldStart: parseInt(match[1], 10),
      oldCount: resolved.oldCount,
      newStart: parseInt(match[3], 10),
      newCount: resolved.newCount,
      heading: match[5],
    });
  }
  return hunks;
}

/** Read a hunk header's declared values without interpreting the body. */
export function parseHeader(line: string): Hunk | undefined {
  const match = HUNK_RE.exec(line);
  if (!match) {
    return undefined;
  }
  return {
    headerLine: -1,
    bodyStart: -1,
    bodyEnd: -1,
    oldStart: parseInt(match[1], 10),
    oldCount: match[2] === undefined ? 1 : parseInt(match[2], 10),
    newStart: parseInt(match[3], 10),
    newCount: match[4] === undefined ? 1 : parseInt(match[4], 10),
    heading: match[5],
  };
}
