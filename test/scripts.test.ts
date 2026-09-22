/**
 * Tests for the shell scripts in tools/ that CI runs and nothing else did.
 *
 * Issue #33: `release.yml` triggers only on `v*` tags and workflow_dispatch,
 * so none of it runs on a pull request. Before this file, a defect in the
 * stage dispatch, the argument handling or the tag check surfaced during a
 * real release and nowhere earlier -- shellcheck lints these scripts but
 * never executes them.
 *
 * Everything here runs without docker, without network and without
 * credentials, which is what lets it live in `npm test` rather than in a
 * runbook. That restricts what can be covered to the paths that fail before
 * the container starts: argument validation, the stage dispatch, the two
 * halves of the tag check, and tools/vsix-digest.sh in full.
 *
 * What is not covered, so that nobody reads the list above as more than it
 * is: the container half of either script. For tools/build-vsix.sh that is
 * the install and the package; for tools/publish-marketplace.sh it is the
 * whole of it -- the .vsix recount, the order in which the token is minted
 * and the OIDC variables stripped, and the ::add-mask::. Both need a real
 * docker daemon, and the second needs credentials besides, which is why
 * they are out rather than merely missing. Issue #33 records what covering
 * them would cost.
 *
 * `docker` and `npm` are stubbed onto PATH with commands that fail loudly
 * rather than merely being absent. A test that reaches either is a test
 * whose premise has broken, and it should say so instead of passing because
 * the tool happened not to be installed on the machine running it.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

const REPO = path.resolve(__dirname, '..', '..');
const DOCKER_REACHED = 'STUB-DOCKER-REACHED';
const NPM_REACHED = 'STUB-NPM-REACHED';

const temporaries: string[] = [];

function makeTemporaryDirectory(): string {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 'hunkydory-scripts-'));
  temporaries.push(created);
  return created;
}

/**
 * A PATH entry holding stubs for the two commands these scripts would
 * otherwise shell out to. Each exits with a distinctive status and marker so
 * a test can assert it was never reached.
 */
const stubBin = (() => {
  const directory = makeTemporaryDirectory();
  for (const [name, marker, status] of [
    ['docker', DOCKER_REACHED, 99],
    ['npm', NPM_REACHED, 98],
  ] as const) {
    const stub = path.join(directory, name);
    fs.writeFileSync(stub, `#!/bin/sh\necho "${marker}" >&2\nexit ${status}\n`);
    fs.chmodSync(stub, 0o755);
  }
  return directory;
})();

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run one of the scripts. `env` entries set to undefined are removed from the
 * environment rather than set empty -- the difference between the two is
 * itself under test.
 */
function run(
  script: string,
  args: string[] = [],
  options: { env?: Record<string, string | undefined>; cwd?: string } = {},
): RunResult {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${stubBin}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  const result = spawnSync(path.join(REPO, 'tools', script), args, {
    cwd: options.cwd ?? REPO,
    encoding: 'utf8',
    env,
  });
  // A script that could not be executed at all -- a lost execute bit, a
  // renamed file -- comes back with a null status and an error. Folding the
  // error into stderr keeps that from reading as an ordinary failure whose
  // message happens to be missing.
  const failedToStart = result.error ? `could not run ${script}: ${result.error.message}\n` : '';
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: failedToStart + (result.stderr ?? ''),
  };
}

function assertNoContainerStarted(result: RunResult): void {
  const combined = result.stdout + result.stderr;
  assert.ok(!combined.includes(DOCKER_REACHED), 'started a container before failing');
  assert.ok(!combined.includes(NPM_REACHED), 'ran npm before failing');
}

function writeVsix(directory: string, name: string, contents: string): string {
  const file = path.join(directory, name);
  fs.writeFileSync(file, contents);
  return file;
}

after(() => {
  for (const directory of temporaries) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('build-vsix.sh, the paths that fail before the container', () => {
  const release = { HUNKYDORY_RELEASE_TAG: '' };

  test('rejects an argument, since it takes none', () => {
    const result = run('build-vsix.sh', ['unexpected'], { env: release });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage/);
    assertNoContainerStarted(result);
  });

  test('rejects an unknown stage rather than falling through to one', () => {
    const result = run('build-vsix.sh', [], {
      env: { ...release, HUNKYDORY_BUILD_STAGE: 'bogus' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown stage: bogus/);
    assertNoContainerStarted(result);
  });

  test('an unset release tag is an error, not a synonym for empty', () => {
    // The whole point: a dropped or mistyped `env:` key in release.yml must
    // fail the job rather than silently skip the version check.
    const result = run('build-vsix.sh', [], { env: { HUNKYDORY_RELEASE_TAG: undefined } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be set/);
    assertNoContainerStarted(result);
  });

  test('a tag without the v prefix fails before an image is pulled', () => {
    // Without this the `${tag#v}` strip is a no-op and the version
    // comparison runs against the wrong string.
    const result = run('build-vsix.sh', [], {
      env: { HUNKYDORY_RELEASE_TAG: '0.1.0' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not start with v/);
    assertNoContainerStarted(result);
  });

  test('a mismatched version fails before anything is installed', () => {
    // Exercises the container half directly, in a directory holding only a
    // package.json. Safe because the check is the first thing that half
    // does: if it ever stopped failing first, the npm stub would be reached
    // and assertNoContainerStarted would say so.
    const directory = makeTemporaryDirectory();
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    const result = run('build-vsix.sh', [], {
      cwd: directory,
      env: { HUNKYDORY_BUILD_STAGE: 'container', HUNKYDORY_RELEASE_TAG: 'v9.9.9' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /tag v9\.9\.9 != package\.json 1\.2\.3/);
    assertNoContainerStarted(result);
  });

  test('a matching version passes the check and goes on to install', () => {
    // The other side of the branch above. There is no output to assert on
    // when the check passes -- it is silent -- so what proves it passed is
    // that execution reached `npm ci`, which is the stub. That is also why
    // the stub has to exist: without it this case would run a real install.
    const directory = makeTemporaryDirectory();
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    const result = run('build-vsix.sh', [], {
      cwd: directory,
      env: { HUNKYDORY_BUILD_STAGE: 'container', HUNKYDORY_RELEASE_TAG: 'v1.2.3' },
    });
    assert.equal(result.status, 98);
    assert.match(result.stderr, /STUB-NPM-REACHED/);
  });
});

describe('publish-marketplace.sh, the checks it makes before the container', () => {
  test('requires exactly one argument', () => {
    const result = run('publish-marketplace.sh');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage/);
    assertNoContainerStarted(result);
  });

  test('rejects a directory that does not exist', () => {
    // Under a freshly made temp directory rather than a fixed name in
    // os.tmpdir(). ci.yml runs this on [self-hosted, static], a persistent
    // pool shared with every repository in both organisations, where any
    // other job or user could create a predictable path and leave this
    // assertion failing forever.
    const absent = path.join(makeTemporaryDirectory(), 'absent');
    const result = run('publish-marketplace.sh', [absent]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no such directory/);
    assertNoContainerStarted(result);
  });

  test('rejects a directory holding no .vsix', () => {
    const result = run('publish-marketplace.sh', [makeTemporaryDirectory()]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /expected one \.vsix .*got 0/);
    assertNoContainerStarted(result);
  });

  test('rejects a directory holding more than one .vsix', () => {
    const directory = makeTemporaryDirectory();
    writeVsix(directory, 'one.vsix', 'a');
    writeVsix(directory, 'two.vsix', 'b');
    const result = run('publish-marketplace.sh', [directory]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /expected one \.vsix .*got 2/);
    assertNoContainerStarted(result);
  });

  // One case per variable rather than one case unsetting all four. The
  // script checks them in a loop, and unsetting everything only ever
  // exercises whichever it happens to reach first -- a typo in the name of
  // the second, third or fourth would have gone unnoticed.
  const credentials = {
    AZURE_CLIENT_ID: 'client-id',
    AZURE_TENANT_ID: 'tenant-id',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
  };

  for (const missing of Object.keys(credentials)) {
    test(`refuses to start without ${missing}`, () => {
      const directory = makeTemporaryDirectory();
      writeVsix(directory, 'one.vsix', 'a');
      const result = run('publish-marketplace.sh', [directory], {
        env: { ...credentials, [missing]: undefined },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`${missing} is not set`));
      // With the other three present, reaching docker would mean the loop
      // skipped this one rather than that it passed.
      assertNoContainerStarted(result);
    });
  }

  test('rejects an unknown stage', () => {
    const result = run('publish-marketplace.sh', [makeTemporaryDirectory()], {
      env: { HUNKYDORY_PUBLISH_STAGE: 'bogus' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown stage: bogus/);
    assertNoContainerStarted(result);
  });
});

describe('vsix-digest.sh', () => {
  function directoryWithOneVsix(contents: string): { directory: string; sha256: string } {
    const directory = makeTemporaryDirectory();
    writeVsix(directory, 'hunkydory-0.0.0.vsix', contents);
    return { directory, sha256: createHash('sha256').update(contents).digest('hex') };
  }

  test('prints the digest node computes for the same bytes', () => {
    // node's crypto is the oracle rather than a hard-coded string, for the
    // same reason README.md gives for building patch fixtures with git: an
    // expected value typed by hand can itself be wrong.
    const { directory, sha256 } = directoryWithOneVsix('some bytes');
    const result = run('vsix-digest.sh', [directory]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), sha256);
  });

  test('accepts the digest it just printed', () => {
    const { directory, sha256 } = directoryWithOneVsix('some bytes');
    const result = run('vsix-digest.sh', [directory, sha256]);
    assert.equal(result.status, 0);
  });

  test('rejects a digest for different bytes, and says which is which', () => {
    const { directory, sha256 } = directoryWithOneVsix('some bytes');
    const other = createHash('sha256').update('other bytes').digest('hex');
    const result = run('vsix-digest.sh', [directory, other]);
    assert.equal(result.status, 1);
    // Both values are pinned, in order. Asserting only on the word
    // "expected" passed even when the message reported them the wrong way
    // round, which is the mistake most likely to be made here and the one
    // that would send a reader after the wrong file.
    assert.match(result.stderr, new RegExp(`is ${sha256}, expected ${other}`));
  });

  test('rejects being given no arguments, or too many', () => {
    const { directory, sha256 } = directoryWithOneVsix('some bytes');
    for (const args of [[], [directory, sha256, 'surplus']]) {
      const result = run('vsix-digest.sh', args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /usage/);
    }
  });

  test('rejects a directory that does not exist', () => {
    const absent = path.join(makeTemporaryDirectory(), 'absent');
    const result = run('vsix-digest.sh', [absent]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no such directory/);
  });

  test('rejects an empty expected digest rather than comparing it', () => {
    // An empty value means a workflow expression resolved to nothing -- a
    // renamed job, a dropped outputs: block -- which wants a different fix
    // from a genuine mismatch, so it gets a different message.
    const { directory } = directoryWithOneVsix('some bytes');
    const result = run('vsix-digest.sh', [directory, '']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /empty or malformed/);
  });

  test('rejects a 64-character value that is not hex', () => {
    const { directory } = directoryWithOneVsix('some bytes');
    const result = run('vsix-digest.sh', [directory, 'z'.repeat(64)]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /empty or malformed/);
  });

  test('rejects a directory that does not hold exactly one .vsix', () => {
    const empty = run('vsix-digest.sh', [makeTemporaryDirectory()]);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /expected one \.vsix .*got 0/);

    const directory = makeTemporaryDirectory();
    writeVsix(directory, 'one.vsix', 'a');
    writeVsix(directory, 'two.vsix', 'b');
    const several = run('vsix-digest.sh', [directory]);
    assert.equal(several.status, 1);
    assert.match(several.stderr, /expected one \.vsix .*got 2/);
  });
});
