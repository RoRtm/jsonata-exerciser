import * as vscode from 'vscode';
import { Evaluator } from './core/evaluator';
import { jsonNodeAt, matchResult, probeAllParts, ProbeSet, toJsonataPath, TraceMatch } from './core/navigate';
import { ResultContent } from './memfs';
import type { SessionManager } from './session';

function cfg() {
  return vscode.workspace.getConfiguration('jsonataExerciser');
}

/**
 * Navigation between data and expression:
 *  - copy / insert the JSONata path of the JSON value under the cursor
 *  - click a value in the result pane to highlight the part of the expression that produced it
 */
export class Navigator implements vscode.Disposable {
  private evaluator = new Evaluator({ supersede: true });
  private mark = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    border: '1px solid',
    borderColor: new vscode.ThemeColor('editor.findMatchBorder'),
    borderRadius: '2px'
  });
  private ghost = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic', margin: '0 0 0 2em' }
  });
  private cache?: { key: string; set: ProbeSet };
  private last?: { from: number; to: number; version: number; index: number };
  private shownUri?: string;
  private timer?: NodeJS.Timeout;
  private runId = 0;
  private disposables: vscode.Disposable[] = [];

  constructor(private session: SessionManager) {
    this.disposables.push(
      this.mark,
      this.ghost,
      vscode.window.onDidChangeTextEditorSelection((e) => {
        const doc = e.textEditor.document;
        if (doc.uri.scheme !== ResultContent.scheme || !cfg().get<boolean>('navigate.live', true)) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.reveal(e.textEditor, false), 300);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.shownUri === e.document.uri.toString()) this.clear();
      })
    );
  }

  clear(): void {
    this.runId++;
    this.shownUri = undefined;
    for (const ed of vscode.window.visibleTextEditors) {
      ed.setDecorations(this.mark, []);
      ed.setDecorations(this.ghost, []);
    }
  }

  // ------------------------------------------------------------ input -> path

  private pathAtCursor(): { path: string; label: string } | undefined {
    const ed = vscode.window.activeTextEditor;
    if (!ed || (ed.document.languageId !== 'json' && ed.document.languageId !== 'jsonc')) {
      void vscode.window.showInformationMessage('Place the cursor on a value or key in a JSON file first.');
      return undefined;
    }
    const node = jsonNodeAt(ed.document.getText(), ed.document.offsetAt(ed.selection.active));
    if (!node) {
      void vscode.window.showInformationMessage('No JSON value at the cursor.');
      return undefined;
    }
    const path = toJsonataPath(node.path, cfg().get<string>('navigate.arrayIndexes', 'omit') === 'include');
    return { path, label: path };
  }

  async copyPath(): Promise<void> {
    const p = this.pathAtCursor();
    if (!p) return;
    await vscode.env.clipboard.writeText(p.path);
    void vscode.window.setStatusBarMessage(`Copied JSONata path: ${p.path}`, 3000);
  }

  async insertPath(): Promise<void> {
    const p = this.pathAtCursor();
    if (!p) return;
    const target =
      vscode.window.visibleTextEditors.find((e) => this.session.active && e.document.uri.toString() === this.session.exprUri.toString()) ??
      vscode.window.visibleTextEditors.find((e) => e.document.languageId === 'jsonata');
    if (!target) {
      await vscode.env.clipboard.writeText(p.path);
      void vscode.window.showInformationMessage(`No expression editor is open. Copied the path instead: ${p.path}`);
      return;
    }
    await target.edit((b) => target.selections.forEach((s) => b.replace(s, p.path)));
    await vscode.window.showTextDocument(target.document, { viewColumn: target.viewColumn, preserveFocus: false });
    void vscode.window.setStatusBarMessage(`Inserted JSONata path: ${p.path}`, 3000);
  }

  // ------------------------------------------------------------ result -> expression

  /** Command entry point: highlights the source of the result value at the cursor; again for the next candidate. */
  async revealSource(): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== ResultContent.scheme) {
      void vscode.window.showInformationMessage('Click a value in the Exerciser result pane first.');
      return;
    }
    await this.reveal(ed, true);
  }

  private async reveal(ed: vscode.TextEditor, explicit: boolean): Promise<void> {
    if (!this.session.active) return;
    const doc = ed.document;
    const text = doc.getText();
    const node = jsonNodeAt(text, doc.offsetAt(ed.selection.active));
    if (!node) {
      this.clear();
      return;
    }
    let target: unknown;
    try {
      target = JSON.parse(text.slice(node.start, node.end));
    } catch {
      this.clear();
      return;
    }
    const run = ++this.runId;
    let expression: string;
    let input: string;
    try {
      [expression, input] = await Promise.all([this.session.getText(this.session.exprUri), this.session.getText(this.session.inputUri)]);
    } catch {
      return;
    }

    const key = expression + '\u0000' + input;
    let set = this.cache?.key === key ? this.cache.set : undefined;
    if (!set) {
      set = await probeAllParts(this.evaluator, { expression, input, timeoutMs: cfg().get<number>('evaluationTimeoutMs', 5000) * 4 });
      if (run !== this.runId) return;
      if (!set) {
        this.clear();
        return;
      }
      this.cache = { key, set };
    }

    const lastKey = [...node.path].reverse().find((s): s is string => typeof s === 'string');
    const matches = matchResult(expression, set.probes, target, { key: lastKey, atRoot: node.path.length === 0 });
    if (matches.length === 0) {
      this.clear();
      if (explicit) {
        void vscode.window.showInformationMessage(
          'No part of the expression produces exactly this value. It may be assembled from several parts (for example a string concatenation) or rounded.'
        );
      }
      return;
    }

    const same = this.last && this.last.from === node.start && this.last.to === node.end && this.last.version === doc.version;
    const index = explicit && same ? (this.last!.index + 1) % matches.length : same ? Math.min(this.last!.index, matches.length - 1) : 0;
    this.last = { from: node.start, to: node.end, version: doc.version, index };
    this.show(matches, index, expression, node.path.length ? node.path.join('.') : 'result', set.truncated);
  }

  private show(matches: TraceMatch[], index: number, expression: string, label: string, truncated: boolean): void {
    const exprEd = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === this.session.exprUri.toString());
    if (!exprEd) return;
    const m = matches[index];
    const doc = exprEd.document;
    if (doc.getText() !== expression) return;
    const range = new vscode.Range(doc.positionAt(m.start), doc.positionAt(m.end));
    const endLine = doc.lineAt(range.end.line);
    const at = new vscode.Position(range.end.line, endLine.text.length);
    const note =
      `◂ produces ${label}` +
      (m.exact ? '' : ' (as one item)') +
      (matches.length > 1 ? ` · match ${index + 1}/${matches.length}, run "Reveal Expression Part" again for the next` : '') +
      (truncated ? ' · large expression, some parts not checked' : '');
    this.shownUri = doc.uri.toString();
    exprEd.setDecorations(this.mark, [range]);
    exprEd.setDecorations(this.ghost, [{ range: new vscode.Range(at, at), renderOptions: { after: { contentText: note.replace(/ /g, ' ') } } }]);
    exprEd.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.evaluator.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
