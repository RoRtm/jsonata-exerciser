import * as vscode from 'vscode';
import * as path from 'node:path';
import { Evaluator, describeResult } from './core/evaluator';
import { analyze } from './core/analyze';
import { describeStructure } from './core/schema';
import { inspectPart } from './core/inspectpart';
import { formatProfileReport, scaleArrays } from './core/profile';
import { CHEATSHEET, DIRECTIVES } from './core/cheatsheet';
import { FUNCTIONS } from './core/functions';
import type { SessionManager } from './session';

const CHAT_ID = 'jsonata-exerciser.jsonata';

const SYSTEM_PROMPT = `You are an expert in JSONata 2.x (the JSON query and transformation language, https://docs.jsonata.org).
Rules:
- Produce JSONata only, never JavaScript, jq or JSONPath.
- Base every path on the input structure given below: use the exact key names and nesting. Do not invent keys.
- Put the final expression in ONE fenced code block tagged \`jsonata\`. Keep explanations short.
- The expression is checked locally with the official jsonata library after your answer; if you are unsure about a function signature or the desired output shape, say so or ask for an example output instead of guessing.

${CHEATSHEET}`;

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

interface Hints {
  input?: string;
  expression?: string;
  inputSource?: string;
  expressionSource?: string;
}

/** Hints written inside a chat prompt: ```json / ```jsonata blocks and #file references. */
async function hintsFromRequest(request: vscode.ChatRequest): Promise<Hints> {
  const h: Hints = {};
  for (const ref of request.references ?? []) {
    let uri: vscode.Uri | undefined;
    let range: vscode.Range | undefined;
    let inline: string | undefined;
    if (ref.value instanceof vscode.Uri) uri = ref.value;
    else if (ref.value instanceof vscode.Location) {
      uri = ref.value.uri;
      range = ref.value.range;
    } else if (typeof ref.value === 'string') inline = ref.value;
    if (!uri && inline === undefined) continue;
    try {
      let text: string;
      let name = 'prompt reference';
      if (uri) {
        const doc = await vscode.workspace.openTextDocument(uri);
        text = range ? doc.getText(range) : doc.getText();
        name = displayName(uri);
        const ext = path.extname(uri.path).toLowerCase();
        if (ext === '.jsonata' || doc.languageId === 'jsonata') {
          h.expression = text;
          h.expressionSource = name;
          continue;
        }
        if (ext === '.json' || ext === '.jsonc' || doc.languageId === 'json' || doc.languageId === 'jsonc') {
          h.input = text;
          h.inputSource = name;
          continue;
        }
      } else text = inline!;
      const t = text.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        h.input ??= text;
        h.inputSource ??= name;
      }
    } catch {
      /* unreadable reference: ignore */
    }
  }
  // Fenced blocks inside the prompt win over references.
  for (const m of request.prompt.matchAll(/```(json|jsonc|jsonata)[^\n]*\n([\s\S]*?)```/gi)) {
    if (m[1].toLowerCase() === 'jsonata') {
      h.expression = m[2].trim();
      h.expressionSource = 'code block in your prompt';
    } else {
      h.input = m[2].trim();
      h.inputSource = 'code block in your prompt';
    }
  }
  return h;
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
  // @jsonata chat participant: uses whatever model the user selected in Copilot Chat
  // ------------------------------------------------------------------
  if (typeof vscode.chat?.createChatParticipant === 'function') {
    const handler: vscode.ChatRequestHandler = async (request, chatCtx, stream, token) => {
      const snap = await session.snapshot();
      const hints = await hintsFromRequest(request);

      const input = hints.input ?? (snap.open ? snap.input : undefined);
      const expression = hints.expression ?? (snap.open ? snap.expression : undefined);
      const inputSource = hints.inputSource ?? (snap.open ? `Exerciser input (${displayName(session.inputUri)})` : undefined);
      const exprSource = hints.expressionSource ?? (snap.open ? `Exerciser expression (${displayName(session.exprUri)})` : undefined);

      // Fresh result when the context differs from what the Exerciser shows
      let resultText = snap.open && !hints.input && !hints.expression ? snap.result : '';
      if (!resultText && expression && expression.trim()) {
        resultText = describeResult(await toolEvaluator.evaluate({ expression, input, timeoutMs: timeout() }));
      }

      const parts: string[] = [];
      if (input !== undefined && input.trim()) {
        const parsed = tryParse(input);
        parts.push(`Input JSON (source: ${inputSource}).`);
        if (parsed.ok && parsed.value !== undefined) parts.push(`Input structure:\n${describeStructure(parsed.value)}`);
        else if (!parsed.ok) parts.push(`(Input is not valid JSON: ${parsed.error})`);
        parts.push(`Input data (first part):\n\`\`\`json\n${truncate(input, 8000)}\n\`\`\``);
      } else {
        parts.push(
          'No input JSON is available. Ask the user to open the Exerciser on a JSON file, attach one with #file, or paste a ```json block.'
        );
      }
      if (expression && expression.trim()) {
        parts.push(`Current expression (source: ${exprSource}):\n\`\`\`jsonata\n${expression}\n\`\`\``);
        parts.push(`Result of the current expression:\n\`\`\`\n${truncate(resultText, 3000)}\n\`\`\``);
      }
      const context = parts.join('\n\n');

      let task = request.prompt;
      if (request.command === 'write') task = `Write a JSONata expression for the input. Requirement: ${request.prompt}`;
      if (request.command === 'explain') task = `Explain the current expression step by step and what each part returns. ${request.prompt}`;
      if (request.command === 'fix') task = `The current expression has a problem (see the result/error above). Fix it. ${request.prompt}`;

      const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(`${SYSTEM_PROMPT}\n\n${context}`)
      ];
      for (const turn of chatCtx.history.slice(-6)) {
        if (turn instanceof vscode.ChatRequestTurn) {
          messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
        } else if (turn instanceof vscode.ChatResponseTurn) {
          const text = turn.response
            .filter((p): p is vscode.ChatResponseMarkdownPart => p instanceof vscode.ChatResponseMarkdownPart)
            .map((p) => p.value.value)
            .join('');
          if (text) messages.push(vscode.LanguageModelChatMessage.Assistant(text));
        }
      }
      messages.push(vscode.LanguageModelChatMessage.User(task));

      let full = '';
      try {
        const response = await request.model.sendRequest(messages, {}, token);
        for await (const fragment of response.text) {
          full += fragment;
          stream.markdown(fragment);
        }
      } catch (err) {
        if (err instanceof vscode.LanguageModelError) {
          stream.markdown(`\n\nThe language model request failed: ${err.message}`);
          return { errorDetails: { message: err.message } };
        }
        throw err;
      }

      // Verify the proposed expression locally and offer to apply it.
      const blocks = [...full.matchAll(/```jsonata[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1].trim());
      const proposed = blocks[blocks.length - 1];
      if (proposed) {
        const { issues } = analyze(proposed);
        const syntax = issues.find((x) => x.severity === 'error');
        let verdict: string;
        if (syntax) {
          verdict = `Local check: syntax error — ${syntax.message}`;
        } else if (input !== undefined && input.trim()) {
          const r = await toolEvaluator.evaluate({ expression: proposed, input, timeoutMs: timeout() });
          verdict =
            r.status === 'ok'
              ? `Local check against your input: OK.\n\`\`\`json\n${truncate(r.text, 1500)}\n\`\`\``
              : `Local check against your input: ${describeResult(r)}`;
        } else {
          verdict = 'Local check: syntax OK (no input available to test against).';
        }
        stream.markdown(`\n\n---\n${verdict}\n`);
        stream.button({ command: 'jsonataExerciser.applyExpression', title: 'Apply to Exerciser', arguments: [proposed] });
      }
      return {};
    };

    const participant = vscode.chat.createChatParticipant(CHAT_ID, handler);
    participant.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'images', 'icon.png');
    subs.push(participant);
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
