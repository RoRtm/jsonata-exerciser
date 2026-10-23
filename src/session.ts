import * as vscode from 'vscode';
import * as path from 'node:path';
import { Evaluator, EvalResult, describeResult } from './core/evaluator';
import { Demo, DEMOS, demoInputText } from './core/demos';
import { parseInputComment, withInputComment } from './core/bindings';
import { MemFs, ResultContent } from './memfs';
import type { DiagnosticsManager } from './providers';

export const STATE_KEY = 'jsonataExerciser.lastSession';
const BINDINGS_KEY = 'jsonataExerciser.bindings';

export interface SessionSnapshot {
  open: boolean;
  expression: string;
  input: string;
  result: string;
  status: EvalResult['status'] | 'idle';
  ms?: number;
}

function cfg() {
  return vscode.workspace.getConfiguration('jsonataExerciser');
}

type Kind = 'json' | 'expr' | 'other';

/**
 * The Exerciser: three editors (input JSON | JSONata expression | live result) wired together.
 *
 * The input and the expression are linked independently: each can be a scratch document (virtual,
 * never prompts to save) or any real file. Evaluation runs on every edit (debounced) in a worker
 * thread, entirely locally.
 */
export class SessionManager implements vscode.Disposable {
  readonly inputUriDefault = vscode.Uri.parse(`${MemFs.scheme}:/input.json`);
  readonly exprUriDefault = vscode.Uri.parse(`${MemFs.scheme}:/expression.jsonata`);

  inputUri = this.inputUriDefault;
  exprUri = this.exprUriDefault;
  active = false;

  private evaluator = new Evaluator({ supersede: true });
  private timer?: NodeJS.Timeout;
  private persistTimer?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private status: vscode.StatusBarItem;
  private _last?: EvalResult;
  private _lastGoodInput: unknown;
  private runId = 0;
  private emitter = new vscode.EventEmitter<void>();
  /** Fires after every evaluation (used to refresh completions etc.). */
  readonly onDidEvaluate = this.emitter.event;

  constructor(
    private ctx: vscode.ExtensionContext,
    private memfs: MemFs,
    private result: ResultContent,
    private diag: DiagnosticsManager
  ) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = 'jsonataExerciser.open';
    this.status.text = '$(json) JSONata';
    this.status.tooltip = 'Open JSONata Exerciser';
    this.disposables.push(
      this.status,
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.active && this.isSessionUri(e.document.uri)) this.schedule();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('jsonataExerciser')) this.schedule();
      }),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        this.updateStatusVisibility();
        void this.followEditor(ed);
      })
    );
    this.updateStatusVisibility();
    // Start the evaluator thread in the background so the first evaluation is instant.
    const warm = setTimeout(() => this.evaluator.warmUp(), 500);
    this.disposables.push({ dispose: () => clearTimeout(warm) });
  }

  /** The status bar entry doubles as a "ready" signal: it appears as soon as the extension is active. */
  private updateStatusVisibility(): void {
    const lang = vscode.window.activeTextEditor?.document.languageId;
    if (this.active || lang === 'json' || lang === 'jsonc' || lang === 'jsonata') this.status.show();
    else this.status.hide();
  }

  isSessionUri(uri: vscode.Uri): boolean {
    return uri.toString() === this.inputUri.toString() || uri.toString() === this.exprUri.toString();
  }

  private isScratch(uri: vscode.Uri): boolean {
    return uri.scheme === MemFs.scheme;
  }

  get last(): EvalResult | undefined {
    return this._last;
  }

  /** Last syntactically valid input JSON (survives while the user is mid-edit). */
  get inputJson(): unknown {
    return this._lastGoodInput;
  }

  // ---------------------------------------------------------------- classification

  private kindOf(uri: vscode.Uri): Kind {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    const lang = doc?.languageId;
    const ext = path.extname(uri.path).toLowerCase();
    if (lang === 'jsonata' || ext === '.jsonata') return 'expr';
    if (lang === 'json' || lang === 'jsonc' || ext === '.json' || ext === '.jsonc') return 'json';
    return 'other';
  }

  // ---------------------------------------------------------------- bindings

  private bindings(): Record<string, string> {
    return this.ctx.workspaceState.get<Record<string, string>>(BINDINGS_KEY, {});
  }

  private rememberBinding(): void {
    if (this.isScratch(this.exprUri) || this.isScratch(this.inputUri)) return;
    const b = this.bindings();
    if (b[this.exprUri.toString()] === this.inputUri.toString()) return;
    b[this.exprUri.toString()] = this.inputUri.toString();
    void this.ctx.workspaceState.update(BINDINGS_KEY, b);
  }

  private async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  /** Input JSON bound to an expression file: `input:` header comment first, then remembered link. */
  async resolveBinding(exprUri: vscode.Uri): Promise<vscode.Uri | undefined> {
    if (this.isScratch(exprUri)) return undefined;
    try {
      const rel = parseInputComment(await this.getText(exprUri));
      if (rel) {
        const target = path.isAbsolute(rel) ? vscode.Uri.file(rel) : vscode.Uri.joinPath(exprUri, '..', rel);
        if (await this.exists(target)) return target;
      }
    } catch {
      /* unreadable: fall through to remembered binding */
    }
    const saved = this.bindings()[exprUri.toString()];
    if (saved) {
      const u = vscode.Uri.parse(saved);
      if (await this.exists(u)) return u;
    }
    return undefined;
  }

  /** User action: choose the JSON file for an expression file and remember it. */
  async bindInput(exprUri?: vscode.Uri): Promise<void> {
    const target = exprUri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target || this.isScratch(target) || this.kindOf(target) !== 'expr') {
      void vscode.window.showInformationMessage('Open or select a .jsonata file (saved on disk) first.');
      return;
    }
    const picked = await vscode.window.showOpenDialog({
      title: `Input JSON for ${path.basename(target.path)}`,
      defaultUri: vscode.Uri.joinPath(target, '..'),
      filters: { JSON: ['json', 'jsonc'] },
      canSelectMany: false
    });
    const input = picked?.[0];
    if (!input) return;
    const b = this.bindings();
    b[target.toString()] = input.toString();
    await this.ctx.workspaceState.update(BINDINGS_KEY, b);

    const choice = await vscode.window.showInformationMessage(
      'Also write the binding as an "input:" comment at the top of the expression, so it travels with the file (e.g. in git)?',
      'Write comment',
      'No'
    );
    if (choice === 'Write comment' && target.scheme === 'file' && input.scheme === 'file') {
      const rel = path.relative(path.dirname(target.fsPath), input.fsPath).split(path.sep).join('/');
      const doc = await vscode.workspace.openTextDocument(target);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        target,
        new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
        withInputComment(doc.getText(), rel.startsWith('.') ? rel : `./${rel}`)
      );
      await vscode.workspace.applyEdit(edit);
    }
    await this.link({ exprUri: target, inputUri: input });
  }

  // ---------------------------------------------------------------- opening & linking

  /**
   * Context-aware entry point (used by the Explorer/editor context menu and "Evaluate Now"):
   * a JSON file becomes the input, a .jsonata file becomes the expression; the other side is kept.
   */
  async openFrom(uri?: vscode.Uri): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target || target.scheme === ResultContent.scheme || this.isSessionUri(target)) {
      await this.open();
      return;
    }
    const kind = this.kindOf(target);
    if (kind === 'json') await this.link({ inputUri: target });
    else if (kind === 'expr') await this.link({ exprUri: target });
    else await this.open();
  }

  /** Change what the input and/or expression point to (opens the Exerciser if needed). */
  async link(patch: { inputUri?: vscode.Uri; exprUri?: vscode.Uri }): Promise<void> {
    await this.open({ ...patch });
  }

  async open(opts: { demo?: Demo; inputUri?: vscode.Uri; exprUri?: vscode.Uri } = {}): Promise<void> {
    this.status.text = '$(sync~spin) JSONata: opening...';
    this.status.show();
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'JSONata Exerciser: opening...' },
        () => this.openCore(opts)
      );
    } finally {
      if (!this._last) this.updateStatus(undefined);
      this.updateStatusVisibility();
    }
  }

  private async openCore(opts: { demo?: Demo; inputUri?: vscode.Uri; exprUri?: vscode.Uri }): Promise<void> {
    const wasActive = this.active;

    if (opts.demo) {
      this.inputUri = this.inputUriDefault;
      this.exprUri = this.exprUriDefault;
      await this.setContent(this.inputUri, demoInputText(opts.demo));
      await this.setContent(this.exprUri, opts.demo.expression);
    } else {
      if (opts.inputUri) this.inputUri = opts.inputUri;
      else if (!wasActive) this.inputUri = this.inputUriDefault;
      if (opts.exprUri) this.exprUri = opts.exprUri;
      else if (!wasActive) this.exprUri = this.exprUriDefault;

      // A new expression file brings its bound input along (header comment or remembered link).
      if (opts.exprUri && !opts.inputUri) {
        const bound = await this.resolveBinding(opts.exprUri);
        if (bound) this.inputUri = bound;
        else if (this.isScratch(this.inputUri)) {
          const visible = vscode.window.visibleTextEditors.find(
            (e) => !this.isScratch(e.document.uri) && e.document.uri.scheme !== ResultContent.scheme && this.kindOf(e.document.uri) === 'json'
          );
          if (visible) this.inputUri = visible.document.uri;
          else this.hintBind(opts.exprUri);
        }
      }
      await this.ensureScratch();
    }

    this.active = true;
    this.rememberBinding();
    await this.showPanes();
    this.status.show();
    await this.evaluateNow();
  }

  private hintBind(exprUri: vscode.Uri): void {
    void vscode.window
      .showInformationMessage(
        `No input JSON is linked to ${path.basename(exprUri.path)} yet. Showing the scratch input.`,
        'Choose JSON file...'
      )
      .then((c) => {
        if (c) void this.bindInput(exprUri);
      });
  }

  /**
   * Scratch documents live in memory only. This writes one to a real file (Save dialog) and links the
   * Exerciser to that file, so Ctrl+S / Save As behave as users expect.
   */
  async saveScratchAs(uri?: vscode.Uri): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target || !this.isScratch(target)) {
      await vscode.commands.executeCommand('workbench.action.files.save');
      return;
    }
    const isExpr = target.toString() === this.exprUriDefault.toString();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const dest = await vscode.window.showSaveDialog({
      title: isExpr ? 'Save JSONata expression as' : 'Save input JSON as',
      defaultUri: root ? vscode.Uri.joinPath(root, isExpr ? 'expression.jsonata' : 'input.json') : undefined,
      filters: isExpr ? { JSONata: ['jsonata'] } : { JSON: ['json'] },
      saveLabel: 'Save'
    });
    if (!dest) return;
    try {
      await vscode.workspace.fs.writeFile(dest, new TextEncoder().encode(await this.getText(target)));
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Could not save ${path.basename(dest.path)}: ${e.message ?? e}`);
      return;
    }
    await this.link(isExpr ? { exprUri: dest, inputUri: this.inputUri } : { inputUri: dest, exprUri: this.exprUri });
    void vscode.window.setStatusBarMessage(`Saved ${path.basename(dest.path)} and linked it to the Exerciser`, 3000);
  }

  /**
   * After a VS Code restart the editor tabs come back but the session is gone. If the result tab was
   * restored, re-attach to whatever input / expression tabs are showing and resume live evaluation.
   */
  async resumeFromTabs(): Promise<void> {
    if (this.active) return;
    const groups = vscode.window.tabGroups.all;
    const hadResult = groups.some((g) =>
      g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.scheme === ResultContent.scheme)
    );
    if (!hadResult) return;
    const pick = (col: vscode.ViewColumn, kind: Kind): vscode.Uri | undefined => {
      const tab = groups.find((g) => g.viewColumn === col)?.activeTab;
      if (tab?.input instanceof vscode.TabInputText && this.kindOf(tab.input.uri) === kind) return tab.input.uri;
      return undefined;
    };
    await this.open({ inputUri: pick(vscode.ViewColumn.One, 'json'), exprUri: pick(vscode.ViewColumn.Two, 'expr') });
  }

  /** Back to the virtual scratch input/expression. */
  async resetScratch(): Promise<void> {
    await this.open({ inputUri: this.inputUriDefault, exprUri: this.exprUriDefault });
  }

  private async ensureScratch(): Promise<void> {
    const saved = this.ctx.globalState.get<{ input?: string; expression?: string }>(STATE_KEY);
    const fallback = DEMOS[0];
    if (this.inputUri.toString() === this.inputUriDefault.toString() && !this.fileExists(this.inputUri)) {
      await this.setContent(this.inputUri, saved?.input ?? demoInputText(fallback));
    }
    if (this.exprUri.toString() === this.exprUriDefault.toString() && !this.fileExists(this.exprUri)) {
      await this.setContent(this.exprUri, saved?.expression ?? (this.isScratch(this.inputUri) ? fallback.expression : '$'));
    }
  }

  /**
   * Show input | expression | result in columns 1 | 2 | 3. The layout is only (re)created when the
   * three groups do not exist yet, so we never rearrange an already working window.
   */
  private async showPanes(): Promise<void> {
    if (vscode.window.tabGroups.all.length < 3) {
      await vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 0,
        groups: [{ size: 0.4 }, { groups: [{ size: 0.55 }, { size: 0.45 }], size: 0.6 }]
      });
    }
    const inputDoc = await vscode.workspace.openTextDocument(this.inputUri);
    const exprDoc = await vscode.workspace.openTextDocument(this.exprUri);
    const resultDoc = await vscode.workspace.openTextDocument(ResultContent.uri);
    // Always (re)show all three panes so a closed editor comes back.
    await vscode.window.showTextDocument(inputDoc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true, preview: false });
    await vscode.window.showTextDocument(resultDoc, { viewColumn: vscode.ViewColumn.Three, preserveFocus: true, preview: false });
    if (resultDoc.languageId !== 'jsonc') await vscode.languages.setTextDocumentLanguage(resultDoc, 'jsonc').then(undefined, () => undefined);
    await vscode.window.showTextDocument(exprDoc, { viewColumn: vscode.ViewColumn.Two, preview: false });
  }

  /**
   * Follow what the user shows in the panes: a JSON file opened anywhere is moved into the left
   * group and becomes the input; a .jsonata file is moved into the second group and becomes the
   * expression.
   */
  private async followEditor(ed: vscode.TextEditor | undefined): Promise<void> {
    if (!this.active || !ed || !cfg().get<boolean>('followEditors', true)) return;
    const uri = ed.document.uri;
    if (uri.scheme === ResultContent.scheme || this.isSessionUri(uri)) return;
    if (uri.scheme !== 'file' && uri.scheme !== 'untitled' && uri.scheme !== MemFs.scheme) return;
    const kind = this.kindOf(uri);

    // A JSON / .jsonata file opened anywhere else (e.g. from the Explorer into the focused group)
    // is moved into its proper pane; moving re-triggers this handler in the right column.
    if (kind === 'json' && ed.viewColumn !== undefined && ed.viewColumn !== vscode.ViewColumn.One) {
      if (vscode.window.tabGroups.all.length >= 3) {
        await vscode.commands.executeCommand('workbench.action.moveEditorToFirstGroup');
        return;
      }
    }
    if (kind === 'expr' && ed.viewColumn !== undefined && ed.viewColumn !== vscode.ViewColumn.Two) {
      if (vscode.window.tabGroups.all.length >= 3) {
        await vscode.commands.executeCommand('workbench.action.moveEditorToSecondGroup');
        return;
      }
    }

    if (kind === 'json' && ed.viewColumn === vscode.ViewColumn.One) {
      this.inputUri = uri;
      this.rememberBinding();
      await this.evaluateNow();
    } else if (kind === 'expr' && ed.viewColumn === vscode.ViewColumn.Two) {
      this.exprUri = uri;
      const bound = await this.resolveBinding(uri);
      if (bound && bound.toString() !== this.inputUri.toString()) {
        this.inputUri = bound;
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(bound), {
          viewColumn: vscode.ViewColumn.One,
          preserveFocus: true,
          preview: false
        });
      }
      this.rememberBinding();
      await this.evaluateNow();
    }
  }

  private fileExists(uri: vscode.Uri): boolean {
    try {
      this.memfs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  /** Replace the full content of a document (open or not). */
  async setContent(uri: vscode.Uri, text: string): Promise<void> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc) {
      if (doc.getText() === text) return;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
      await vscode.workspace.applyEdit(edit);
      if (uri.scheme === MemFs.scheme) await doc.save();
    } else if (uri.scheme === MemFs.scheme) {
      this.memfs.writeText(uri, text);
    } else {
      throw new Error(`Document ${uri.toString()} is not open`);
    }
  }

  async getText(uri: vscode.Uri): Promise<string> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc) return doc.getText();
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  }

  // ------------------------------------------------------------- evaluation

  schedule(): void {
    if (!cfg().get<boolean>('autoEvaluate', true)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.evaluateNow(), cfg().get<number>('debounceMs', 150));
  }

  async evaluateNow(): Promise<EvalResult | undefined> {
    if (!this.active) return undefined;
    if (this.timer) clearTimeout(this.timer);
    const run = ++this.runId;
    let expression: string;
    let input: string;
    try {
      expression = await this.getText(this.exprUri);
      input = await this.getText(this.inputUri);
    } catch (e: any) {
      this.render(`// Cannot read session documents: ${e.message}`);
      return undefined;
    }

    try {
      this._lastGoodInput = input.trim() ? JSON.parse(input) : undefined;
    } catch {
      /* keep previous good input for IntelliSense */
    }

    if (expression.trim() === '') {
      this._last = undefined;
      this.diag.setRuntime(this.exprUri, undefined);
      this.render('// Type a JSONata expression in the expression editor.');
      this.updateStatus(undefined);
      this.emitter.fire();
      this.persistSoon(input, expression);
      return undefined;
    }

    const r = await this.evaluator.evaluate({
      expression,
      input,
      timeoutMs: cfg().get<number>('evaluationTimeoutMs', 5000)
    });
    if (r.status === 'cancelled' || run !== this.runId) return r; // superseded by a newer keystroke

    this._last = r;
    this.render(this.renderResult(r));
    this.diag.setRuntime(this.exprUri, r, expression);
    this.updateStatus(r);
    this.emitter.fire();
    this.persistSoon(input, expression);
    return r;
  }

  private renderResult(r: EvalResult): string {
    switch (r.status) {
      case 'ok':
        return r.text;
      case 'empty':
        return '// No result: the expression evaluated to undefined (nothing matched).';
      case 'timeout':
        return `// Aborted after ${r.ms} ms (limit: jsonataExerciser.evaluationTimeoutMs). Possible endless recursion?`;
      case 'cancelled':
        return this.result.current;
      case 'error':
        return describeResult(r)
          .split('\n')
          .map((l) => `// ${l}`)
          .join('\n');
    }
  }

  private render(text: string): void {
    this.result.set(text);
  }

  private linkLabel(): string {
    const name = (u: vscode.Uri) => (this.isScratch(u) ? 'scratch' : path.basename(u.path));
    return `Input: ${name(this.inputUri)} | Expression: ${name(this.exprUri)}`;
  }

  private updateStatus(r: EvalResult | undefined): void {
    const links = this.linkLabel();
    if (!r) {
      this.status.text = '$(json) JSONata';
      this.status.tooltip = `JSONata Exerciser\n${links}`;
      this.status.backgroundColor = undefined;
      return;
    }
    if (r.status === 'ok' || r.status === 'empty') {
      this.status.text = `$(check) JSONata ${r.ms} ms`;
      this.status.tooltip = `${r.status === 'empty' ? 'Evaluated: no result' : 'Evaluated successfully'}\n${links}`;
      this.status.backgroundColor = undefined;
    } else {
      this.status.text = `$(error) JSONata ${r.status === 'error' ? 'error' : r.status}`;
      this.status.tooltip = `${describeResult(r)}\n${links}`;
      this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
  }

  private persistSoon(input: string, expression: string): void {
    // Only scratch documents are remembered across restarts; real files live on disk.
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      const saved = { ...(this.ctx.globalState.get<{ input?: string; expression?: string }>(STATE_KEY) ?? {}) };
      if (this.isScratch(this.inputUri)) saved.input = input;
      if (this.isScratch(this.exprUri)) saved.expression = expression;
      void this.ctx.globalState.update(STATE_KEY, saved);
    }, 800);
    // keep virtual docs saved so closing the tab never prompts (real files are never auto-saved)
    for (const uri of [this.inputUri, this.exprUri]) {
      const d = vscode.workspace.textDocuments.find((x) => x.uri.toString() === uri.toString());
      if (d?.isDirty && this.isScratch(uri)) void d.save();
    }
  }

  // --------------------------------------------------------------- AI hooks

  async snapshot(): Promise<SessionSnapshot> {
    if (!this.active) {
      return { open: false, expression: '', input: '', result: '', status: 'idle' };
    }
    const [expression, input] = await Promise.all([this.getText(this.exprUri), this.getText(this.inputUri)]);
    return {
      open: true,
      expression,
      input,
      result: this._last ? describeResult(this._last) : '',
      status: this._last?.status ?? 'idle',
      ms: this._last?.ms
    };
  }

  /** Replace expression and/or input and wait for the new result. */
  async update(patch: { expression?: string; input?: string }): Promise<EvalResult | undefined> {
    if (!this.active) await this.open();
    if (patch.input !== undefined) await this.setContent(this.inputUri, patch.input);
    if (patch.expression !== undefined) await this.setContent(this.exprUri, patch.expression);
    return this.evaluateNow();
  }

  async copyResult(): Promise<void> {
    await vscode.env.clipboard.writeText(this.result.current);
    void vscode.window.setStatusBarMessage('JSONata result copied', 2000);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.evaluator.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
  }
}
