import * as vscode from 'vscode';
import * as path from 'node:path';
import { Evaluator, describeResult } from './core/evaluator';
import { analyze } from './core/analyze';
import type { SessionManager } from './session';

const CHAT_ID = 'jsonata-exerciser.jsonata';

const SYSTEM_PROMPT = `You are an expert in JSONata 2.x (the JSON query and transformation language, https://docs.jsonata.org).
Rules:
- Produce JSONata only, never JavaScript, jq or JSONPath. Use "&" for string concatenation, "=" for equality, "and"/"or" as operators, "?:" for conditionals, "$" for the context item and "$$" for the root.
- Arrays are flattened automatically in path expressions; use $map/$filter/$reduce only when a path or predicate is not enough.
- Put the final expression in ONE fenced code block tagged \`jsonata\`. Keep explanations short.
- The expression is checked locally with the official jsonata library after your answer; if you are unsure about a function signature, say so instead of guessing.`;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`;
}

function toolText(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
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
      vscode.lm.registerTool<{ expression: string; input?: string }>('jsonata_evaluate', {
        prepareInvocation: () => ({ invocationMessage: 'Evaluating JSONata locally' }),
        async invoke(options) {
          const r = await toolEvaluator.evaluate({
            expression: options.input.expression,
            input: options.input.input,
            timeoutMs: timeout()
          });
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
              .map((i) => `${i.severity.toUpperCase()} [${i.start}-${i.end}]${i.code ? ' ' + i.code : ''}: ${i.message}`)
              .join('\n')
          );
        }
      }),
      vscode.lm.registerTool<Record<string, never>>('jsonata_getExerciser', {
        prepareInvocation: () => ({ invocationMessage: 'Reading JSONata Exerciser' }),
        async invoke() {
          const s = await session.snapshot();
          if (!s.open) return toolText('The JSONata Exerciser is not open. Run "JSONata: Open Exerciser" first.');
          return toolText(
            [
              '## Expression',
              '```jsonata',
              s.expression,
              '```',
              '## Input',
              '```json',
              truncate(s.input, 20000),
              '```',
              `## Result (${s.status}${s.ms !== undefined ? ', ' + s.ms + ' ms' : ''})`,
              '```',
              truncate(s.result, 8000),
              '```'
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
                .join(' and ')} currently in your Exerciser.`
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
      const context = snap.open
        ? `Current Exerciser state:\nExpression:\n\`\`\`jsonata\n${snap.expression}\n\`\`\`\nInput JSON:\n\`\`\`json\n${truncate(snap.input, 12000)}\n\`\`\`\nCurrent result (${snap.status}):\n\`\`\`\n${truncate(snap.result, 3000)}\n\`\`\``
        : 'The Exerciser is not open; no input data is available.';

      let task = request.prompt;
      if (request.command === 'write') task = `Write a JSONata expression for the current input. Requirement: ${request.prompt}`;
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
        const syntax = issues.find((i) => i.severity === 'error');
        let verdict: string;
        if (syntax) {
          verdict = `Local check: syntax error — ${syntax.message}`;
        } else if (snap.open) {
          const r = await toolEvaluator.evaluate({ expression: proposed, input: snap.input, timeoutMs: timeout() });
          verdict =
            r.status === 'ok'
              ? `Local check against your input: OK.\n\`\`\`json\n${truncate(r.text, 1500)}\n\`\`\``
              : `Local check against your input: ${describeResult(r)}`;
        } else {
          verdict = 'Local check: syntax OK (open the Exerciser to test against data).';
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
