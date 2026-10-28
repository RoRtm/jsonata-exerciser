import * as vscode from 'vscode';
import * as path from 'node:path';
import { Demo, DEMOS, demoInputText } from './core/demos';
import { testsForDemo } from './core/demotests';
import { Evaluator } from './core/evaluator';
import { scanJson } from './core/navigate';
import {
  appendCaseText,
  CaseOutcome,
  caseFromResult,
  formatReport,
  parseTestFile,
  runCase,
  Summary,
  summarize,
  TestCase,
  testFileSkeleton,
  testFileWithResult,
  testPathFor
} from './core/testing';
import type { SessionManager } from './session';

function cfg() {
  return vscode.workspace.getConfiguration('jsonataExerciser');
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const encode = (s: string) => new TextEncoder().encode(s);

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function readText(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  return open ? open.getText() : decode(await vscode.workspace.fs.readFile(uri));
}

interface Source {
  label: string;
  /** Real test file, if any. */
  testUri?: vscode.Uri;
  cases: TestCase[];
  problems: string[];
  /** Resolves a case's input (relative `inputFile`s are read next to the test file). */
  loadInput: (c: TestCase) => Promise<string | undefined>;
}

interface Target {
  uri: vscode.Uri;
  exists: boolean;
  /** A file on disk (false: an in-memory scratch document). */
  real: boolean;
  /** Folder that `inputFile` paths are relative to when it is not the folder of the test file. */
  baseDir?: vscode.Uri;
  exprName: string;
}

interface State {
  summary: Summary;
  outcomes: CaseOutcome[];
  label: string;
}

/**
 * Test cases for expressions: Test Explorer integration for `*.test.json` files, a live summary
 * (CodeLens) above the expression, commands to add cases and to export the demos with their tests.
 */
export class TestManager implements vscode.Disposable, vscode.CodeLensProvider {
  private controller = vscode.tests.createTestController('jsonataExerciser.tests', 'JSONata');
  private liveEvaluator = new Evaluator({ supersede: true });
  private runEvaluator = new Evaluator();
  private states = new Map<string, State>();
  private lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  private output = vscode.window.createOutputChannel('JSONata Tests');
  private caseIndex = new WeakMap<vscode.TestItem, { file: vscode.TestItem; index: number }>();
  private liveTimer?: NodeJS.Timeout;
  private liveRun = 0;
  private disposables: vscode.Disposable[] = [];

  constructor(private ctx: vscode.ExtensionContext, private session: SessionManager) {
    this.controller.resolveHandler = async (item) => {
      if (!item) await this.discover();
      else if (item.uri) await this.loadFile(item);
    };
    this.controller.refreshHandler = () => this.discover();
    const profile = this.controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, (req, token) => this.runRequest(req, token), true);
    void profile;

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.test.json');
    this.disposables.push(
      this.controller,
      this.liveEvaluator,
      this.runEvaluator,
      this.lensEmitter,
      this.output,
      watcher,
      watcher.onDidCreate((u) => void this.upsertFile(u)),
      watcher.onDidChange((u) => void this.onTestFileChanged(u)),
      watcher.onDidDelete((u) => this.controller.items.delete(u.toString())),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (/\.test\.json$/i.test(e.document.uri.path)) void this.onTestFileChanged(e.document.uri);
      }),
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (d.languageId === 'jsonata' && d.uri.scheme === 'file') this.scheduleLive(d.uri);
      }),
      this.session.onDidEvaluate(() => {
        if (this.session.active && cfg().get<boolean>('tests.live', true)) this.scheduleLive(this.session.exprUri);
      }),
      vscode.languages.registerCodeLensProvider({ language: 'jsonata' }, this),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('jsonataExerciser.tests')) this.lensEmitter.fire();
      })
    );
    void this.discover();
  }

  // ------------------------------------------------------------ sources

  /** Where the test cases for an expression come from: a sibling `.test.json`, or the current demo. */
  private async sourceFor(exprUri: vscode.Uri): Promise<Source | undefined> {
    const isScratchExpr = exprUri.scheme === 'jsonata-exerciser';
    const demo = this.session.currentDemo;
    if (!(isScratchExpr && demo)) {
      const target = await this.targetFor(exprUri);
      if (!target || !target.exists) return undefined;
      const parsed = parseTestFile(await readText(target.uri));
      const dir = target.baseDir ?? vscode.Uri.joinPath(target.uri, '..');
      return {
        label: path.basename(target.uri.path) + (target.real ? '' : ' (not saved)'),
        testUri: target.uri,
        cases: parsed.cases,
        problems: parsed.problems,
        loadInput: async (c) => {
          if (c.inputFile) return decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, c.inputFile)));
          return c.input !== undefined ? JSON.stringify(c.input) : undefined;
        }
      };
    }
    if (!demo || exprUri.toString() !== this.session.exprUriDefault.toString()) return undefined;
    return {
      label: `demo "${demo.label.replace(/^\d+\s*·\s*/, '')}"`,
      cases: testsForDemo(demo),
      problems: [],
      loadInput: async (c) => (c.input !== undefined ? JSON.stringify(c.input) : undefined)
    };
  }

  /**
   * Where the test cases of an expression live. A saved expression has `name.test.json` next to it.
   * The scratch expression of the Exerciser is named after the input file: `<input>.test.json` in the
   * input's folder when that file exists, otherwise an in-memory file with that name (never saved
   * unless you save it).
   */
  private async targetFor(exprUri: vscode.Uri): Promise<Target | undefined> {
    if (exprUri.scheme === 'file' || exprUri.scheme === 'vscode-vfs') {
      const uri = exprUri.with({ path: testPathFor(exprUri.path) });
      return { uri, exists: await exists(uri), real: true, exprName: path.basename(exprUri.path) };
    }
    if (exprUri.toString() !== this.session.exprUriDefault.toString() || !this.session.active) return undefined;
    const base = this.session.scratchBase();
    const folder = this.session.inputFolder();
    if (folder) {
      const real = vscode.Uri.joinPath(folder, `${base}.test.json`);
      if (await exists(real)) return { uri: real, exists: true, real: true, baseDir: folder, exprName: `${base}.jsonata` };
    }
    const mem = vscode.Uri.parse(`jsonata-exerciser:/${base}.test.json`);
    return { uri: mem, exists: await exists(mem), real: false, baseDir: folder, exprName: `${base}.jsonata` };
  }

  /** Reference to the current input for a test case: relative `inputFile` for a real file, inline JSON otherwise. */
  private async inputRef(target: Target): Promise<{ input?: unknown; inputFile?: string; error?: string }> {
    const inputUri = this.session.inputUri;
    if (inputUri.scheme === 'file') {
      let inputFile: string;
      if (target.real) {
        inputFile = path.relative(path.dirname(target.uri.fsPath), inputUri.fsPath).split(path.sep).join('/');
        if (!inputFile.startsWith('.')) inputFile = './' + inputFile;
      } else {
        inputFile = './' + path.basename(inputUri.path); // the test file will be saved next to the input
      }
      let error: string | undefined;
      try {
        const t = await this.session.getText(inputUri);
        if (t.trim()) JSON.parse(t);
      } catch (e: any) {
        error = e.message ?? String(e);
      }
      return { inputFile, error };
    }
    try {
      const t = await this.session.getText(inputUri);
      return { input: t.trim() ? JSON.parse(t) : undefined };
    } catch (e: any) {
      return { error: e.message ?? String(e) };
    }
  }

  /** Writes test file text: real files through the file system, scratch files into the in-memory document. */
  private async writeTarget(target: Target, text: string): Promise<void> {
    if (target.real) await vscode.workspace.fs.writeFile(target.uri, encode(text));
    else await this.session.setContent(target.uri, text);
  }

  private async expressionText(uri: vscode.Uri): Promise<string> {
    return this.session.getText(uri);
  }

  // ------------------------------------------------------------ running (live + command)

  private scheduleLive(uri: vscode.Uri): void {
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = setTimeout(() => void this.runForExpression(uri, { live: true }), 400);
  }

  /** Runs every case for an expression and updates the summary above it. Returns the outcomes. */
  async runForExpression(uri: vscode.Uri, opts: { live?: boolean } = {}): Promise<State | undefined> {
    const source = await this.sourceFor(uri);
    if (!source) {
      if (this.states.delete(uri.toString())) this.lensEmitter.fire();
      return undefined;
    }
    const run = ++this.liveRun;
    const evaluator = opts.live ? this.liveEvaluator : this.runEvaluator;
    let expression: string;
    try {
      expression = await this.expressionText(uri);
    } catch {
      return undefined;
    }
    const outcomes: CaseOutcome[] = [];
    for (const c of source.cases) {
      const o = await runCase(evaluator, expression, c, { loadInput: source.loadInput, timeoutMs: cfg().get<number>('evaluationTimeoutMs', 5000) });
      if (opts.live && (run !== this.liveRun || o.message === 'Cancelled.')) return undefined; // superseded by a newer run
      outcomes.push(o);
    }
    const state: State = { summary: summarize(outcomes), outcomes, label: source.label };
    this.states.set(uri.toString(), state);
    this.lensEmitter.fire();
    return state;
  }

  /** Command: run the tests of the active / Exerciser expression and report. */
  async runTests(arg?: vscode.Uri): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    const uri =
      arg instanceof vscode.Uri
        ? arg
        : ed?.document.languageId === 'jsonata'
          ? ed.document.uri
          : this.session.active
            ? this.session.exprUri
            : undefined;
    if (!uri) {
      void vscode.window.showInformationMessage('Open a .jsonata expression (or the Exerciser) first.');
      return;
    }
    const state = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Running JSONata tests...' }, () => this.runForExpression(uri));
    if (!state) {
      const choice = await vscode.window.showInformationMessage(
        'No test cases for this expression yet. Test cases live in a file next to it (name.test.json).',
        'Add Current Result as Test Case'
      );
      if (choice) await this.addTestCase();
      return;
    }
    const s = state.summary;
    this.output.clear();
    this.output.appendLine(formatReport(state.outcomes, state.label));
    if (s.failed + s.errored === 0) {
      void vscode.window.setStatusBarMessage(`JSONata tests: ${s.passed}/${s.total} passed`, 4000);
      return;
    }
    this.output.show(true);
    const pick = await vscode.window.showWarningMessage(`JSONata tests: ${s.failed + s.errored} of ${s.total} not passing (${state.label}).`, 'Show Report');
    if (pick) this.output.show();
  }

  // ------------------------------------------------------------ code lens

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!cfg().get<boolean>('tests.codeLens', true)) return [];
    const range = new vscode.Range(0, 0, 0, 0);
    const lenses: vscode.CodeLens[] = [];
    const isSession = this.session.active && doc.uri.toString() === this.session.exprUri.toString();
    const source = await this.sourceFor(doc.uri);
    const key = doc.uri.toString();
    const state = this.states.get(key);

    if (source) {
      const n = source.cases.length;
      let title: string;
      if (state) {
        const bad = state.summary.failed + state.summary.errored;
        title = bad === 0 ? `$(pass) ${state.summary.passed}/${state.summary.total} tests passing` : `$(error) ${bad} of ${state.summary.total} tests not passing`;
      } else {
        title = `$(beaker) ${n} test${n === 1 ? '' : 's'}`;
      }
      lenses.push(new vscode.CodeLens(range, { title, tooltip: `Run the test cases from ${source.label}`, command: 'jsonataExerciser.runTests', arguments: [doc.uri] }));
      if (source.testUri) {
        lenses.push(new vscode.CodeLens(range, { title: 'open test file', command: 'jsonataExerciser.openTests' }));
      } else if (this.session.currentDemo) {
        lenses.push(new vscode.CodeLens(range, { title: 'export demo with tests...', command: 'jsonataExerciser.exportDemo' }));
      }
    } else if (doc.uri.scheme === 'file' || (isSession && !this.session.currentDemo)) {
      lenses.push(new vscode.CodeLens(range, { title: '$(beaker) add test cases', tooltip: 'Open (or create) the test cases for this expression', command: 'jsonataExerciser.openTests' }));
    }
    if (source && isSession && source.testUri) {
      lenses.push(new vscode.CodeLens(range, { title: '$(add) add current result as test', command: 'jsonataExerciser.addTestCase' }));
    }
    return lenses;
  }

  // ------------------------------------------------------------ add a case from the Exerciser

  async addTestCase(): Promise<void> {
    if (!this.session.active) {
      void vscode.window.showInformationMessage('Open the Exerciser with an expression and input first.');
      return;
    }
    const exprUri = this.session.exprUri;
    const target = await this.targetFor(exprUri);
    if (!target) {
      void vscode.window.showInformationMessage('Save the expression to a .jsonata file first (Ctrl+S), then add test cases next to it.');
      return;
    }
    const last = this.session.last;
    if (!last || (last.status !== 'ok' && last.status !== 'empty' && last.status !== 'error')) {
      void vscode.window.showInformationMessage('Wait for the Exerciser to show a result, then add it as a test case.');
      return;
    }
    const existing = target.exists ? await readText(target.uri) : undefined;
    const count = existing ? parseTestFile(existing).cases.length : 0;
    const name = await vscode.window.showInputBox({
      title: 'Add the current input and result as a test case',
      prompt: 'Name of the test case. The current result becomes the expected value.',
      value: `case ${count + 1}`,
      validateInput: (v) => (v.trim() ? undefined : 'Enter a name')
    });
    if (!name) return;

    const ref = await this.inputRef(target);
    if (ref.error) {
      void vscode.window.showWarningMessage('The input is not valid JSON yet; fix it before adding a test case.');
      return;
    }
    const result =
      last.status === 'ok'
        ? ({ status: 'ok', text: last.text } as const)
        : last.status === 'empty'
          ? ({ status: 'empty' } as const)
          : ({ status: 'error', code: last.error.code } as const);
    const newCase = caseFromResult({ name: name.trim(), input: ref.input, inputFile: ref.inputFile, result });
    let text: string;
    try {
      text = existing ? appendCaseText(existing, newCase) : testFileWithResult(target.exprName, newCase);
    } catch (e: any) {
      void vscode.window.showWarningMessage(e.message);
      return;
    }
    await this.writeTarget(target, text);
    await this.showRight(target.uri);
    void vscode.window.setStatusBarMessage(`Added "${newCase.name}" to ${path.basename(target.uri.path)}`, 4000);
    await this.runForExpression(exprUri);
  }

  // ------------------------------------------------------------ open the test window

  /**
   * Opens the test cases of the Exerciser expression in a full-height column to the right of the
   * three panes. Creates the file first when it does not exist: the current input and result as
   * first case when the transformation works, otherwise a commented skeleton with the structure of
   * the input.
   */
  async openTests(): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    let exprUri = ed?.document.languageId === 'jsonata' ? ed.document.uri : this.session.active ? this.session.exprUri : undefined;
    if (!exprUri) {
      void vscode.window.showInformationMessage('Open a .jsonata expression (or the Exerciser) first.');
      return;
    }
    const isScratch = exprUri.scheme === 'jsonata-exerciser';
    if (isScratch && this.session.currentDemo && exprUri.toString() === this.session.exprUriDefault.toString()) {
      const c = await vscode.window.showInformationMessage('This demo has built-in test cases. Export it to files to edit them next to the expression.', 'Export Demo with Tests...');
      if (c) await this.exportDemo();
      return;
    }
    if (!isScratch && (!this.session.active || this.session.exprUri.toString() !== exprUri.toString())) {
      const real = exprUri.with({ path: testPathFor(exprUri.path) });
      if (!(await exists(real))) {
        await this.session.openFrom(exprUri);
        exprUri = this.session.exprUri;
      }
    }
    let target = await this.targetFor(exprUri);
    if (!target) {
      void vscode.window.showInformationMessage('Open the Exerciser first (the J: button), then open its test cases.');
      return;
    }
    if (!target.exists) {
      if (!(await this.createTestFile(target))) return;
      target = { ...target, exists: true };
    }
    await this.showRight(target.uri);
    void this.runForExpression(exprUri);
  }

  /**
   * Fills a new test file from the Exerciser state: the current input and result as the first case when
   * the transformation works, otherwise a commented skeleton with the structure of the input. Scratch
   * targets stay in memory. Returns false when it could not be written.
   */
  private async createTestFile(target: Target): Promise<boolean> {
    const result = (await this.session.evaluateNow()) ?? this.session.last;
    const ref = await this.inputRef(target);
    let input = ref.input;
    if (ref.inputFile && !ref.error) {
      try {
        const t = await this.session.getText(this.session.inputUri);
        input = t.trim() ? JSON.parse(t) : undefined; // only used to describe the structure
      } catch {
        /* reported through ref.error */
      }
    }

    let text: string;
    if (result && result.status === 'ok' && !ref.error) {
      text = testFileWithResult(target.exprName, caseFromResult({ name: 'current input', input: ref.inputFile ? undefined : ref.input, inputFile: ref.inputFile, result: { status: 'ok', text: result.text } }));
    } else {
      const reason = !result
        ? 'the expression has not been evaluated yet'
        : result.status === 'ok'
          ? 'the current input is not valid JSON'
          : result.status === 'empty'
            ? 'the expression returns nothing for the current input'
            : result.status === 'error'
              ? `the expression fails for the current input (${result.error.code ? result.error.code + ': ' : ''}${result.error.message})`
              : 'the expression produced no result';
      text = testFileSkeleton({ exprName: target.exprName, reason, input, inputFile: ref.inputFile, inputError: ref.error });
    }
    try {
      await this.writeTarget(target, text);
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Could not create ${path.basename(target.uri.path)}: ${e.message ?? e}`);
      return false;
    }
    return true;
  }

  isScratchTest(uri: vscode.Uri | undefined): boolean {
    return !!uri && uri.scheme === 'jsonata-exerciser' && /\.test\.json$/i.test(uri.path);
  }

  /** Ctrl+S on the in-memory test file: Save dialog next to the input file, with the matching name. */
  async saveScratchTest(uri?: vscode.Uri): Promise<void> {
    const source = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!source || !this.isScratchTest(source)) return;
    const folder = this.session.inputFolder() ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    const name = path.basename(source.path);
    const dest = await vscode.window.showSaveDialog({
      title: 'Save test cases as',
      defaultUri: folder ? vscode.Uri.joinPath(folder, name) : undefined,
      filters: { 'JSONata tests': ['json'] },
      saveLabel: 'Save'
    });
    if (!dest) return;
    try {
      await vscode.workspace.fs.writeFile(dest, encode(await this.session.getText(source)));
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Could not save ${path.basename(dest.path)}: ${e.message ?? e}`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(dest);
    const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === source.toString());
    await vscode.window.showTextDocument(doc, { viewColumn: tab?.group.viewColumn ?? vscode.ViewColumn.Beside, preview: false });
    if (tab) await vscode.window.tabGroups.close(tab);
    const base = path.basename(dest.path).replace(/\.test\.json$/i, '');
    const choice = await vscode.window.showInformationMessage(
      `Saved ${path.basename(dest.path)}. Save the expression as ${base}.jsonata in the same folder so these tests belong to it.`,
      'Save Expression As...'
    );
    if (choice) await this.session.saveScratchAs(this.session.exprUriDefault);
  }

  /** Shows a file in a full-height column right of the Exerciser panes (input | expression / result | tests). */
  private async showRight(uri: vscode.Uri): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const groups = vscode.window.tabGroups.all.length;
    let column: vscode.ViewColumn = vscode.ViewColumn.Beside;
    if (groups === 3) {
      await vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 0,
        groups: [{ size: 0.3 }, { groups: [{ size: 0.55 }, { size: 0.45 }], size: 0.4 }, { size: 0.3 }]
      });
      column = vscode.ViewColumn.Four;
    } else if (groups >= 4) {
      column = vscode.ViewColumn.Four;
    }
    await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false, preserveFocus: false });
  }

  // ------------------------------------------------------------ export demo with tests

  async exportDemo(): Promise<void> {
    let demo: Demo | undefined = this.session.currentDemo;
    if (!demo) {
      const pick = await vscode.window.showQuickPick(
        DEMOS.map((d) => ({ label: d.label, detail: d.description, demo: d })),
        { title: 'Export which demo (with its test cases)?', matchOnDetail: true }
      );
      demo = pick?.demo;
    }
    if (!demo) return;
    const folder = await vscode.window.showOpenDialog({
      title: `Choose a folder for the "${demo.id}" demo files`,
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Export here',
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
    });
    if (!folder?.[0]) return;
    const dir = folder[0];
    const exprUri = vscode.Uri.joinPath(dir, `${demo.id}.jsonata`);
    const inputUri = vscode.Uri.joinPath(dir, `${demo.id}.json`);
    const testUri = vscode.Uri.joinPath(dir, `${demo.id}.test.json`);
    for (const u of [exprUri, inputUri, testUri]) {
      if (await exists(u)) {
        const ok = await vscode.window.showWarningMessage(`${path.basename(u.path)} already exists in that folder. Overwrite the demo files?`, { modal: true }, 'Overwrite');
        if (ok !== 'Overwrite') return;
        break;
      }
    }
    const cases = testsForDemo(demo).map((c, i) => {
      if (i !== 0) return c;
      const { input: _drop, ...rest } = c;
      const { name, ...others } = rest;
      return { name, inputFile: `./${demo!.id}.json`, ...others };
    });
    await vscode.workspace.fs.writeFile(exprUri, encode(demo.expression + '\n'));
    await vscode.workspace.fs.writeFile(inputUri, encode(demoInputText(demo) + '\n'));
    await vscode.workspace.fs.writeFile(testUri, encode(JSON.stringify({ cases }, null, 2) + '\n'));
    const choice = await vscode.window.showInformationMessage(
      `Exported ${demo.id}.jsonata, ${demo.id}.json (input) and ${demo.id}.test.json (${cases.length} test cases).`,
      'Open in Exerciser'
    );
    if (choice) await this.session.link({ exprUri, inputUri });
  }

  // ------------------------------------------------------------ Test Explorer

  private async discover(): Promise<void> {
    const files = await vscode.workspace.findFiles('**/*.test.json', '**/node_modules/**', 500);
    const seen = new Set(files.map((f) => f.toString()));
    this.controller.items.forEach((i) => {
      if (!seen.has(i.id)) this.controller.items.delete(i.id);
    });
    for (const f of files) await this.upsertFile(f);
  }

  private async upsertFile(uri: vscode.Uri): Promise<vscode.TestItem> {
    let item = this.controller.items.get(uri.toString());
    if (!item) {
      item = this.controller.createTestItem(uri.toString(), vscode.workspace.asRelativePath(uri), uri);
      item.canResolveChildren = true;
      this.controller.items.add(item);
    }
    await this.loadFile(item);
    return item;
  }

  private async loadFile(file: vscode.TestItem): Promise<void> {
    const uri = file.uri!;
    let text: string;
    try {
      text = await readText(uri);
    } catch {
      this.controller.items.delete(file.id);
      return;
    }
    const parsed = parseTestFile(text);
    const nodes = scanJson(text);
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
    const positionAt = (offset: number): vscode.Position => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return new vscode.Position(lo, offset - lineStarts[lo]);
    };
    const children: vscode.TestItem[] = [];
    parsed.cases.forEach((c, i) => {
      const item = this.controller.createTestItem(`${uri.toString()}#${i}`, c.name, uri);
      if (c.description) item.description = c.description;
      const node = nodes.find((n) => n.path.length === 2 && n.path[0] === 'cases' && n.path[1] === i) ?? nodes.find((n) => n.path.length === 1 && n.path[0] === i);
      if (node) item.range = new vscode.Range(positionAt(node.start), positionAt(node.end));
      this.caseIndex.set(item, { file: file, index: i });
      children.push(item);
    });
    file.children.replace(children);
    file.error = parsed.problems.length ? parsed.problems.join(' ') : undefined;
    file.canResolveChildren = false;
  }

  private changeTimers = new Map<string, NodeJS.Timeout>();

  private async onTestFileChanged(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const prev = this.changeTimers.get(key);
    if (prev) clearTimeout(prev);
    this.changeTimers.set(
      key,
      setTimeout(() => {
        this.changeTimers.delete(key);
        if (uri.scheme !== 'file') {
          if (this.session.active) void this.runForExpression(this.session.exprUri, { live: true });
          return;
        }
        void this.upsertFile(uri);
        const exprUri = uri.with({ path: uri.path.replace(/\.test\.json$/i, '.jsonata') });
        void this.runForExpression(exprUri, { live: true });
      }, 400)
    );
  }

  private async runRequest(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    const run = this.controller.createTestRun(request);
    const excluded = new Set((request.exclude ?? []).map((i) => i.id));
    const jobs = new Map<string, { file: vscode.TestItem; only?: Set<number> }>();
    const add = (item: vscode.TestItem) => {
      if (excluded.has(item.id)) return;
      const c = this.caseIndex.get(item);
      if (c) {
        const job = jobs.get(c.file.id) ?? { file: c.file, only: new Set<number>() };
        job.only?.add(c.index);
        jobs.set(c.file.id, job);
      } else {
        jobs.set(item.id, { file: item });
      }
    };
    if (request.include) request.include.forEach(add);
    else this.controller.items.forEach(add);

    for (const { file, only } of jobs.values()) {
      if (token.isCancellationRequested) break;
      await this.loadFile(file);
      const testUri = file.uri!;
      const exprUri = testUri.with({ path: testUri.path.replace(/\.test\.json$/i, '.jsonata') });
      const items: vscode.TestItem[] = [];
      file.children.forEach((c) => items.push(c));
      const selected = items.filter((it) => !only || only.has(this.caseIndex.get(it)!.index));
      selected.forEach((it) => run.enqueued(it));

      let expression: string;
      try {
        expression = await this.expressionText(exprUri);
      } catch {
        const msg = new vscode.TestMessage(`Expression file not found: ${path.basename(exprUri.path)}`);
        selected.forEach((it) => run.errored(it, msg));
        continue;
      }
      const parsed = parseTestFile(await readText(testUri));
      const dir = vscode.Uri.joinPath(testUri, '..');
      const loadInput = async (c: TestCase) => {
        if (c.inputFile) return decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, c.inputFile)));
        return c.input !== undefined ? JSON.stringify(c.input) : undefined;
      };
      const outcomes: CaseOutcome[] = [];
      for (const it of selected) {
        if (token.isCancellationRequested) break;
        const idx = this.caseIndex.get(it)!.index;
        const c = parsed.cases[idx];
        if (!c) continue;
        run.started(it);
        const o = await runCase(this.runEvaluator, expression, c, { loadInput, timeoutMs: cfg().get<number>('evaluationTimeoutMs', 5000) });
        outcomes.push(o);
        if (o.status === 'pass') run.passed(it, o.ms);
        else {
          const msg =
            o.expectedText !== undefined && o.actualText !== undefined
              ? vscode.TestMessage.diff(o.message ?? 'Result differs from expected.', o.expectedText, o.actualText)
              : new vscode.TestMessage(o.message ?? 'Failed.');
          if (it.range) msg.location = new vscode.Location(testUri, it.range);
          if (o.status === 'fail') run.failed(it, msg, o.ms);
          else run.errored(it, msg, o.ms);
        }
      }
      if (!only && outcomes.length === parsed.cases.length) {
        this.states.set(exprUri.toString(), { summary: summarize(outcomes), outcomes, label: path.basename(testUri.path) });
        this.lensEmitter.fire();
      }
    }
    run.end();
  }

  dispose(): void {
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.changeTimers.forEach((t) => clearTimeout(t));
    this.disposables.forEach((d) => d.dispose());
  }
}
