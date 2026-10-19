import * as vscode from 'vscode';
import { DEMOS } from './core/demos';
import { FUNCTION_BY_NAME, HELP_LINKS } from './core/functions';
import { MemFs, ResultContent } from './memfs';
import { DiagnosticsManager, registerProviders } from './providers';
import { SessionManager } from './session';
import { registerAi, mcpConfigText } from './ai';

export function activate(ctx: vscode.ExtensionContext): void {
  const memfs = new MemFs();
  const resultContent = new ResultContent();
  const diag = new DiagnosticsManager();
  const session = new SessionManager(ctx, memfs, resultContent, diag);

  ctx.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(MemFs.scheme, memfs, { isCaseSensitive: true }),
    vscode.workspace.registerTextDocumentContentProvider(ResultContent.scheme, resultContent),
    diag,
    session,
    ...registerProviders(session),
    ...registerAi(ctx, session)
  );

  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('jsonataExerciser.open', () => session.open());

  reg('jsonataExerciser.openDemo', async () => {
    const pick = await vscode.window.showQuickPick(
      DEMOS.map((d) => ({ label: d.label, detail: d.description, demo: d })),
      { title: 'JSONata Exerciser: choose a demo', matchOnDetail: true }
    );
    if (pick) await session.open({ demo: pick.demo });
  });

  reg('jsonataExerciser.openWithFiles', async () => {
    const exprDoc = vscode.window.activeTextEditor?.document;
    let exprUri = exprDoc?.languageId === 'jsonata' ? exprDoc.uri : undefined;
    if (!exprUri) {
      const picked = await vscode.window.showOpenDialog({
        title: 'Choose the JSONata expression file',
        filters: { JSONata: ['jsonata'] },
        canSelectMany: false
      });
      exprUri = picked?.[0];
    }
    if (!exprUri) return;
    const pickedInput = await vscode.window.showOpenDialog({
      title: 'Choose the input JSON file',
      filters: { JSON: ['json', 'jsonc'] },
      canSelectMany: false
    });
    if (!pickedInput?.[0]) return;
    await session.open({ inputUri: pickedInput[0], exprUri });
  });

  reg('jsonataExerciser.evaluate', async () => {
    if (!session.active) await session.open();
    else await session.evaluateNow();
  });

  reg('jsonataExerciser.format', () => vscode.commands.executeCommand('editor.action.formatDocument'));
  reg('jsonataExerciser.copyResult', () => session.copyResult());

  const openUrl = (url: string) => vscode.env.openExternal(vscode.Uri.parse(url));

  reg('jsonataExerciser.openHelp', async (arg?: { fn?: string }) => {
    if (arg?.fn) {
      const f = FUNCTION_BY_NAME.get(arg.fn);
      if (f) return openUrl(f.url);
    }
    const fnItems = [...FUNCTION_BY_NAME.values()].map((f) => ({
      label: `$(symbol-function) $${f.name}`,
      description: f.signature,
      detail: f.description,
      url: f.url
    }));
    const linkItems = HELP_LINKS.map((l) => ({
      label: `$(book) ${l.label}`,
      description: l.description,
      detail: undefined as string | undefined,
      url: l.url
    }));
    const pick = await vscode.window.showQuickPick([...linkItems, ...fnItems], {
      title: 'JSONata online help (opens in your browser)',
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (pick) await openUrl(pick.url);
  });

  reg('jsonataExerciser.helpAtCursor', async () => {
    const ed = vscode.window.activeTextEditor;
    const range = ed?.document.getWordRangeAtPosition(ed.selection.active, /\$[A-Za-z_]\w*/);
    const name = range ? ed!.document.getText(range).slice(1) : undefined;
    if (name && FUNCTION_BY_NAME.has(name)) return openUrl(FUNCTION_BY_NAME.get(name)!.url);
    return vscode.commands.executeCommand('jsonataExerciser.openHelp');
  });

  reg('jsonataExerciser.openTryOnline', () => openUrl('https://try.jsonata.org/'));

  reg('jsonataExerciser.copyMcpConfig', async () => {
    await vscode.env.clipboard.writeText(mcpConfigText(ctx));
    void vscode.window.showInformationMessage(
      'MCP server config copied. Paste it into a terminal (Claude Code) or your MCP config file. See README > "Claude".'
    );
  });

  reg('jsonataExerciser.applyExpression', async (expression: string) => {
    if (typeof expression !== 'string') return;
    await session.update({ expression });
    if (!session.active) return;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === session.exprUri.toString());
    if (doc) await vscode.window.showTextDocument(doc, { preserveFocus: false });
  });

  // First-run hint
  if (!ctx.globalState.get<boolean>('jsonataExerciser.welcomed')) {
    void ctx.globalState.update('jsonataExerciser.welcomed', true);
    void vscode.window
      .showInformationMessage('JSONata Exerciser installed. Try a demo?', 'Open Demo', 'Open Exerciser')
      .then((c) => {
        if (c === 'Open Demo') void vscode.commands.executeCommand('jsonataExerciser.openDemo');
        if (c === 'Open Exerciser') void vscode.commands.executeCommand('jsonataExerciser.open');
      });
  }
}

export function deactivate(): void {
  /* subscriptions are disposed by VS Code */
}
