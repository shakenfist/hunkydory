/**
 * Edits a person might make to a patch, from a seedable source of randomness:
 * Math.random cannot be seeded, and a failure nobody can replay is a failure
 * nobody can fix.
 */

import { type HunkItem, hunkLines, isZeroStart, type Patch, type TextItem } from './patch';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function caseRandom(seed: number, index: number): () => number {
  return mulberry32(Math.imul(seed, 0x9e3779b1) ^ index);
}

/** Choose by weight, using one random number in [0, 1). */
function weighted<T>(choices: Array<[T, number]>, r: number): T {
  const total = choices.reduce((sum, [, w]) => sum + w, 0);
  let x = r * total;
  for (const [choice, w] of choices) {
    if (x < w) {
      return choice;
    }
    x -= w;
  }
  return choices[choices.length - 1][0];
}

// Edits a person might make.

type Op =
  | 'insert'
  | 'delete'
  | 'retype'
  | 'gapBlank'
  | 'finalNewline'
  | 'signature'
  | 'trailingBlanks'
  | 'crlf';

/**
 * One edit, as an operation and the random numbers that place it. Holding the
 * numbers rather than resolved positions keeps every edit applicable after any
 * other is dropped, which is what lets a failure be shrunk.
 */
export interface Edit {
  op: Op;
  r: number[];
}

const OPS: Array<[Op, number]> = [
  ['insert', 8],
  ['delete', 5],
  ['retype', 3],
  ['gapBlank', 3],
  ['finalNewline', 1],
  ['signature', 1],
  ['trailingBlanks', 1],
  ['crlf', 1],
];

/**
 * What body lines say. The last three make lines that look like something
 * else: deleted, `-- note` is `--- note`, the start of a file header; added,
 * `++ note` is `+++ note`, the rest of one; and deleted, `- ` is `-- `, the
 * start of git's signature.
 */
const WORDS = [
  'alpha',
  'beta',
  'gamma',
  'delta',
  'kolla',
  'nova',
  'spice',
  'value: 1',
  'x',
  '-- note',
  '++ note',
  '- ',
];

/** Edits go mostly to the last hunk, and to creations and deletions. */
function pickHunk(patch: Patch, r: number): number | undefined {
  const hunks: Array<[number, number]> = [];
  let last = -1;
  patch.items.forEach((item, index) => {
    if (item.kind === 'hunk') {
      hunks.push([index, 1 + (isZeroStart(item) ? 3 : 0)]);
      last = index;
    }
  });
  if (hunks.length === 0) {
    return undefined;
  }
  for (const entry of hunks) {
    if (entry[0] === last) {
      entry[1] += 3;
    }
  }
  return weighted(hunks, r);
}

function newBodyLine(hunk: HunkItem, r1: number, r2: number): string {
  const zero = isZeroStart(hunk);
  const choices: Array<[string, number]> = [
    ['+', zero === 'old' ? 12 : 3],
    ['-', zero === 'new' ? 12 : 3],
    [' ', 3],
    ['', 2],
    ['blank-space', 1],
  ];
  const marker = weighted(choices, r1);
  if (marker === '') {
    return '';
  }
  if (marker === 'blank-space') {
    return ' ';
  }
  return marker + WORDS[Math.floor(r2 * WORDS.length)];
}

function applyEdit(patch: Patch, edit: Edit): void {
  const [r0, r1, r2, r3] = edit.r;
  const hunkIndex = pickHunk(patch, r0);
  const hunk = hunkIndex === undefined ? undefined : (patch.items[hunkIndex] as HunkItem);

  switch (edit.op) {
    case 'insert': {
      if (!hunk) {
        return;
      }
      // Never between a line and the "\ No newline" note that belongs to it.
      const positions: number[] = [];
      for (let p = 0; p <= hunk.body.length; p += 1) {
        if (!hunk.body[p]?.text.startsWith('\\')) {
          positions.push(p);
        }
      }
      const at = positions[Math.floor(r1 * positions.length)];
      hunk.body.splice(at, 0, { text: newBodyLine(hunk, r2, r3), ending: patch.ending });
      return;
    }
    case 'delete': {
      if (!hunk) {
        return;
      }
      const counted = hunk.body.flatMap((line, i) => (line.text.startsWith('\\') ? [] : [i]));
      if (counted.length < 2) {
        return;
      }
      const at = counted[Math.floor(r1 * counted.length)];
      const note = hunk.body[at + 1]?.text.startsWith('\\') ? 1 : 0;
      hunk.body.splice(at, 1 + note);
      return;
    }
    case 'retype': {
      if (!hunk) {
        return;
      }
      const counted = hunk.body.flatMap((line, i) => (line.text.startsWith('\\') ? [] : [i]));
      const line = hunk.body[counted[Math.floor(r1 * counted.length)]];
      const marker = weighted<string>(
        [
          [' ', 1],
          ['+', 1],
          ['-', 1],
        ],
        r2,
      );
      line.text = marker + line.text.slice(1);
      return;
    }
    case 'gapBlank': {
      if (!hunk) {
        return;
      }
      // After the file's last hunk, where a blank is the ambiguity
      // docs/ambiguity.md describes. Between two hunks of one file git rejects
      // the patch whichever way the blank is counted, so there is no right
      // answer to check.
      let after = 0;
      patch.items.forEach((item, i) => {
        if (item.kind === 'hunk' && item.file === hunk.file) {
          after = i + 1;
        }
      });
      const text = r1 < 0.75 ? '' : ' ';
      patch.items.splice(after, 0, { kind: 'text', line: { text, ending: patch.ending } });
      return;
    }
    case 'finalNewline':
      patch.finalNewline = !patch.finalNewline;
      return;
    case 'signature': {
      const at = patch.items.findIndex(
        (item, i) =>
          item.kind === 'text' &&
          item.line.text === '-- ' &&
          patch.items[i + 1]?.kind === 'text' &&
          /^\d+\.\d/.test((patch.items[i + 1] as TextItem).line.text),
      );
      if (at >= 0) {
        patch.items.splice(at, 2);
        return;
      }
      let last = -1;
      patch.items.forEach((item, i) => {
        if (item.kind === 'hunk') {
          last = i;
        }
      });
      if (last >= 0) {
        patch.items.splice(
          last + 1,
          0,
          { kind: 'text', line: { text: '-- ', ending: patch.ending } },
          { kind: 'text', line: { text: '2.47.3', ending: patch.ending } },
        );
      }
      return;
    }
    case 'trailingBlanks': {
      const count = 1 + Math.floor(r1 * 2);
      for (let i = 0; i < count; i += 1) {
        patch.items.push({ kind: 'text', line: { text: '', ending: patch.ending } });
      }
      return;
    }
    case 'crlf':
      patch.ending = '\r\n';
      for (const line of patch.items.flatMap(hunkLines)) {
        line.ending = '\r\n';
      }
      return;
  }
}

export function generateEdits(random: () => number): Edit[] {
  const count = 1 + Math.floor(random() * 4);
  const edits: Edit[] = [];
  for (let i = 0; i < count; i += 1) {
    edits.push({ op: weighted(OPS, random()), r: [random(), random(), random(), random()] });
  }
  return edits;
}

export function edited(seed: Patch, edits: Edit[]): Patch {
  const patch = structuredClone(seed);
  for (const edit of edits) {
    applyEdit(patch, edit);
  }
  return patch;
}
