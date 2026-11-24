import * as vscode from 'vscode';
import * as path from 'node:path';
import { Evaluator, describeResult } from './core/evaluator';
import { analyze } from './core/analyze';
import { describeStructure } from './core/schema';
import { inspectPart } from './core/inspectpart';
import { failed, formatFileRun, runTestFile } from './core/testfiles';
import { formatReport, parseTestFile, runCases } from './core/testing';
import { formatProfileReport, scaleArrays } from './core/profile';
import { CHEATSHEET, DIRECTIVES } from './core/cheatsheet';
import { FUNCTIONS } from './core/functions';
import type { SessionManager } from './session';

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`;
}

function toolText(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e: any) {
    return { ok: false, error: String(e.message ?? e) };
  }
}

/** Resolves an absolute or workspace-relative path to a Uri. */
function resolvePath(p: string): vscode.Uri {
  if (path.isAbsolute(p)) return vscode.Uri.file(p);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) throw new Error(`Cannot resolve relative path "${p}": no workspace folder is open.`);
  return vscode.Uri.joinPath(root, p);
}

async function readFileText(p: string): Promise<string> {
  const uri = resolvePath(p);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

function displayName(uri: vscode.Uri): string {
  return uri.scheme === 'file' || uri.scheme === 'untitled' ? vscode.workspace.asRelativePath(uri) : 'scratch';
}

export function registerAi(ctx: vscode.ExtensionContext, session: SessionManager): vscode.Disposable[] {
  const subs: vscode.Disposable[] = [];
  const toolEvaluator = new Evaluator();
  subs.push({ dispose: () => toolEvaluator.dispose() });
  const timeout = () => vscode.workspace.getConfiguration('jsonataExerciser').get<number>('evaluationTimeoutMs', 5000);

  // ------------------------------------------------------------------
  // Language model tools: usable by GitHub Copilot agent mode (with any model, incl. Claude)
  // ------------------------------------------------------------------
  if (typeof vscode.lm?.registerTool === 'function') {
    subs.push(
      vscode.lm.registerTool<{ expression?: string; expressionFile?: string; input?: string; inputFile?: string }>('jsonata_evaluate', {
        prepareInvocation: () => ({ invocationMessage: 'Evaluating JSONata locally' }),
        async invoke(options) {
          const i = options.input;
          let expression = i.expression;
          let input = i.input;
          try {
            if (expression === undefined && i.expressionFile) expression = await readFileText(i.expressionFile);
            if (input === undefined && i.inputFile) input = await readFileText(i.inputFile);
          } catch (e: any) {
            return toolText(`Cannot read file: ${e.message}`);
          }
          if (expression === undefined) return toolText('Provide "expression" or "expressionFile".');
          const r = await toolEvaluator.evaluate({ expression, input, timeoutMs: timeout() });
          return toolText(describeResult(r));
        }
      }),
      vscode.lm.registerTool<{ expression?: string; expressionFile?: string; part: string; occurrence?: number; input?: string; inputFile?: string }>('jsonata_inspect', {
        prepareInvocation: () => ({ invocationMessage: 'Inspecting part of a JSONata expression' }),
        async invoke(options) {
          const i = options.input;
          let expression = i.expression;
          let input = i.input;
          try {
            if (expression === undefined && i.expressionFile) expression = await readFileText(i.expressionFile);
            if (input === undefined && i.inputFile) input = await readFileText(i.inputFile);
          } catch (e: any) {
            return toolText(`Cannot read file: ${e.message}`);
          }
          if (expression === undefined) return toolText('Provide "expression" or "expressionFile".');
          const r = await inspectPart(toolEvaluator, { expression, part: i.part, occurrence: i.occurrence, input, timeoutMs: timeout() });
          return toolText(r.text);
        }
      }),
      vscode.lm.registerTool<{ expression?: string; expressionFile?: string; input?: string; inputFile?: string; scaleArrays?: number }>('jsonata_profile', {
        prepareInvocation: () => ({ invocationMessage: 'Profiling JSONata expression' }),
        async invoke(options) {
          const i = options.input;
          let expression = i.expression;
          let input = i.input;
          try {
            if (expression === undefined && i.expressionFile) expression = await readFileText(i.expressionFile);
            if (input === undefined && i.inputFile) input = await readFileText(i.inputFile);
          } catch (e: any) {
            return toolText(`Cannot read file: ${e.message}`);
          }
          if (expression === undefined) return toolText('Provide "expression" or "expressionFile".');
          if (input !== undefined && i.scaleArrays && i.scaleArrays > 1) {
            try {
              input = JSON.stringify(scaleArrays(JSON.parse(input), Math.min(i.scaleArrays, 10000)));
            } catch (e: any) {
              return toolText(`Input is not valid JSON: ${e.message}`);
            }
          }
          const r = await toolEvaluator.evaluate({ expression, input, profile: {}, timeoutMs: Math.max(timeout(), 120000) });
          if (r.status === 'profile') return toolText(formatProfileReport(expression, r.result));
          return toolText(describeResult(r));
        }
      }),
      vscode.lm.registerTool<{ expression: string }>('jsonata_validate', {
        prepareInvocation: () => ({ invocationMessage: 'Validating JSONata' }),
        async invoke(options) {
          const { issues } = analyze(options.input.expression);
          if (issues.length === 0) return toolText('OK: expression parses without errors.');
          return toolText(
            issues
              .map((x) => `${x.severity.toUpperCase()} [${x.start}-${x.end}]${x.code ? ' ' + x.code : ''}: ${x.message}`)
              .join('\n')
          );
        }
      }),
      vscode.lm.registerTool<{ input?: string; inputFile?: string }>('jsonata_inputStructure', {
        prepareInvocation: () => ({ invocationMessage: 'Summarizing JSON structure' }),
        async invoke(options) {
          let text = options.input.input;
          let source = 'the provided input';
          try {
            if (text === undefined && options.input.inputFile) {
              text = await readFileText(options.input.inputFile);
              source = options.input.inputFile;
            }
          } catch (e: any) {
            return toolText(`Cannot read file: ${e.message}`);
          }
          if (text === undefined) {
            const snap = await session.snapshot();
            if (!snap.open) return toolText('No input given and the JSONata Exerciser is not open. Pass "input" or "inputFile".');
            text = snap.input;
            source = 'the JSONata Exerciser input';
          }
          const parsed = tryParse(text);
          if (!parsed.ok) return toolText(`Input is not valid JSON: ${parsed.error}`);
          if (parsed.value === undefined) return toolText('Input is empty.');
          return toolText(`Structure of ${source}:\n\n${describeStructure(parsed.value)}`);
        }
      }),
      vscode.lm.registerTool<{ expression?: string; expressionFile?: string; testFile?: string; cases?: string }>('jsonata_runTests', {
        prepareInvocation: () => ({ invocationMessage: 'Running JSONata test cases' }),
        async invoke(options) {
          const i = options.input;
          try {
            if (i.testFile && i.expression === undefined) {
              const r = await runTestFile(toolEvaluator, i.testFile, { expressionFile: i.expressionFile, timeoutMs: timeout() });
              return toolText(formatFileRun(r));
            }
            let expression = i.expression;
            if (expression === undefined && i.expressionFile) expression = await readFileText(i.expressionFile);
            if (expression === undefined) return toolText('Provide "testFile", or "expression"/"expressionFile" together with "cases".');
            const source = i.cases ?? (i.testFile ? await readFileText(i.testFile) : undefined);
            if (source === undefined) return toolText('Provide "cases" or "testFile".');
            const parsed = parseTestFile(source);
            if (parsed.cases.length === 0) return toolText(parsed.problems.join('\n') || 'No test cases found.');
            const path = await import('node:path');
            const base = i.testFile ? path.dirname(i.testFile) : process.cwd();
            const outcomes = await runCases(toolEvaluator, expression, parsed.cases, {
              timeoutMs: timeout(),
              loadInput: async (c) => (c.inputFile ? readFileText(path.resolve(base, c.inputFile)) : c.input !== undefined ? JSON.stringify(c.input) : undefined)
            });
            return toolText(formatReport(outcomes) + (parsed.problems.length ? '\n' + parsed.problems.map((x) => `warning: ${x}`).join('\n') : ''));
          } catch (e: any) {
            return toolText(`Cannot run tests: ${e.message}`);
          }
        }
      }),
      vscode.lm.registerTool<Record<string, never>>('jsonata_guide', {
        prepareInvocation: () => ({ invocationMessage: 'Loading JSONata guide' }),
        async invoke() {
          return toolText(`${CHEATSHEET}\n\nAll built-in functions:\n${FUNCTIONS.map((f) => f.signature).join('\n')}\n\n${DIRECTIVES}`);
        }
      }),
      vscode.lm.registerTool<Record<string, never>>('jsonata_getExerciser', {
        prepareInvocation: () => ({ invocationMessage: 'Reading JSONata Exerciser' }),
        async invoke() {
          const s = await session.snapshot();
          if (!s.open) {
            return toolText(
              'The JSONata Exerciser is not open. Ask the user to run "JSONata: Open Exerciser", or pass data directly to #jsonataEvaluate (input / inputFile).'
            );
          }
          const parsed = tryParse(s.input);
          const structure = parsed.ok && parsed.value !== undefined ? describeStructure(parsed.value) : `(input is not valid JSON: ${parsed.ok ? 'empty' : parsed.error})`;
          return toolText(
            [
              `Input file: ${displayName(session.inputUri)}  |  Expression file: ${displayName(session.exprUri)}`,
              '## Expression',
              '```jsonata',
              s.expression,
              '```',
              `## Result (${s.status}${s.ms !== undefined ? ', ' + s.ms + ' ms' : ''})`,
              '```',
              truncate(s.result, 4000),
              '```',
              '## Input structure',
              structure,
              '## Input (first part)',
              '```json',
              truncate(s.input, 6000),
              '```',
              '',
              DIRECTIVES
            ].join('\n')
          );
        }
      }),
      vscode.lm.registerTool<{ expression?: string; input?: string }>('jsonata_updateExerciser', {
        prepareInvocation: (options) => ({
          invocationMessage: 'Updating JSONata Exerciser',
          confirmationMessages: {
            title: 'Overwrite JSONata Exerciser content?',
            message: new vscode.MarkdownString(
              `This replaces the ${[options.input.expression !== undefined ? 'expression' : '', options.input.input !== undefined ? 'input JSON' : '']
                .filter(Boolean)
                .join(' and ')} currently in your Exerciser (including linked files).`
            )
          }
        }),
        async invoke(options) {
          const r = await session.update({ expression: options.input.expression, input: options.input.input });
          return toolText(r ? describeResult(r) : 'Updated. (empty expression)');
        }
      })
    );
  }

  // ------------------------------------------------------------------
  // Optional: expose the bundled MCP server inside VS Code too
  // ------------------------------------------------------------------
  const mcpEnabled = vscode.workspace.getConfiguration('jsonataExerciser').get<boolean>('ai.registerMcpServerInVsCode', false);
  const lmAny = vscode.lm as any;
  if (mcpEnabled && typeof lmAny.registerMcpServerDefinitionProvider === 'function') {
    subs.push(
      lmAny.registerMcpServerDefinitionProvider('jsonata-exerciser.mcp', {
        provideMcpServerDefinitions: async () => [
          new (vscode as any).McpStdioServerDefinition(
            'JSONata Exerciser',
            process.execPath,
            [mcpServerPath(ctx)],
            { ELECTRON_RUN_AS_NODE: '1' }
          )
        ]
      })
    );
  }

  return subs;
}

export function mcpServerPath(ctx: vscode.ExtensionContext): string {
  return path.join(ctx.extensionUri.fsPath, 'dist', 'mcp-server.js');
}

/** Config snippets for Claude Code / Claude Desktop (which run MCP servers via `node`). */
export function mcpConfigText(ctx: vscode.ExtensionContext): string {
  const p = mcpServerPath(ctx);
  const json = JSON.stringify({ mcpServers: { jsonata: { command: 'node', args: [p] } } }, null, 2);
  return [
    '# Claude Code (run once in a terminal):',
    `claude mcp add jsonata -- node "${p}"`,
    '',
    '# Claude Desktop / .mcp.json / Cursor (merge into your config):',
    json,
    ''
  ].join('\n');
}
