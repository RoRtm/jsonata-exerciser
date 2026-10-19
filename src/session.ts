import * as vscode from 'vscode';
import { Evaluator, EvalResult, describeResult } from './core/evaluator';
import { Demo, DEMOS, demoInputText } from './core/demos';
import { MemFs, ResultContent } from './memfs';
import type { DiagnosticsManager } from './providers';

const STATE_KEY = 'jsonataExerciser.lastSession';

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

/**
 * The Exerciser: three editors (input JSON | JSONata expression | live result) wired together.
 * Evaluation runs on every edit (debounced) in a worker thread, entirely locally.
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
    this.disposables.push(
      this.status,
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!this.active) return;
        if (this.isSessionUri(e.document.uri)) this.schedule();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('jsonataExerciser')) this.schedule();
      })
    );
  }

  isSessionUri(uri: vscode.Uri): boolean {
    return uri.toString() === this.inputUri.toString() || uri.toString() === this.exprUri.toString();
  }

  get last(): EvalResult | undefined {
    return this._last;
  }

  /** Last syntactically valid input JSON (survives while the user is mid-edit). */
  get inputJson(): unknown {
    return this._lastGoodInput;
  }

  // ---------------------------------------------------------------- opening

  async open(opts: { demo?: Demo; inputUri?: vscode.Uri; exprUri?: vscode.Uri } = {}): Promise<void> {
    const custom = !!(opts.inputUri && opts.exprUri);
    this.inputUri = custom ? opts.inputUri! : this.inputUriDefault;
    this.exprUri = custom ? opts.exprUri! : this.exprUriDefault;

    if (!custom) {
      const needsInit = !this.fileExists(this.inputUri) || !this.fileExists(this.exprUri);
      if (opts.demo) {
        await this.setContent(this.inputUri, demoInputText(opts.demo));
        await this.setContent(this.exprUri, opts.demo.expression);
      } else if (needsInit) {
        const saved = this.ctx.globalState.get<{ input: string; expression: string }>(STATE_KEY);
        const fallback = DEMOS[0];
        await this.setContent(this.inputUri, saved?.input ?? demoInputText(fallback));
        await this.setContent(this.exprUri, saved?.expression ?? fallback.expression);
      }
    }
    this.active = true;

    await vscode.commands.executeCommand('vscode.setEditorLayout', {
      orientation: 0,
      groups: [{ size: 0.4 }, { groups: [{ size: 0.55 }, { size: 0.45 }], size: 0.6 }]
    });
    const inputDoc = await vscode.workspace.openTextDocument(this.inputUri);
    const exprDoc = await vscode.workspace.openTextDocument(this.exprUri);
    const resultDoc = await vscode.workspace.openTextDocument(ResultContent.uri);
    await vscode.window.showTextDocument(inputDoc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true, preview: false });
    await vscode.window.showTextDocument(resultDoc, { viewColumn: vscode.ViewColumn.Three, preserveFocus: true, preview: false });
    if (resultDoc.languageId !== 'jsonc') await vscode.languages.setTextDocumentLanguage(resultDoc, 'jsonc');
    await vscode.window.showTextDocument(exprDoc, { viewColumn: vscode.ViewColumn.Two, preview: false });

    this.status.show();
    await this.evaluateNow();
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

  private updateStatus(r: EvalResult | undefined): void {
    if (!r) {
      this.status.text = '$(symbol-event) JSONata';
      this.status.tooltip = 'JSONata Exerciser';
      this.status.backgroundColor = undefined;
      return;
    }
    if (r.status === 'ok' || r.status === 'empty') {
      this.status.text = `$(check) JSONata ${r.ms} ms`;
      this.status.tooltip = r.status === 'empty' ? 'Evaluated: no result' : 'Evaluated successfully';
      this.status.backgroundColor = undefined;
    } else {
      this.status.text = `$(error) JSONata ${r.status === 'error' ? 'error' : r.status}`;
      this.status.tooltip = describeResult(r);
      this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
  }

  private persistSoon(input: string, expression: string): void {
    if (this.exprUri.toString() !== this.exprUriDefault.toString()) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      void this.ctx.globalState.update(STATE_KEY, { input, expression });
    }, 800);
    // keep virtual docs saved so closing the tab never prompts
    for (const uri of [this.inputUri, this.exprUri]) {
      const d = vscode.workspace.textDocuments.find((x) => x.uri.toString() === uri.toString());
      if (d?.isDirty && uri.scheme === MemFs.scheme) void d.save();
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
