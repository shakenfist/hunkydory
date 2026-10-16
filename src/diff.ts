/**
 * Parsing and counting rules for unified diffs.
 *
 * This module is deliberately free of any vscode import so that it can be
 * exercised by a plain node test runner.
 *
 * Everything here reads an array of lines whose terminators have already been
 * removed, which is what vscode's TextLine.text gives us and what splitPatch
 * produces from a string. A caller that splits on '\n' alone instead leaves
 * the CR of a CRLF file on the end of every line, so the rules below tolerate
 * a trailing CR rather than quietly recognising nothing: the failure they
 * replace is invisible, because nothing matches, nothing is counted, and the
 * file is handed back exactly as it arrived.
 */

/**
 * A hunk header, and everything after the closing @@ as the heading.
 *
 * The `\r?` is not decoration. A CRLF patch split on '\n' alone reaches us as
 * '@@ ... @@\r', and neither `.` nor `$` matches a CR -- `$` is not multiline
 * here and has no line to end at anyway -- so without it every header in such
 * a file fails to match and the whole file becomes a silent no-op. The CR is
 * deliberately outside the heading capture, so it can never be copied into a
 * rewritten header.
 */
export const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*?)\r?$/;

/** A patch split into lines, each remembering how it ended. */
export interface SplitPatch {
  /** Line content, with no terminator characters. */
  lines: string[];
  /**
   * The terminator that followed each line: '\r\n', '\n', '\r', or '' for a
   * final line that the file ends without terminating.
   */
  endings: string[];
}

/**
 * Split a patch into lines without losing how each one ended.
 *
 * Splitting on '\n' alone is what made CRLF patches a no-op: it leaves a CR
 * on the end of every line, and a CR is content as far as the counting rules
 * are concerned. A bare '\r' is not the empty string, so it is not the blank
 * context line it looks like, and '@@ ... @@\r' is not a header.
 *
 * The terminators are returned rather than a single detected line ending
 * because recounting must not rewrite a byte it was not asked to. A file with
 * mixed terminators -- which is a real thing in a patch assembled by hand from
 * two sources -- keeps its mixture, and one that ends without a terminator
 * still does.
 */
export function splitPatch(text: string): SplitPatch {
  // Constructed here rather than at module scope: a global regexp carries
  // lastIndex between calls, and sharing that across callers is a bug waiting
  // for a second one.
  const terminator = /\r\n|\n|\r/g;
  const lines: string[] = [];
  const endings: string[] = [];

  let start = 0;
  let match = terminator.exec(text);
  while (match !== null) {
    lines.push(text.slice(start, match.index));
    endings.push(match[0]);
    start = terminator.lastIndex;
    match = terminator.exec(text);
  }
  if (start < text.length) {
    lines.push(text.slice(start));
    endings.push('');
  }

  return { lines, endings };
}

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

/**
 * A line that introduces a file, in the formats that write one: `diff --git`
 * from git, `diff -r` and its kin from diff when recursing and from hg,
 * `Index: ` from svn, quilt and CVS, `=== ` from bzr and `==== ` from
 * Perforce.
 */
const INTRODUCES_FILE = /^(?:diff (?:--git |-)|Index: |={3,4} )/;

/**
 * The other lines that can come between one of those and the `--- ` line.
 * Anything else, a blank included, means the line above was prose that
 * happened to look like one.
 */
const FILE_PREAMBLE = [
  'index ',
  '=====',
  'new file mode ',
  'deleted file mode ',
  'old mode ',
  'new mode ',
  'similarity index ',
  'dissimilarity index ',
  'rename from ',
  'rename to ',
  'copy from ',
  'copy to ',
  'RCS file: ',
  'retrieving revision ',
];

/** Context, either change, a blank context line, or a `\ No newline` note. */
function isBodyLine(line: string): boolean {
  return line === '' || line === '\r' || ' +-\\'.includes(line.charAt(0));
}

/**
 * True if the `--- ` at lines[i] starts the next file rather than continuing
 * the hunk.
 *
 * A deleted line that read `-- ` -- an SQL, Lua, Haskell or Ada comment --
 * starts `--- ` too, and ending the hunk there drops it, and everything after
 * it, without a word from git. In a file `introduced` by a line of its own,
 * such as `diff --git`, the next file will be too, and that line ends the
 * hunk: a `--- ` inside it is always body. Without one, as from a bare
 * `diff -u`, a file header is `--- ` and then `+++ `, so a lone `--- ` is body
 * and the pair is a header, unless a body line follows it after any blanks.
 * The declared counts are never asked, because they may be ones a live
 * recount wrote a moment ago. docs/ambiguity.md has what that costs.
 */
function startsFile(lines: string[], i: number, introduced: boolean): boolean {
  if (introduced || !lines[i].startsWith('--- ') || !lines[i + 1]?.startsWith('+++ ')) {
    return false;
  }
  let j = i + 2;
  while (j < lines.length && lines[j].trim() === '') {
    j += 1;
  }
  const next = lines[j];
  if (next === undefined || !isBodyLine(next)) {
    return true;
  }
  // A file with no hunks is followed by the next file's header, whose `--- `
  // would otherwise pass for a deleted line.
  return next.startsWith('--- ') && lines[j + 1]?.startsWith('+++ ') === true;
}

/**
 * Counts for a hunk body, expressed as a function of how many trailing
 * whitespace-only lines are treated as falling outside the hunk.
 *
 * Index 0 is "count every line"; index k is "ignore the last k blank lines".
 * Before another hunk with context of its own, only index 0 exists.
 * See resolveCounts for why more than one answer exists.
 */
export interface BodyCounts {
  end: number;
  byTrailingBlanks: Counts[];
}

/**
 * Find where the hunk body starting at `start` ends, and count its lines.
 * `introduced` is for startsFile.
 */
export function measureBody(lines: string[], start: number, introduced: boolean): BodyCounts {
  let i = start;
  let oldCount = 0;
  let newCount = 0;
  const perLine: Array<{ line: string; old: number; nw: number }> = [];

  while (i < lines.length) {
    const line = lines[i];
    if (isSignature(lines, i) || HUNK_RE.test(line) || startsFile(lines, i, introduced)) {
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
    } else if (marker === ' ' || line === '' || line === '\r') {
      // Context. A bare empty line is a context line whose single leading
      // space was stripped, which some editors and mail paths do. A lone CR
      // is that same line in a CRLF file a caller split on '\n' alone: read
      // as content it would end the body here, and the header would then be
      // recounted too small, which is the direction git truncates silently.
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
  // Right before another hunk the blanks are not ambiguous: git reads every
  // line up to the next header as part of this hunk, and stops at nothing in
  // between, so a reading that leaves them out is a patch git rejects.
  //
  // Unless the hunk has no context with content, as in a patch made with
  // -U0, or with -U1 between two blank lines. Counted in, the blank would be
  // all the context git had to place the hunk by, and an insertion would go
  // silently at the first matching run of blank lines. A deleted line does
  // pin a hunk too, but the rule asks for context and goes no further than
  // it must: left out, the blank makes git reject the patch, and loud is the
  // better way to be wrong.
  let trailing = perLine.length;
  while (trailing > 0 && perLine[trailing - 1].line.trim() === '') {
    trailing -= 1;
  }
  const anchored = perLine
    .slice(0, trailing)
    .some((entry) => entry.old && entry.nw && entry.line.trim() !== '');
  const beforeHunk = i < lines.length && HUNK_RE.test(lines[i]) && anchored;
  const last = beforeHunk ? -1 : perLine.length - 1;
  let o = oldCount;
  let n = newCount;
  for (let k = last; k >= 0; k -= 1) {
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
 * This is the commoner of the two genuinely ambiguous parts of recounting;
 * startsFile has the other. git reads a hunk by consuming exactly as many
 * lines as the header declares and ignoring whatever follows, so a blank line
 * between the last real body line and the next `diff --git` may or may not
 * belong to the hunk. The body alone cannot say.
 * Before another hunk it usually can, and measureBody then offers only the one
 * reading.
 *
 * We break the tie with the header we were given: if ignoring k trailing
 * blanks makes both sides agree with the declared counts, that was the
 * author's intent and we preserve it. After a body edit no interpretation
 * matches and we fall back to counting every line, which is the safe
 * direction: an over-large count makes git reject the patch loudly, while an
 * under-large one makes it silently truncate the hunk.
 *
 * Except where a side starts at 0, as the old side of a creation and the new
 * side of a deletion do. Such a side must be empty, so a reading that gives it
 * lines is not a reading at all: the fallback is the first one that keeps it
 * empty, which is to say the trailing blanks are the gap before the next file.
 * If none does, every line is counted and checkHeaders, which tests the result
 * with the same zeroSideWithLines, refuses to write it.
 */
export function resolveCounts(
  counts: BodyCounts,
  declared: Counts & { oldStart: number; newStart: number },
): Counts {
  const valid = counts.byTrailingBlanks.filter((c) => zeroSideWithLines(declared, c) === undefined);
  for (const candidate of valid) {
    if (candidate.oldCount === declared.oldCount && candidate.newCount === declared.newCount) {
      return candidate;
    }
  }
  return valid[0] ?? counts.byTrailingBlanks[0];
}

/** How many lines a hunk occupies on each side. */
export interface Counts {
  oldCount: number;
  newCount: number;
}

/**
 * The side of a hunk that starts at 0 but would be given lines, if either.
 *
 * Line 0 only exists as "before the first line", so a range starting there
 * must be empty: `-0,0` for a creation or an insertion at the top, `+0,0` for
 * a deletion. Anything else is a corrupt patch to git.
 */
export function zeroSideWithLines(
  starts: { oldStart: number; newStart: number },
  counts: Counts,
): 'old' | 'new' | undefined {
  if (starts.oldStart === 0 && counts.oldCount !== 0) {
    return 'old';
  }
  if (starts.newStart === 0 && counts.newCount !== 0) {
    return 'new';
  }
  return undefined;
}

/** A hunk header, what it declares, and the body that follows it. */
export interface HunkSite {
  /** Line index of the @@ header. */
  line: number;
  declared: Hunk;
  body: BodyCounts;
  /** The first hunk of a file, where the running offset between sides restarts. */
  firstInFile: boolean;
}

/**
 * Every hunk in a document, in order, with its body measured. Bodies are
 * stepped over rather than searched for file headers, because what reads as
 * one inside a body can be a deleted line.
 */
export function* hunkSites(lines: string[]): Generator<HunkSite> {
  // Whether a line such as `diff --git` has come since the last file header,
  // and whether one came before the current file's.
  let introducing = false;
  let introduced = false;
  let firstInFile = true;
  let i = 0;
  while (i < lines.length) {
    const declared = parseHeader(lines[i]);
    if (!declared) {
      if (INTRODUCES_FILE.test(lines[i])) {
        introducing = true;
      } else if (lines[i].startsWith('--- ')) {
        introduced = introducing;
        introducing = false;
        firstInFile = true;
      } else if (!FILE_PREAMBLE.some((p) => lines[i].startsWith(p))) {
        introducing = false;
      }
      i += 1;
      continue;
    }
    const body = measureBody(lines, i + 1, introduced);
    yield { line: i, declared, body, firstInFile };
    firstInFile = false;
    i = body.end;
  }
}

/** Parse every hunk in a document, in order. */
export function parseHunks(lines: string[]): Hunk[] {
  const hunks: Hunk[] = [];
  for (const { line, declared, body } of hunkSites(lines)) {
    const resolved = resolveCounts(body, declared);
    hunks.push({
      ...declared,
      headerLine: line,
      bodyStart: line + 1,
      bodyEnd: body.end,
      oldCount: resolved.oldCount,
      newCount: resolved.newCount,
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
