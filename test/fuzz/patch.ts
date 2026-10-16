/**
 * A patch as the fuzzer holds it, read the way git reads it: each hunk is
 * exactly as many lines as its header declares. Deliberately none of
 * src/diff.ts, so the judge does not share the code it judges.
 */

export interface Line {
  text: string;
  ending: string;
}

interface Header {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  heading: string;
}

export interface HunkItem {
  kind: 'hunk';
  header: Line;
  declared: Header;
  body: Line[];
  file: number;
}

export interface TextItem {
  kind: 'text';
  line: Line;
}

type Item = HunkItem | TextItem;

export interface FileInfo {
  creates: boolean;
  deletes: boolean;
}

export interface Patch {
  items: Item[];
  files: FileInfo[];
  /** The terminator new lines get. */
  ending: string;
  finalNewline: boolean;
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseHeaderLine(text: string): Header | undefined {
  const m = HEADER.exec(text);
  if (!m) {
    return undefined;
  }
  return {
    oldStart: Number(m[1]),
    oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] === undefined ? 1 : Number(m[4]),
    heading: m[5],
  };
}

export function splitLines(text: string): Line[] {
  const parts = text.split(/(\r\n|\n|\r)/);
  const lines: Line[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const ending = parts[i + 1] ?? '';
    if (parts[i] === '' && ending === '' && i === parts.length - 1) {
      break;
    }
    lines.push({ text: parts[i], ending });
  }
  return lines;
}

/** How a body line counts: on the old side, the new side, both, or neither. */
export function sides(text: string): { old: number; nw: number } | undefined {
  const marker = text.charAt(0);
  if (marker === ' ' || text === '') {
    return { old: 1, nw: 1 };
  }
  if (marker === '-') {
    return { old: 1, nw: 0 };
  }
  if (marker === '+') {
    return { old: 0, nw: 1 };
  }
  if (marker === '\\') {
    return { old: 0, nw: 0 };
  }
  return undefined;
}

/**
 * Read a patch by its headers, as git does: each hunk is exactly as many lines
 * as its header declares. Throws on anything git would call corrupt.
 */
export function readPatch(text: string): Patch {
  const lines = splitLines(text);
  const items: Item[] = [];
  const files: FileInfo[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const declared = parseHeaderLine(line.text);
    if (!declared) {
      if (line.text.startsWith('--- ') && lines[i + 1]?.text.startsWith('+++ ')) {
        files.push({
          creates: line.text === '--- /dev/null',
          deletes: lines[i + 1].text === '+++ /dev/null',
        });
      }
      items.push({ kind: 'text', line });
      i += 1;
      continue;
    }
    if (files.length === 0) {
      throw new Error(`line ${i + 1}: a hunk before any --- line`);
    }
    let old = declared.oldCount;
    let nw = declared.newCount;
    const body: Line[] = [];
    i += 1;
    while ((old > 0 || nw > 0) && i < lines.length) {
      const counts = sides(lines[i].text);
      if (!counts) {
        throw new Error(`line ${i + 1}: not a hunk body line`);
      }
      old -= counts.old;
      nw -= counts.nw;
      body.push(lines[i]);
      i += 1;
    }
    if (old !== 0 || nw !== 0) {
      throw new Error(`hunk at ${line.text} does not match its body`);
    }
    if (i < lines.length && lines[i].text.startsWith('\\')) {
      body.push(lines[i]);
      i += 1;
    }
    items.push({ kind: 'hunk', header: line, declared, body, file: files.length - 1 });
  }

  const endings = lines.map((l) => l.ending).filter((e) => e !== '');
  const ending = endings.includes('\r\n') && !endings.includes('\n') ? '\r\n' : '\n';
  const finalNewline = lines.length > 0 && lines[lines.length - 1].ending !== '';
  // Every line carries a terminator while edits are made, so that adding a
  // line after the last one needs no special case; render takes it off again.
  for (const line of lines) {
    if (line.ending === '') {
      line.ending = ending;
    }
  }
  return { items, files, ending, finalNewline };
}

export function hunkLines(item: Item): Line[] {
  return item.kind === 'hunk' ? [item.header, ...item.body] : [item.line];
}

export function render(patch: Patch): string {
  const lines = patch.items.flatMap(hunkLines);
  return lines
    .map(
      (line, i) => line.text + (i === lines.length - 1 && !patch.finalNewline ? '' : line.ending),
    )
    .join('');
}

export function isZeroStart(hunk: HunkItem): 'old' | 'new' | undefined {
  if (hunk.declared.oldStart === 0) {
    return 'old';
  }
  if (hunk.declared.newStart === 0) {
    return 'new';
  }
  return undefined;
}
