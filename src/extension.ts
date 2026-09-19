/**
 * VS Code wiring.
 *
 * All of the diff logic lives in diff.ts and recount.ts, which have no vscode
 * import; this file is only about when to run it and how to apply the result.
 */

import * as vscode from 'vscode';

import { formatRange, parseHunks } from './diff';
import { computeFixes, type HeaderFix, looksLikeDiff } from './recount';

/** How long to wait after a keystroke before rewriting headers. */
const DEBOUNCE_MS = 200;

/**
 * Documents we are currently editing ourselves.
 *
 * Applying a fix fires onDidChangeTextDocument again, so without this guard a
 * single keystroke would loop.
 */
const applying = new Set<string>();

const timers = new Map<string, NodeJS.Timeout>();

let diagnostics: vscode.DiagnosticCollection;
let statusBar: vscode.StatusBarItem;

function config() {
  return vscode.workspace.getConfiguration('hunkydory');
}

/**
 * True if this document is a patch we should look after on our own initiative.
 *
 * The language id, and nothing else. Matching the file name as well claimed
 * files this extension is not even loaded for: activationEvents is
 * `onLanguage:diff`, so whether a `.patch` file opened as something other than
 * a diff got rewritten depended on whether an unrelated diff had already woken
 * us up. Under `hunkydory.mode: onSave` that means rewriting bytes on disk in
 * a file the user had explicitly told the editor was not a diff -- the one
 * thing a patch tool must never do to a file it was not invited into.
 *
 * VS Code's built-in diff language already claims `.patch`, `.diff` and
 * `.rej`, so this costs nothing in the ordinary case. The explicit command is
 * the escape hatch for a file whose language has been set to something else on
 * purpose: it looks at the content instead. See recountCommand.
 */
function isPatch(document: vscode.TextDocument): boolean {
  return document.languageId === 'diff';
}

function documentLines(document: vscode.TextDocument): string[] {
  const lines: string[] = [];
  for (let i = 0; i < document.lineCount; i += 1) {
    lines.push(document.lineAt(i).text);
  }
  return lines;
}

/**
 * Drop fixes for a header the user is currently sitting on.
 *
 * Rewriting the line someone is typing into is hostile, and they may well be
 * correcting it by hand. We will catch it on the next edit or on save.
 */
function excludeCursorLine(fixes: HeaderFix[], editor: vscode.TextEditor | undefined): HeaderFix[] {
  if (!editor) {
    return fixes;
  }
  const occupied = new Set(editor.selections.map((s) => s.active.line));
  return fixes.filter((fix) => !occupied.has(fix.line));
}

async function applyFixes(document: vscode.TextDocument, fixes: HeaderFix[]): Promise<number> {
  if (fixes.length === 0) {
    return 0;
  }

  const key = document.uri.toString();
  const edit = new vscode.WorkspaceEdit();
  for (const fix of fixes) {
    // Replace only the header line, so the cursor and undo history elsewhere
    // in the file are left alone.
    const line = document.lineAt(fix.line);
    edit.replace(document.uri, line.range, fix.corrected);
  }

  applying.add(key);
  try {
    const ok = await vscode.workspace.applyEdit(edit);
    return ok ? fixes.length : 0;
  } finally {
    applying.delete(key);
  }
}

function refreshDiagnostics(document: vscode.TextDocument): void {
  if (!isPatch(document)) {
    return;
  }
  if (!config().get<boolean>('diagnostics', true)) {
    diagnostics.set(document.uri, []);
    return;
  }

  const found: vscode.Diagnostic[] = [];
  for (const fix of computeFixes(documentLines(document))) {
    const range = document.lineAt(fix.line).range;
    const diagnostic = new vscode.Diagnostic(
      range,
      `Hunk header does not match its body; should be ${fix.corrected.split(' @@')[0]} @@`,
      vscode.DiagnosticSeverity.Warning,
    );
    diagnostic.source = 'hunkydory';
    found.push(diagnostic);
  }
  diagnostics.set(document.uri, found);
}

function refreshStatusBar(editor: vscode.TextEditor | undefined): void {
  if (!editor || !isPatch(editor.document) || !config().get<boolean>('statusBar', true)) {
    statusBar.hide();
    return;
  }

  const line = editor.selection.active.line;
  const hunks = parseHunks(documentLines(editor.document));
  const hunk = hunks.find((h) => line >= h.headerLine && line < h.bodyEnd);
  if (!hunk) {
    statusBar.hide();
    return;
  }

  statusBar.text =
    `$(diff) -${formatRange(hunk.oldStart, hunk.oldCount)} ` +
    `+${formatRange(hunk.newStart, hunk.newCount)}`;
  statusBar.tooltip =
    `Hunk ${hunks.indexOf(hunk) + 1} of ${hunks.length}: ` +
    `${hunk.oldCount} line(s) before, ${hunk.newCount} after`;
  statusBar.show();
}

function scheduleRecount(document: vscode.TextDocument): void {
  const key = document.uri.toString();
  const existing = timers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  timers.set(
    key,
    setTimeout(async () => {
      timers.delete(key);
      if (document.isClosed) {
        return;
      }
      const editor = vscode.window.visibleTextEditors.find((e) => e.document === document);
      const fixes = excludeCursorLine(computeFixes(documentLines(document)), editor);
      await applyFixes(document, fixes);
      refreshDiagnostics(document);
    }, DEBOUNCE_MS),
  );
}

async function recountCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  // Asked for by name, so the content decides rather than the language id.
  // isPatch deliberately ignores a file named like a patch but opened as
  // something else; running the command on one is the user saying they meant
  // it, and a buffer holding hunk headers is a patch whatever it is called.
  if (!isPatch(editor.document) && !looksLikeDiff(editor.document.getText())) {
    vscode.window.showWarningMessage('Hunky Dory: this does not look like a patch file.');
    return;
  }

  // The command is explicit, so fix the cursor line too.
  const fixes = computeFixes(documentLines(editor.document));
  const applied = await applyFixes(editor.document, fixes);
  refreshDiagnostics(editor.document);

  vscode.window.showInformationMessage(
    applied === 0
      ? 'Hunky Dory: all hunk headers were already correct.'
      : `Hunky Dory: corrected ${applied} hunk header${applied === 1 ? '' : 's'}.`,
  );
}

export function activate(context: vscode.ExtensionContext): void {
  diagnostics = vscode.languages.createDiagnosticCollection('hunkydory');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(diagnostics, statusBar);

  context.subscriptions.push(vscode.commands.registerCommand('hunkydory.recount', recountCommand));

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const document = event.document;
      if (!isPatch(document) || applying.has(document.uri.toString())) {
        return;
      }
      if (config().get<string>('mode', 'live') === 'live') {
        scheduleRecount(document);
      } else {
        refreshDiagnostics(document);
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument((event) => {
      if (!isPatch(event.document) || config().get<string>('mode', 'live') === 'manual') {
        return;
      }
      // Returning the edits through waitUntil lets them land in the file being
      // written, rather than dirtying the buffer again straight after a save.
      const fixes = computeFixes(documentLines(event.document));
      event.waitUntil(
        Promise.resolve(
          fixes.map((fix) =>
            vscode.TextEdit.replace(event.document.lineAt(fix.line).range, fix.corrected),
          ),
        ),
      );
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refreshDiagnostics),
    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.delete(document.uri)),
    vscode.window.onDidChangeActiveTextEditor(refreshStatusBar),
    vscode.window.onDidChangeTextEditorSelection((event) => refreshStatusBar(event.textEditor)),
  );

  for (const document of vscode.workspace.textDocuments) {
    refreshDiagnostics(document);
  }
  refreshStatusBar(vscode.window.activeTextEditor);
}

export function deactivate(): void {
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
}
