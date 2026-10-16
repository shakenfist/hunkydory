/**
 * The judge: what is wrong with how an edited patch was recounted, decided by
 * git and by the edited bodies rather than by the rules under test.
 * test/fuzz.ts and docs/testing.md have what each check is for.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkHeaders, recountText } from '../../src/recount';
import {
  type FileInfo,
  type HunkItem,
  isZeroStart,
  type Line,
  type Patch,
  parseHeaderLine,
  readPatch,
  sides,
  splitLines,
} from './patch';

function isBlankContext(text: string): boolean {
  return text === '' || (text.charAt(0) === ' ' && text.trim() === '');
}

function bodyCounts(body: Line[]): { old: number; nw: number; added: number; deleted: number } {
  let old = 0;
  let nw = 0;
  let added = 0;
  let deleted = 0;
  for (const line of body) {
    const s = sides(line.text);
    old += s?.old ?? 0;
    nw += s?.nw ?? 0;
    if (line.text.startsWith('+')) {
      added += 1;
    } else if (line.text.startsWith('-')) {
      deleted += 1;
    }
  }
  return { old, nw, added, deleted };
}

/**
 * The counts a recounted header may carry: the body's own, less any blank
 * lines that end it, or plus any blank lines between it and whatever follows.
 * docs/ambiguity.md has why both are honest readings -- except right before
 * another hunk, where git takes any line that is not a header as part of the
 * hunk before, and the blanks cannot be left out. Unless nothing else in the
 * hunk anchors it, which is strandsBlank.
 */
function acceptableCounts(patch: Patch, index: number): Array<[number, number]> {
  const hunk = patch.items[index] as HunkItem;
  const { old, nw } = bodyCounts(hunk.body);

  let below = 0;
  const mustCount = patch.items[index + 1]?.kind === 'hunk' && !strandsBlank(patch, index);
  for (let i = hunk.body.length - 1; i >= 0 && !mustCount; i -= 1) {
    const text = hunk.body[i].text;
    if (text.startsWith('\\')) {
      continue;
    }
    if (!isBlankContext(text)) {
      break;
    }
    below += 1;
  }
  let above = 0;
  for (let i = index + 1; i < patch.items.length; i += 1) {
    const item = patch.items[i];
    if (item.kind !== 'text' || !isBlankContext(item.line.text)) {
      break;
    }
    above += 1;
  }

  const zero = isZeroStart(hunk);
  const counts: Array<[number, number]> = [];
  for (let d = -below; d <= above; d += 1) {
    const o = old + d;
    const n = nw + d;
    if ((o === 0 && n === 0) || (zero === 'old' && o !== 0) || (zero === 'new' && n !== 0)) {
      continue;
    }
    counts.push([o, n]);
  }
  return counts;
}

/**
 * True for a hunk before another hunk that ends in blank lines and has no
 * other context with content. Counted in, those blanks would be all git had
 * to place the hunk by, so they are left out and git rejects the patch,
 * which is the loud way to be wrong (docs/ambiguity.md). Either way git has
 * nothing true to say about where the hunk goes.
 *
 * Counting them in is accepted too, because after an edit elsewhere in the
 * hunk the fallback still does, which is the silent way: deferred to #86.
 */
function strandsBlank(patch: Patch, index: number): boolean {
  const hunk = patch.items[index] as HunkItem;
  if (patch.items[index + 1]?.kind !== 'hunk') {
    return false;
  }
  const counted = hunk.body.filter((line) => !line.text.startsWith('\\'));
  let end = counted.length;
  while (end > 0 && isBlankContext(counted[end - 1].text)) {
    end -= 1;
  }
  const anchored = counted
    .slice(0, end)
    .some((line) => line.text.charAt(0) === ' ' && line.text.trim() !== '');
  return end < counted.length && !anchored;
}

function scratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hunkydory-fuzz-'));
}

/**
 * Run git hermetically: no user or system configuration, and no repository
 * discovered above the scratch directory, so `git apply` can only ever touch
 * the files this module wrote there.
 */
export function git(args: string[], cwd: string, input?: string) {
  return spawnSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CEILING_DIRECTORIES: path.dirname(cwd),
    },
  });
}

/**
 * The patch as git can read it at all. git reads a lone CR as content, and
 * calls a patch whose last line has no newline corrupt, so neither is a
 * question about the headers.
 */
function forGit(text: string): string {
  const lf = text.replace(/\r\n?/g, '\n');
  return lf.endsWith('\n') ? lf : `${lf}\n`;
}

/** `--numstat` only reports, so the arbitrary paths in a whole patch are never written. */
function checkNumstat(text: string, expected: { added: number; deleted: number }, dir: string) {
  const result = git(['apply', '--numstat', '-'], dir, forGit(text));
  if (result.status !== 0) {
    return [`git apply --numstat rejected the recounted patch: ${result.stderr.trim()}`];
  }
  let added = 0;
  let deleted = 0;
  for (const row of result.stdout.split('\n')) {
    const [a, d] = row.split('\t');
    added += Number(a) || 0;
    deleted += Number(d) || 0;
  }
  if (added !== expected.added || deleted !== expected.deleted) {
    return [
      `git counts +${added} -${deleted} in the recounted patch, ` +
        `but its bodies hold +${expected.added} -${expected.deleted}`,
    ];
  }
  return [];
}

const FILLER = (n: number) => `~ untouched line ${n} ~`;

/**
 * Apply one file's recounted hunks with git to an old file built from them,
 * and compare with the new file they describe. Returns the failures, or
 * 'skipped' where the hunks cannot describe a single old file, which an edit
 * can do by growing one hunk into the next.
 */
export function checkFile(hunks: HunkItem[], info: FileInfo, dir: string): string[] | 'skipped' {
  const old: string[] = [];
  const expected: string[] = [];
  let oldNoEol = false;
  let newNoEol = false;
  let cursor = 0;
  let needsUnidiffZero = false;

  for (const [k, hunk] of hunks.entries()) {
    const h = hunk.declared;
    const start = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    if (start < cursor) {
      return 'skipped';
    }
    for (let n = cursor; n < start; n += 1) {
      old.push(FILLER(n + 1));
      expected.push(FILLER(n + 1));
    }
    let trailing = 0;
    let context = 0;
    let previous = '';
    for (const line of hunk.body) {
      const text = line.text;
      if (text.startsWith('\\')) {
        // Only the end of a file can lack a newline, so the note must be in
        // the last hunk, and nothing may follow on the side it marks.
        if (k !== hunks.length - 1) {
          return 'skipped';
        }
        oldNoEol ||= previous !== '+';
        newNoEol ||= previous !== '-';
        continue;
      }
      previous = text.charAt(0) === '-' || text.charAt(0) === '+' ? text.charAt(0) : ' ';
      if ((oldNoEol && previous !== '+') || (newNoEol && previous !== '-')) {
        return 'skipped';
      }
      const content = text.slice(1);
      if (previous !== '+') {
        old.push(content);
      }
      if (previous !== '-') {
        expected.push(content);
      }
      trailing = previous === ' ' ? trailing + 1 : 0;
      context += previous === ' ' ? 1 : 0;
    }
    cursor = start + h.oldCount;
    if (context === 0 || (trailing === 0 && k !== hunks.length - 1)) {
      // What git diff -U0 writes, and git applies only when told to: without
      // the flag it anchors such a hunk to the start or end of the file.
      needsUnidiffZero = true;
    }
  }

  const target = path.join(dir, 'target');
  const join = (lines: string[], noEol: boolean) =>
    lines.length === 0 ? '' : lines.join('\n') + (noEol ? '' : '\n');
  if (!info.creates) {
    fs.writeFileSync(target, join(old, oldNoEol));
  }

  const patch = [
    info.creates ? '--- /dev/null' : '--- a/target',
    info.deletes ? '+++ /dev/null' : '+++ b/target',
    ...hunks.flatMap((hunk) => [hunk.header.text, ...hunk.body.map((line) => line.text)]),
    '',
  ].join('\n');
  const args = ['apply', '-v', ...(needsUnidiffZero ? ['--unidiff-zero'] : []), '-'];
  const result = git(args, dir, patch);
  try {
    if (result.status !== 0) {
      return [`git apply failed: ${result.stderr.trim()}`];
    }
    // The offset check reads git's wording, so a git that worded things
    // differently would pass every header unread. Insist on the line around it.
    if (!result.stderr.includes('Applied patch target cleanly.')) {
      return [`git applied the patch but did not say so as expected: ${result.stderr.trim()}`];
    }
    for (const line of result.stderr.split('\n')) {
      const m = /^Hunk #(\d+) succeeded at \d+ \(offset (-?\d+) lines?\)/.exec(line);
      // git looks for a hunk with an empty new side one line early, and says
      // so even of a patch it wrote itself with -U0. Any other offset means
      // a header that points somewhere other than where its lines are.
      if (m && !(m[2] === '1' && hunks[Number(m[1]) - 1]?.declared.newCount === 0)) {
        return [`git found a hunk away from where its header says: ${line.trim()}`];
      }
    }
    if (info.deletes) {
      return fs.existsSync(target) ? ['git did not delete the file'] : [];
    }
    if (fs.readFileSync(target, 'utf8') !== join(expected, newNoEol)) {
      return ['git applied the hunks, but the new file is not what they describe'];
    }
    return [];
  } finally {
    fs.rmSync(target, { force: true });
  }
}

/**
 * How much of the judging git got to do. A judge that steps aside more and
 * more often is one that is quietly checking less, so `npm run fuzz` prints it.
 */
export const coverage = { patches: 0, byGit: 0, filesApplied: 0, filesSkipped: 0 };

/** Everything wrong with how `text`, the rendering of `patch`, is recounted. */
export function judge(patch: Patch, text: string): string[] {
  const failures: string[] = [];
  coverage.patches += 1;
  const recounted = recountText(text);
  const outLines = splitLines(recounted);
  const refused = new Set(
    checkHeaders(splitLines(text).map((l) => l.text)).refused.map((r) => r.line),
  );

  let line = 0;
  let anyRefused = false;
  let anyUnchanged = false;
  const totals = { added: 0, deleted: 0 };
  // The running new-side offset within a file, for checking starts where git
  // cannot: it stands aside for a whole patch over one hunk it cannot judge.
  // This is the documented rule (docs/hunk-format.md), not the code's.
  let file = -1;
  let delta = 0;
  patch.items.forEach((item, index) => {
    if (item.kind === 'text') {
      line += 1;
      return;
    }
    if (item.file !== file) {
      file = item.file;
      delta = 0;
    }
    const where = `hunk at line ${line + 1} (${item.header.text})`;
    const out = outLines[line]?.text ?? '';
    const acceptable = acceptableCounts(patch, index);
    const counts = bodyCounts(item.body);
    totals.added += counts.added;
    totals.deleted += counts.deleted;
    anyUnchanged ||= counts.added + counts.deleted === 0 || strandsBlank(patch, index);

    if (acceptable.length === 0) {
      anyRefused = true;
      delta += item.declared.newCount - item.declared.oldCount;
      if (!refused.has(line)) {
        failures.push(`${where}: no valid header exists, but it was not reported`);
      }
      if (out !== item.header.text) {
        failures.push(`${where}: no valid header exists, but it was rewritten to ${out}`);
      }
    } else {
      const got = parseHeaderLine(out);
      if (!got) {
        failures.push(`${where}: recounted to something that is not a header: ${out}`);
      } else {
        if (!acceptable.some(([o, n]) => o === got.oldCount && n === got.newCount)) {
          const want = acceptable.map(([o, n]) => `-${o} +${n}`).join(' or ');
          failures.push(`${where}: recounted to ${out}; the body says ${want}`);
        }
        if (got.oldStart !== item.declared.oldStart || got.heading !== item.declared.heading) {
          failures.push(`${where}: recounting changed more than the counts: ${out}`);
        }
        // An empty range names the line before it.
        const start =
          got.oldStart + delta + (got.oldCount === 0 ? 1 : 0) - (got.newCount === 0 ? 1 : 0);
        if (got.newStart !== start) {
          failures.push(`${where}: recounted to ${out}; the new side starts at ${start}`);
        }
        delta += got.newCount - got.oldCount;
      }
      if (refused.has(line)) {
        failures.push(`${where}: reported as impossible, but a valid header exists`);
      }
    }
    line += 1 + item.body.length;
  });

  if (recountText(recounted) !== recounted) {
    failures.push('recounting the recounted patch changed it again');
  }
  if (failures.length > 0 || anyRefused || anyUnchanged) {
    // A refused header is stale by design, and git calls a hunk that changes
    // nothing corrupt however it is counted, so either way git has nothing
    // true to say about the headers.
    return failures;
  }

  coverage.byGit += 1;
  const dir = scratchDir();
  try {
    failures.push(...checkNumstat(recounted, totals, dir));
    let reread: Patch;
    try {
      reread = readPatch(recounted);
    } catch (e) {
      return [...failures, `the recounted patch cannot be read by its headers: ${e}`];
    }
    reread.files.forEach((info, file) => {
      const hunks = reread.items.filter(
        (item): item is HunkItem => item.kind === 'hunk' && item.file === file,
      );
      if (hunks.length === 0) {
        return;
      }
      const result = checkFile(hunks, info, dir);
      coverage[result === 'skipped' ? 'filesSkipped' : 'filesApplied'] += 1;
      if (result !== 'skipped') {
        failures.push(...result.map((f) => `file ${file + 1}: ${f}`));
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return failures;
}
