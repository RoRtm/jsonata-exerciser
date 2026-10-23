import * as vscode from 'vscode';
import { analyze, errorToRange, formatJsonataError, Issue } from './core/analyze';
import { EvalResult } from './core/evaluator';
import { FUNCTIONS, FUNCTION_BY_NAME, paramLabels } from './core/functions';
import { allFields, callContextAt, fieldSuggestions } from './core/intel';
import { formatJsonata, FormatError } from './core/format';
import type { SessionManager } from './session';

const SELECTOR: vscode.DocumentSelector = { language: 'jsonata' };

function toDiagnostic(doc: vscode.TextDocument, i: Issue, source: string): vscode.Diagnostic {
  const d = new vscode.Diagnostic(
    new vscode.Range(doc.positionAt(i.start), doc.positionAt(i.end)),
    i.message,
    i.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
  );
  d.source = source;
  if (i.code) d.code = i.code;
  return d;
}

/** Syntax validation (official parser) plus runtime errors of the current Exerciser session. */
export class DiagnosticsManager implements vscode.Disposable {
  private collection = vscode.languages.createDiagnosticCollection('jsonata');
  private runtime = new Map<string, Issue>();
  private disposables: vscode.Disposable[] = [this.collection];

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((d) => this.refresh(d)),
      vscode.workspace.onDidChangeTextDocument((e) => this.refresh(e.document)),
      vscode.workspace.onDidCloseTextDocument((d) => {
        this.collection.delete(d.uri);
        this.runtime.delete(d.uri.toString());
      })
    );
    vscode.workspace.textDocuments.forEach((d) => this.refresh(d));
  }

  refresh(doc: vscode.TextDocument): void {
    if (doc.languageId !== 'jsonata') return;
    const text = doc.getText();
    const { issues } = analyze(text);
    const diagnostics = issues.map((i) => toDiagnostic(doc, i, 'jsonata'));
    const rt = this.runtime.get(doc.uri.toString());
    const hasSyntaxError = issues.some((i) => i.severity === 'error');
    if (rt && !hasSyntaxError) diagnostics.push(toDiagnostic(doc, rt, 'jsonata (runtime)'));
    this.collection.set(doc.uri, diagnostics);
  }

  setRuntime(uri: vscode.Uri, r: EvalResult | undefined, expression?: string): void {
    const key = uri.toString();
    if (r && r.status === 'error' && r.phase === 'eval' && expression !== undefined) {
      const { start, end } = errorToRange(r.error, expression);
      this.runtime.set(key, {
        message: formatJsonataError(r.error),
        code: r.error.code,
        start,
        end,
        severity: 'error'
      });
    } else {
      this.runtime.delete(key);
    }
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    if (doc) this.refresh(doc);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

const KEYWORDS = ['function', 'true', 'false', 'null', 'and', 'or', 'in'];

function fnMarkdown(name: string): vscode.MarkdownString | undefined {
  const f = FUNCTION_BY_NAME.get(name);
  if (!f) return undefined;
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: ['jsonataExerciser.openHelp'] };
  md.appendCodeblock(f.signature, 'jsonata');
  md.appendMarkdown(`${f.description}\n\n`);
  const args = encodeURIComponent(JSON.stringify({ fn: f.name }));
  md.appendMarkdown(`[$(book) Online help](command:jsonataExerciser.openHelp?${args}) · [docs.jsonata.org](${f.url})`);
  return md;
}

export function registerProviders(session: SessionManager): vscode.Disposable[] {
  const subs: vscode.Disposable[] = [];

  // --- completions: $functions, keywords, and field names from the input JSON ---
  subs.push(
    vscode.languages.registerCompletionItemProvider(
      SELECTOR,
      {
        provideCompletionItems(doc, pos) {
          const items: vscode.CompletionItem[] = [];
          const line = doc.lineAt(pos.line).text.slice(0, pos.character);
          const fnRange = doc.getWordRangeAtPosition(pos, /\$[A-Za-z_]\w*|\$/);
          const wantsFunctions = /\$[A-Za-z_]*$/.test(line);

          if (wantsFunctions) {
            for (const f of FUNCTIONS) {
              const it = new vscode.CompletionItem(`$${f.name}`, vscode.CompletionItemKind.Function);
              it.detail = f.signature;
              it.documentation = fnMarkdown(f.name);
              const params = f.signature.slice(f.signature.indexOf('(') + 1, f.signature.lastIndexOf(')'));
              const required = params.split('[')[0].split(',').map((s) => s.trim()).filter(Boolean);
              const snippet = required.map((p, i) => `\${${i + 1}:${p}}`).join(', ');
              it.insertText = new vscode.SnippetString(`$${f.name}(${snippet})`);
              it.range = fnRange ?? new vscode.Range(pos, pos);
              it.filterText = `$${f.name}`;
              it.sortText = `0_${f.name}`;
              items.push(it);
            }
            // variables defined in the expression
            const vars = new Set(
              [...doc.getText().matchAll(/\$([A-Za-z_]\w*)\s*:=/g)].map((m) => m[1]).concat(
                [...doc.getText().matchAll(/function\s*\(([^)]*)\)/g)].flatMap((m) =>
                  [...m[1].matchAll(/\$([A-Za-z_]\w*)/g)].map((x) => x[1])
                )
              )
            );
            for (const v of vars) {
              if (FUNCTION_BY_NAME.has(v)) continue;
              const it = new vscode.CompletionItem(`$${v}`, vscode.CompletionItemKind.Variable);
              it.detail = 'variable / user function';
              it.range = fnRange ?? new vscode.Range(pos, pos);
              items.push(it);
            }
            return items;
          }

          if (vscode.workspace.getConfiguration('jsonataExerciser').get<boolean>('intellisense.fieldSuggestions', true)) {
            const root = session.inputJson;
            if (root !== undefined) {
              const before = doc.getText(new vscode.Range(new vscode.Position(0, 0), pos));
              for (const f of fieldSuggestions(root, before)) {
                const needsQuote = !/^[A-Za-z_]\w*$/.test(f.name);
                const it = new vscode.CompletionItem(f.name, vscode.CompletionItemKind.Field);
                it.detail = `${f.type}${f.sample ? ' · ' + f.sample : ''}`;
                it.documentation = 'Field found in the Exerciser input JSON';
                if (needsQuote) it.insertText = '`' + f.name + '`';
                it.sortText = `1_${f.name}`;
                items.push(it);
              }
            }
          }
          for (const k of KEYWORDS) {
            const it = new vscode.CompletionItem(k, vscode.CompletionItemKind.Keyword);
            it.sortText = `2_${k}`;
            items.push(it);
          }
          return items;
        }
      },
      '$',
      '.'
    )
  );

  // --- hover: function docs and field info ---
  subs.push(
    vscode.languages.registerHoverProvider(SELECTOR, {
      provideHover(doc, pos) {
        const range = doc.getWordRangeAtPosition(pos, /\$\$|\$[A-Za-z_]\w*|`[^`]+`|[A-Za-z_]\w*/);
        if (!range) return undefined;
        const word = doc.getText(range);
        if (word === '$$') return new vscode.Hover('`$$` — the root of the input document', range);
        if (word === '$') return new vscode.Hover('`$` — the current context item', range);
        if (word.startsWith('$')) {
          const md = fnMarkdown(word.slice(1));
          return md ? new vscode.Hover(md, range) : undefined;
        }
        const name = word.replace(/^`|`$/g, '');
        const f = allFields(session.inputJson).find((x) => x.name === name);
        if (f) {
          const md = new vscode.MarkdownString();
          md.appendMarkdown(`**${name}** — field in input (${f.type})`);
          if (f.sample) md.appendCodeblock(f.sample, 'json');
          return new vscode.Hover(md, range);
        }
        return undefined;
      }
    })
  );

  // --- signature help ---
  subs.push(
    vscode.languages.registerSignatureHelpProvider(
      SELECTOR,
      {
        provideSignatureHelp(doc, pos) {
          const text = doc.getText(new vscode.Range(new vscode.Position(0, 0), pos));
          const ctx = callContextAt(text);
          if (!ctx) return undefined;
          const f = FUNCTION_BY_NAME.get(ctx.name);
          if (!f) return undefined;
          const sig = new vscode.SignatureInformation(f.signature, f.description);
          sig.parameters = paramLabels(f).map(([a, b]) => new vscode.ParameterInformation([a, b]));
          const help = new vscode.SignatureHelp();
          help.signatures = [sig];
          help.activeSignature = 0;
          help.activeParameter = Math.min(ctx.argIndex, Math.max(0, sig.parameters.length - 1));
          return help;
        }
      },
      '(',
      ','
    )
  );

  // --- formatter (Prettier printer on top of the official parser, AST-verified) ---
  const formatText = async (doc: vscode.TextDocument, options?: vscode.FormattingOptions) => {
    const cfg = vscode.workspace.getConfiguration('jsonataExerciser');
    const text = doc.getText();
    const formatted = await formatJsonata(text, {
      printWidth: cfg.get<number>('format.printWidth', 80),
      objectLayout: cfg.get<'auto' | 'preserve' | 'expanded'>('format.objectLayout', 'preserve'),
      tabWidth: options?.tabSize ?? 2,
      useTabs: options ? !options.insertSpaces : false
    });
    return formatted === text
      ? []
      : [vscode.TextEdit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)), formatted)];
  };
  subs.push(
    vscode.languages.registerDocumentFormattingEditProvider(SELECTOR, {
      async provideDocumentFormattingEdits(doc, options) {
        try {
          return await formatText(doc, options);
        } catch (e) {
          if (e instanceof FormatError) void vscode.window.showWarningMessage(`JSONata: ${e.message}`);
          else throw e;
          return [];
        }
      }
    })
  );

  return subs;
}
