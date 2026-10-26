import * as vscode from 'vscode';
import { Evaluator } from './core/evaluator';
import { adviceFor, hotSpots, ProfileResult, ProfileSpan, scaleArrays, timeTree } from './core/profile';
import type { SessionManager } from './session';

function cfg() {
  return vscode.workspace.getConfiguration('jsonataExerciser');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fmtMs(ms: number): string {
  return ms >= 100 ? ms.toFixed(0) : ms >= 1 ? ms.toFixed(1) : ms.toFixed(3);
}

function snippet(text: string, max = 110): string {
  const t = text.replace(/\s+/g, ' ');
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

interface Shown {
  uri: string;
  expression: string;
  result: ProfileResult;
}

/**
 * Performance profiler UI: heat map in the expression editor, hover details, and a report with the
 * hot spots and concrete suggestions. Everything is measured locally in the worker thread.
 */
export class Profiler implements vscode.Disposable {
  private evaluator = new Evaluator();
  private heat = [0.12, 0.22, 0.34, 0.48].map((a) =>
    vscode.window.createTextEditorDecorationType({ backgroundColor: `rgba(255, 90, 0, ${a})`, borderRadius: '2px' })
  );
  private ghost = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic', margin: '0 0 0 2em' }
  });
  private shown?: Shown;
  private panel?: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  constructor(private session: SessionManager) {
    this.disposables.push(
      this.ghost,
      ...this.heat,
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.shown?.uri === e.document.uri.toString()) this.clear();
      }),
      vscode.languages.registerHoverProvider(
        { language: 'jsonata' },
        {
          provideHover: (doc, pos) => {
            if (!this.shown || this.shown.uri !== doc.uri.toString()) return undefined;
            const off = doc.offsetAt(pos);
            const hit = this.shown.result.spans
              .filter((s) => s.start <= off && off <= s.end)
              .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
            if (!hit) return undefined;
            return new vscode.Hover(this.hoverFor(hit, this.shown.result), new vscode.Range(doc.positionAt(hit.start), doc.positionAt(hit.end)));
          }
        }
      )
    );
  }

  private hoverFor(s: ProfileSpan, r: ProfileResult): vscode.MarkdownString {
    const total = r.totalMs || 1;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Profile** (${(r.baselineMs).toFixed(1)} ms for the whole expression)\n\n`);
    md.appendMarkdown(`| | |\n| --- | --- |\n`);
    md.appendMarkdown(`| Evaluated | ${s.calls}× |\n`);
    md.appendMarkdown(`| Total time (with inner parts) | ${fmtMs(s.inclusiveMs)} ms (${((s.inclusiveMs / total) * 100).toFixed(0)}%) |\n`);
    if (s.selfMs !== undefined) {
      md.appendMarkdown(`| Own time | ${fmtMs(s.selfMs)} ms (${((s.selfMs / total) * 100).toFixed(0)}%) |\n`);
    }
    if (s.calls > 0) md.appendMarkdown(`| Per evaluation | ${((s.inclusiveMs * 1000) / s.calls).toFixed(1)} µs |\n`);
    return md;
  }

  clear(): void {
    this.shown = undefined;
    for (const ed of vscode.window.visibleTextEditors) {
      for (const h of this.heat) ed.setDecorations(h, []);
      ed.setDecorations(this.ghost, []);
    }
  }

  async run(): Promise<void> {
    if (!this.session.active) await this.session.open();
    const uri = this.session.exprUri;
    const expression = await this.session.getText(uri);
    if (!expression.trim()) {
      void vscode.window.showInformationMessage('Type a JSONata expression first.');
      return;
    }
    let inputText = await this.session.getText(this.session.inputUri);

    const pick = await vscode.window.showQuickPick(
      [
        { label: 'Current input', description: 'profile with the data as it is', factor: 1 },
        { label: 'Arrays ×10', description: 'repeat the items of every array 10 times', factor: 10 },
        { label: 'Arrays ×100', description: 'simulate a much larger input', factor: 100 },
        { label: 'Arrays ×1000', description: 'stress test (may take long)', factor: 1000 }
      ],
      { title: 'Profile JSONata expression: which input?', placeHolder: 'Slow spots often only show up with larger data' }
    );
    if (!pick) return;
    if (pick.factor > 1) {
      try {
        inputText = JSON.stringify(scaleArrays(JSON.parse(inputText), pick.factor));
      } catch (e: any) {
        void vscode.window.showWarningMessage(`The input is not valid JSON: ${e.message}`);
        return;
      }
      if (inputText.length > 80_000_000) {
        void vscode.window.showWarningMessage('The scaled input would be too large. Choose a smaller factor.');
        return;
      }
    }

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Profiling JSONata expression (it is evaluated a few times)…', cancellable: true },
      async (_p, token) => {
        token.onCancellationRequested(() => this.evaluator.dispose());
        return this.evaluator.evaluate({
          expression,
          input: inputText,
          profile: {},
          timeoutMs: cfg().get<number>('profile.timeoutMs', 120000)
        });
      }
    );

    if (result.status === 'cancelled') return;
    if (result.status === 'timeout') {
      void vscode.window.showWarningMessage('Profiling was aborted (timeout). Try a smaller input factor or raise jsonataExerciser.profile.timeoutMs.');
      return;
    }
    if (result.status === 'error') {
      void vscode.window.showWarningMessage(`Cannot profile: ${result.error.message}`);
      return;
    }
    if (result.status !== 'profile') return;
    if (result.result.error) {
      void vscode.window.showWarningMessage(`Cannot profile: the expression fails with ${result.result.error.code ?? ''} ${result.result.error.message}`);
      return;
    }
    this.shown = { uri: uri.toString(), expression, result: result.result };
    this.decorate();
    this.showReport(pick.factor);
  }

  private editor(): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === this.shown?.uri);
  }

  private decorate(): void {
    const ed = this.editor();
    if (!ed || !this.shown) return;
    const { expression, result } = this.shown;
    const doc = ed.document;
    const buckets: vscode.Range[][] = this.heat.map(() => []);
    const lineBest = new Map<number, { share: number; part: ReturnType<typeof hotSpots>[number] }>();
    for (const part of hotSpots(expression, result, 12)) {
      const level = part.share >= 0.4 ? 3 : part.share >= 0.2 ? 2 : part.share >= 0.1 ? 1 : part.share >= 0.03 ? 0 : -1;
      if (level < 0) continue;
      const range = new vscode.Range(doc.positionAt(part.span.start), doc.positionAt(part.span.end));
      buckets[level].push(range);
      const line = range.end.line;
      if (!lineBest.has(line) || lineBest.get(line)!.share < part.share) lineBest.set(line, { share: part.share, part });
    }
    this.heat.forEach((h, i) => ed.setDecorations(h, buckets[i]));
    const ghosts: vscode.DecorationOptions[] = [];
    for (const [line, { part }] of lineBest) {
      const at = new vscode.Position(line, doc.lineAt(line).text.length);
      const text = `⏱ ${(part.share * 100).toFixed(0)}% · ${fmtMs(part.span.selfMs ?? 0)} ms · ×${part.span.calls}`;
      ghosts.push({ range: new vscode.Range(at, at), renderOptions: { after: { contentText: text.replace(/ /g, ' ') } } });
    }
    ed.setDecorations(this.ghost, ghosts);
  }

  private showReport(factor: number): void {
    if (!this.shown) return;
    const { expression, result } = this.shown;
    const spots = hotSpots(expression, result, 15);
    const advice = adviceFor(expression, result);
    const tree = timeTree(expression, result, 0.03, 30)
      .map(
        (t) =>
          `<div class="tr" data-start="${t.span.start}" data-end="${t.span.end}" style="padding-left:${Math.min(t.depth, 8) * 14}px"><span class="pct">${(t.share * 100).toFixed(0)}%</span> <span class="mut">×${t.span.calls}</span> <code>${esc(snippet(t.text, 90))}</code>${t.ownShare >= 0.1 ? ` <span class="own">own ${(t.ownShare * 100).toFixed(0)}%</span>` : ''}</div>`
      )
      .join('\n');
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('jsonataProfile', 'JSONata Profile', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true });
      this.panel.onDidDispose(() => (this.panel = undefined));
      this.panel.webview.onDidReceiveMessage((m) => {
        if (m?.type === 'reveal') void this.reveal(m.start, m.end);
        if (m?.type === 'rerun') void this.run();
        if (m?.type === 'clear') this.clear();
      });
    }
    const nonce = Math.random().toString(36).slice(2);
    const rows = spots
      .map((s, i) => {
        const pct = (s.share * 100).toFixed(0);
        const avg = s.span.calls ? ((s.span.selfMs ?? 0) * 1000) / s.span.calls : 0;
        return `<tr data-start="${s.span.start}" data-end="${s.span.end}" title="Click to show in the editor">
<td>${i + 1}</td><td class="bar"><div style="width:${Math.max(2, Math.min(100, s.share * 100))}%"></div><span>${pct}%</span></td>
<td class="n">${fmtMs(s.span.selfMs ?? 0)}</td><td class="n">${fmtMs(s.span.inclusiveMs)}</td><td class="n">${s.span.calls}</td><td class="n">${avg.toFixed(1)}</td>
<td><code>${esc(snippet(s.text))}</code></td></tr>`;
      })
      .join('\n');
    this.panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px 16px}
h2{margin:.2em 0 .6em}
.muted{color:var(--vscode-descriptionForeground)}
table{border-collapse:collapse;width:100%;margin-top:8px}
th,td{padding:4px 8px;text-align:left;border-bottom:1px solid var(--vscode-widget-border,#444);vertical-align:middle}
th{color:var(--vscode-descriptionForeground);font-weight:600}
td.n{text-align:right;font-variant-numeric:tabular-nums}
tr[data-start]{cursor:pointer}
tr[data-start]:hover{background:var(--vscode-list-hoverBackground)}
td.bar{position:relative;width:110px}
td.bar div{position:absolute;left:8px;top:6px;bottom:6px;background:rgba(255,90,0,.55);border-radius:2px}
td.bar span{position:relative;font-variant-numeric:tabular-nums}
#tree{margin:6px 0 10px}.tr{padding:2px 0;cursor:pointer}.tr:hover{background:var(--vscode-list-hoverBackground)}.pct{display:inline-block;min-width:3em;text-align:right;font-variant-numeric:tabular-nums;color:rgb(255,140,60);font-weight:600}.mut{color:var(--vscode-descriptionForeground)}.own{color:var(--vscode-descriptionForeground);font-style:italic}
code{font-family:var(--vscode-editor-font-family);white-space:pre-wrap}
.advice{margin:10px 0;padding:8px 12px;border-left:3px solid var(--vscode-editorWarning-foreground);background:var(--vscode-editor-inactiveSelectionBackground)}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:4px 10px;border-radius:2px;cursor:pointer;margin-right:6px}
button:hover{background:var(--vscode-button-hoverBackground)}
</style></head><body>
<h2>JSONata profile</h2>
<div class="muted">Evaluation ${fmtMs(result.baselineMs)} ms${factor > 1 ? ` with arrays ×${factor}` : ''} · ${result.spans.length} parts measured${result.truncated ? ' (reduced set)' : ''}.
Times are estimates: the measuring overhead was estimated and removed, so own times add up to the plain evaluation time. "Own" excludes the parts inside.</div>
<p><button id="rerun">Run again…</button><button id="clear">Clear highlights</button></p>
${advice.length ? `<div class="advice"><strong>Suggestions</strong><ul>${advice.map((a) => `<li>${esc(a).replace(/`([^`]+)`/g, '<code>$1</code>')}</li>`).join('')}</ul></div>` : ''}
<h3>Where the time goes</h3><div class="muted">Share of the total including the parts inside; indentation = nesting. Click a line to show it in the editor.</div><div id="tree">${tree}</div>
<h3>Hot spots by own time</h3>
<table><thead><tr><th>#</th><th>Share (own)</th><th class="n">Own ms</th><th class="n">Total ms</th><th class="n">Calls</th><th class="n">µs/call</th><th>Part of the expression</th></tr></thead>
<tbody>${rows || '<tr><td colspan="7" class="muted">Nothing measurable: the expression is too fast. Profile with larger arrays (×100).</td></tr>'}</tbody></table>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.querySelectorAll('tr[data-start], .tr[data-start]').forEach(r => r.addEventListener('click', () => vscode.postMessage({type:'reveal', start:+r.dataset.start, end:+r.dataset.end})));
document.getElementById('rerun').addEventListener('click', () => vscode.postMessage({type:'rerun'}));
document.getElementById('clear').addEventListener('click', () => vscode.postMessage({type:'clear'}));
</script></body></html>`;
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  private async reveal(start: number, end: number): Promise<void> {
    if (!this.shown) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(this.shown.uri));
    const ed = await vscode.window.showTextDocument(doc, { viewColumn: this.editor()?.viewColumn ?? vscode.ViewColumn.Two, preserveFocus: false });
    const range = new vscode.Range(doc.positionAt(start), doc.positionAt(end));
    ed.selection = new vscode.Selection(range.start, range.end);
    ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  dispose(): void {
    this.evaluator.dispose();
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
