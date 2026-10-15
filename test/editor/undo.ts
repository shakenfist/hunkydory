/**
 * Undo and redo against a real editor host.
 *
 * Run by tools/editor-test.sh, never by `npm test`: this needs the vscode
 * module, which only exists inside an extension host, and an undo stack, which
 * only exists inside an editor. The file name deliberately does not end in
 * .test.ts, so node's own runner never picks it up.
 *
 * The bug this guards against (#79): a live recount was an undo step of its
 * own, so undo reverted the header, the recount put it straight back, and the
 * user could never undo past it to the edit they meant.
 */

import assert from 'node:assert/strict';

import * as vscode from 'vscode';

/**
 * How long to wait for a recount that must not happen. Comfortably more than
 * the extension's 200ms debounce, so a recount that was going to fire has.
 */
const QUIET_MS = 800;

// No final newline, so this exercises undo and nothing else: how the last
// line of a document is read is a counting question with tests of its own.
const PATCH = ['--- a/f', '+++ b/f', '@@ -1,3 +1,3 @@', ' alpha', '-beta', '+gamma', ' delta'];
const AFTER_EDIT = /^@@ -1,3 \+1,4 @@$/m;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(50);
  }
}

async function freshEditor(): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument({
    language: 'diff',
    content: PATCH.join('\n'),
  });
  const editor = await vscode.window.showTextDocument(document);
  const extension = vscode.extensions.all.find((e) => e.packageJSON.name === 'hunkydory');
  assert.ok(extension, 'the extension under test is loaded');
  await extension.activate();
  return editor;
}

/** Add a line to the hunk body, which makes its header one short. */
async function addBodyLine(editor: vscode.TextEditor): Promise<void> {
  const end = editor.document.lineAt(5).range.end;
  editor.selection = new vscode.Selection(end, end);
  await vscode.commands.executeCommand('type', { text: '\n+extra' });
}

async function undo(document: vscode.TextDocument): Promise<string> {
  await vscode.commands.executeCommand('undo');
  await sleep(QUIET_MS);
  return document.getText();
}

async function liveFixJoinsTheEditsUndoStep(): Promise<void> {
  const editor = await freshEditor();
  const document = editor.document;
  const original = document.getText();

  await addBodyLine(editor);
  await waitFor(() => AFTER_EDIT.test(document.getText()), 'the live recount');
  const fixed = document.getText();

  assert.equal(await undo(document), original, 'one undo takes back the edit and its header');

  await vscode.commands.executeCommand('redo');
  await sleep(QUIET_MS);
  assert.equal(document.getText(), fixed, 'redo puts both back');
}

async function undoNeverRecounts(): Promise<void> {
  // The explicit command always takes an undo step of its own, which is the
  // case the undo check exists for: VS Code can also close the user's step
  // before a live fix lands, but not on demand.
  const editor = await freshEditor();
  const document = editor.document;
  const original = document.getText();

  await addBodyLine(editor);
  const edited = document.getText();
  await vscode.commands.executeCommand('hunkydory.recount');
  await waitFor(() => AFTER_EDIT.test(document.getText()), 'the command recount');

  assert.equal(await undo(document), edited, 'the first undo reverts the header, for good');
  assert.equal(await undo(document), original, 'the second undo reaches the edit');
}

/** Entry point for --extensionTestsPath. A rejection fails the run. */
export async function run(): Promise<void> {
  const tests: Array<[string, () => Promise<void>]> = [
    ['a live fix joins the undo step of the edit that prompted it', liveFixJoinsTheEditsUndoStep],
    ['undo never prompts a recount', undoNeverRecounts],
  ];
  for (const [name, test] of tests) {
    try {
      await test();
      console.log(`ok   ${name}`);
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  }
}
