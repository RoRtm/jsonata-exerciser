import * as vscode from 'vscode';
import { Evaluator, EvalResult } from './core/evaluator';
import { candidateSpans, isValidSpan, pathPrefixes, ProbeValue, Span } from './core/probe';
import type { SessionManager } from './session';

function cfg() {
  return vscode.workspace.getConfiguration('jsonataExerciser');
}

function oneLine(json: string, max: number): string {
  let shown: string;
  try {
    const v = JSON.parse(json);
    const t = JSON.stringify(v);
    shown = Array.isArray(v) ? `array(${v.length}) ${t}` : t ?? json;
  } catch {
    shown = json.replace(/\s+/g, ' ');
  }
  return shown.length > max ? shown.slice(0, max - 1) + '…' : shown;
}

/** Short text for the inline hint after the line. */
function summarize(p: ProbeValue, max: number): string {
  if (p.parseError) return '(this part cannot be inspected on its own)';
  if (p.calls === 0) {
    return p.error
      ? `(not reached: ${p.error.code ? p.error.code + ' ' : ''}${p.error.message})`
      : '(not reached: nothing got here, e.g. an earlier step matched nothing)';
  }
  if (p.calls === 1) return oneLine(p.values[0], max);
  const shown = p.values.slice(0, 4).map((v) => oneLine(v, Math.max(12, Math.floor(max / 4))));
  return `×${p.calls}: ${shown.join(', ')}${p.calls > shown.length ? ', …' : ''}`;
}

function fence(json: string): string {
  return '```json\n' + json.replace(/```/g, "'''") + '\n```';
}

/**
 * Step-through value inspection: shows what the sub-expression at the cursor (or the selection)
 * evaluates to, in its real context, with a per-step breakdown for paths. Entirely local.
 */
export class Inspector implements vscode.Disposable {
  private evaluator = new Evaluator({ supersede: true });
  private ghost = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic', margin: '0 0 0 2em' }
  });
  private mark = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    borderRadius: '2px'
  });
  private shown?: { uri: string; range: vscode.Range; hover: vscode.MarkdownString };
  private expandFrom?: { offset: number; version: number; span: Span };
  private timer?: NodeJS.Timeout;
  private runId = 0;
  private disposables: vscode.Disposable[] = [];

  constructor(private session: SessionManager) {
    this.disposables.push(
      this.ghost,
      this.mark,
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelection(e.textEditor)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.shown?.uri === e.document.uri.toString()) this.clear();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.clear()),
      vscode.languages.registerHoverProvider(
        { language: 'jsonata' },
        {
          provideHover: (doc, pos) =>
            this.shown && this.shown.uri === doc.uri.toString() && this.shown.range.contains(pos)
              ? new vscode.Hover(this.shown.hover, this.shown.range)
              : undefined
        }
      )
    );
  }

  private isLive(): boolean {
    return cfg().get<boolean>('inspect.live', true);
  }

  private isSessionExpr(ed: vscode.TextEditor): boolean {
    return this.session.active && ed.document.uri.toString() === this.session.exprUri.toString();
  }

  private onSelection(ed: vscode.TextEditor): void {
    if (!this.isLive() || !this.isSessionExpr(ed)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.inspect(ed, {}), 250);
  }

  clear(): void {
    this.runId++;
    this.shown = undefined;
    for (const ed of vscode.window.visibleTextEditors) {
      ed.setDecorations(this.ghost, []);
      ed.setDecorations(this.mark, []);
    }
  }

  /** Command entry point. `expand` selects the next larger enclosing expression. */
  async run(opts: { expand?: boolean }): Promise<void> {
    let ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.languageId !== 'jsonata') {
      void vscode.window.showInformationMessage('Place the cursor in a JSONata expression first.');
      return;
    }
    if (!this.isSessionExpr(ed)) {
      await this.session.openFrom(ed.document.uri);
      ed = vscode.window.activeTextEditor;
      if (!ed || ed.document.languageId !== 'jsonata') return;
    }
    await this.inspect(ed, { explicit: true, expand: opts.expand });
  }

  private pickSpan(ed: vscode.TextEditor, expand: boolean): Span | undefined {
    const doc = ed.document;
    const text = doc.getText();
    const sel = ed.selection;
    if (!sel.isEmpty && !expand) {
      let start = doc.offsetAt(sel.start);
      let end = doc.offsetAt(sel.end);
      while (start < end && /\s/.test(text[start])) start++;
      while (end > start && /\s/.test(text[end - 1])) end--;
      const span = { start, end };
      return isValidSpan(text, span) ? span : undefined;
    }
    const offset = doc.offsetAt(sel.active);
    const cands = candidateSpans(text, offset);
    if (cands.length === 0) return undefined;
    if (expand) {
      const prev = this.expandFrom && this.expandFrom.offset === offset && this.expandFrom.version === doc.version ? this.expandFrom.span : undefined;
      const current = prev ?? (this.shown && this.shown.uri === doc.uri.toString()
        ? { start: doc.offsetAt(this.shown.range.start), end: doc.offsetAt(this.shown.range.end) }
        : cands[0]);
      const next = cands.find((c) => c.start <= current.start && c.end >= current.end && (c.end - c.start) > (current.end - current.start));
      const span = next ?? current;
      this.expandFrom = { offset, version: doc.version, span };
      return span;
    }
    this.expandFrom = undefined;
    return cands[0];
  }

  private async inspect(ed: vscode.TextEditor, opts: { explicit?: boolean; expand?: boolean }): Promise<void> {
    const doc = ed.document;
    const text = doc.getText();
    const span = this.pickSpan(ed, !!opts.expand);
    if (!span) {
      this.clear();
      if (opts.explicit) void vscode.window.showInformationMessage('No inspectable sub-expression here. Select a complete expression or place the cursor on a name, call or path.');
      return;
    }
    const run = ++this.runId;
    const sub = text.slice(span.start, span.end);
    const steps = pathPrefixes(sub).map((p) => ({ start: span.start, end: span.start + p.end, label: p.label }));
    const spans: Span[] = [span, ...steps.filter((s) => s.end !== span.end)];

    let input: string;
    try {
      input = await this.session.getText(this.session.inputUri);
    } catch {
      return;
    }
    const res: EvalResult = await this.evaluator.evaluate({
      expression: text,
      input,
      probes: spans,
      timeoutMs: cfg().get<number>('evaluationTimeoutMs', 5000)
    });
    if (run !== this.runId || res.status === 'cancelled') return;

    if (res.status !== 'probe') {
      this.clear();
      if (opts.explicit) {
        void vscode.window.showWarningMessage(
          res.status === 'error' ? `Cannot inspect: ${res.error.message}` : 'Inspection was aborted (timeout).'
        );
      }
      return;
    }

    const main = res.results[0];
    const range = new vscode.Range(doc.positionAt(span.start), doc.positionAt(span.end));
    const max = cfg().get<number>('inspect.maxLength', 80);
    let k = 1;
    const rows = steps.map((s) => ({ label: s.label, p: s.end === span.end ? main : res.results[k++] }));
    const hover = this.buildHover(sub, main, rows);
    this.shown = { uri: doc.uri.toString(), range, hover };

    const endLine = doc.lineAt(range.end.line);
    const at = new vscode.Position(range.end.line, endLine.text.length);
    ed.setDecorations(this.mark, [range]);
    ed.setDecorations(this.ghost, [
      { range: new vscode.Range(at, at), renderOptions: { after: { contentText: ('▸ ' + summarize(main, max)).replace(/ /g, '\u00a0') } } }
    ]);
    if (opts.explicit) await vscode.commands.executeCommand('editor.action.showHover');
  }

  private buildHover(sub: string, main: ProbeValue, rows: Array<{ label: string; p?: ProbeValue }>): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ['jsonataExerciser.inspectExpand'] };
    const title = sub.replace(/\s+/g, ' ');
    md.appendMarkdown(`**Value of** \`${title.length > 70 ? title.slice(0, 69) + '…' : title}\`\n\n`);
    if (main.parseError) {
      md.appendMarkdown('This part cannot be inspected on its own.\n');
    } else if (main.calls === 0) {
      md.appendMarkdown(
        'Never evaluated with the current input: an earlier step produced nothing, or this branch is not taken.' +
          (main.error ? `\n\nThe expression failed: \`${main.error.code ?? ''} ${main.error.message}\`` : '') +
          '\n'
      );
    } else if (main.calls === 1) {
      md.appendMarkdown(fence(main.values[0]) + '\n');
    } else {
      md.appendMarkdown(`Evaluated **${main.calls}×** (for example once per array item):\n\n`);
      main.values.slice(0, 6).forEach((v, i) => md.appendMarkdown(`${i + 1}. \`${oneLine(v, 90).replace(/`/g, "'")}\`\n`));
      if (main.calls > 6) md.appendMarkdown(`\n… and ${main.calls - 6} more\n`);
    }
    if (rows.length) {
      md.appendMarkdown('\n**Step by step**\n\n| step | evaluations | value |\n| --- | --- | --- |\n');
      for (const r of rows) {
        if (!r.p) continue;
        md.appendMarkdown(`| \`${r.label.replace(/\|/g, '\\|')}\` | ${r.p.calls} | ${summarize(r.p, 50).replace(/\|/g, '\\|')} |\n`);
      }
    }
    if (main.error && main.calls > 0) {
      md.appendMarkdown(`\n_Note: the expression fails later on: ${main.error.code ?? ''} ${main.error.message}_\n`);
    }
    md.appendMarkdown('\n[Inspect larger expression](command:jsonataExerciser.inspectExpand)');
    return md;
  }

  async toggleLive(): Promise<void> {
    const next = !this.isLive();
    await cfg().update('inspect.live', next, vscode.ConfigurationTarget.Global);
    if (!next) this.clear();
    void vscode.window.setStatusBarMessage(`JSONata live inspection ${next ? 'on' : 'off'}`, 2500);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.evaluator.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
