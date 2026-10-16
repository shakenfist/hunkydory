/**
 * An edit fuzzer for the recounter, judged by git.
 *
 * The unit tests and the corpus see patches whose headers are already right,
 * or whose counts were all scrambled at once. What the extension meets is a
 * correct patch someone has just edited, and that is where the bugs have
 * been. So this edits correct patches the way a person might, recounts, and
 * asks git whether the result says what the edited body says. What each check
 * is, and how to run, soak and replay it, is in docs/testing.md.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { recountText } from '../src/recount';
import { caseRandom, type Edit, edited, generateEdits } from './fuzz/edits';
import { coverage, judge } from './fuzz/judge';
import { type Patch, readPatch, render } from './fuzz/patch';

export interface Seed {
  name: string;
  patch: Patch;
}

/**
 * Read every patch in `dir` that can seed the fuzzer. A seed must be one git
 * reads cleanly and that recounts to itself; anything else says nothing about
 * an edit, and is the corpus check's business rather than ours.
 */
export function loadSeeds(dir: string): { seeds: Seed[]; rejected: string[] } {
  const seeds: Seed[] = [];
  const rejected: string[] = [];
  for (const name of fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.patch'))
    .sort()) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    try {
      const patch = readPatch(text);
      if (render(patch) !== text || recountText(text) !== text) {
        throw new Error('does not round trip');
      }
      if (!patch.items.some((item) => item.kind === 'hunk')) {
        throw new Error('has no hunks');
      }
      seeds.push({ name, patch });
    } catch (e) {
      rejected.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { seeds, rejected };
}

/**
 * Edited patches without judging them, for a caller that has a recounter of
 * its own to compare: test/editor/ runs these through a real editor.
 */
export function editedPatches(seeds: Seed[], seed: number, count: number): string[] {
  const texts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const random = caseRandom(seed, index);
    const chosen = seeds[Math.floor(random() * seeds.length)];
    texts.push(render(edited(chosen.patch, generateEdits(random))));
  }
  return texts;
}

export interface Failure {
  seed: number;
  index: number;
  name: string;
  edits: Edit[];
  text: string;
  failures: string[];
}

function runCase(seeds: Seed[], seed: number, index: number): Failure | undefined {
  const random = caseRandom(seed, index);
  const chosen = seeds[Math.floor(random() * seeds.length)];
  const edits = generateEdits(random);
  const attempt = (list: Edit[]) => {
    const patch = edited(chosen.patch, list);
    const text = render(patch);
    return { text, failures: judge(patch, text) };
  };

  let result = attempt(edits);
  if (result.failures.length === 0) {
    return undefined;
  }
  // Drop edits one at a time for as long as it still fails.
  let shortest = edits;
  for (let i = shortest.length - 1; i >= 0; i -= 1) {
    const fewer = shortest.filter((_, j) => j !== i);
    const retry = attempt(fewer);
    if (retry.failures.length > 0) {
      shortest = fewer;
      result = retry;
    }
  }
  return { seed, index, name: chosen.name, edits: shortest, ...result };
}

export function fuzz(seeds: Seed[], seed: number, cases: number, only?: number): Failure[] {
  const failures: Failure[] = [];
  const indices = only === undefined ? [...Array(cases).keys()] : [only];
  for (const index of indices) {
    const failure = runCase(seeds, seed, index);
    if (failure) {
      failures.push(failure);
    }
  }
  return failures;
}

export function describeFailure(failure: Failure): string {
  const lines = [
    `HUNKYDORY_FUZZ_SEED=${failure.seed} HUNKYDORY_FUZZ_CASE=${failure.index} npm run fuzz`,
    `seed patch ${failure.name}, edits ${failure.edits.map((e) => e.op).join(', ')}`,
    ...failure.failures.map((f) => `  ${f}`),
  ];
  const text = failure.text.split('\n');
  if (text.length <= 80) {
    lines.push('--- edited patch ---', ...text, '--- end ---');
  } else {
    // A directory of our own: a predictable name in a shared /tmp is one
    // another user could have planted a symlink at.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunkydory-fuzz-'));
    const file = path.join(dir, `${failure.seed}-${failure.index}.patch`);
    fs.writeFileSync(file, failure.text);
    lines.push(`edited patch written to ${file}`);
  }
  return lines.join('\n');
}

export const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const DEFAULT_CORPUS = path.join(__dirname, '..', '..', '..', 'kerbside-patches', '_patches');

function main(): number {
  const seed = Number(process.env.HUNKYDORY_FUZZ_SEED ?? Date.now() % 1000000);
  const cases = Number(process.env.HUNKYDORY_FUZZ_CASES ?? 2000);
  const only =
    process.env.HUNKYDORY_FUZZ_CASE === undefined
      ? undefined
      : Number(process.env.HUNKYDORY_FUZZ_CASE);
  for (const value of [seed, cases, only ?? 0]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      console.log('HUNKYDORY_FUZZ_SEED, _CASES and _CASE must be whole numbers.');
      return 2;
    }
  }

  const seeds: Seed[] = [];
  for (const dir of [FIXTURES, process.env.HUNKYDORY_CORPUS ?? DEFAULT_CORPUS]) {
    if (!fs.existsSync(dir)) {
      console.log(`No patches at ${dir}, skipping.`);
      continue;
    }
    const loaded = loadSeeds(dir);
    seeds.push(...loaded.seeds);
    console.log(`${dir}: ${loaded.seeds.length} seeds, ${loaded.rejected.length} rejected`);
    for (const reason of loaded.rejected) {
      console.log(`  rejected ${reason}`);
    }
  }

  if (seeds.length === 0) {
    console.log('FAIL no seed patches to edit');
    return 1;
  }
  console.log(`HUNKYDORY_FUZZ_SEED=${seed}, ${only === undefined ? cases : 1} cases`);
  const failures = fuzz(seeds, seed, cases, only);
  for (const failure of failures) {
    console.log('');
    console.log(describeFailure(failure));
  }
  console.log('');
  console.log(
    `${coverage.patches} patches judged, ${coverage.ambiguous} of them ambiguous, ` +
      `${coverage.byGit} of them by git as well; ` +
      `${coverage.filesApplied} files applied by git, ${coverage.filesSkipped} skipped`,
  );
  console.log(failures.length === 0 ? 'ok   no failures' : `FAIL ${failures.length} cases failed`);
  return failures.length === 0 ? 0 : 1;
}

if (require.main === module) {
  process.exit(main());
}
