import * as vscode from 'vscode';
import { DEMOS, demoInputText } from './core/demos';
import { FUNCTION_BY_NAME, HELP_LINKS } from './core/functions';
import { MemFs, ResultContent } from './memfs';
import { DiagnosticsManager, registerProviders } from './providers';
import { SessionManager, STATE_KEY } from './session';
import { registerAi, mcpConfigText } from './ai';
import { addAiInstructions } from './instructions';
import { Inspector } from './inspect';
import { Profiler } from './profiler';
import { Navigator } from './navigate';

export function activate(ctx: vscode.ExtensionContext): void {
  const memfs = new MemFs();
  const resultContent = new ResultContent();
  const diag = new DiagnosticsManager();
  const session = new SessionManager(ctx, memfs, resultContent, diag);
  const inspector = new Inspector(session);
  const profiler = new Profiler(session);
  const navigator = new Navigator(session);

  // Scratch files vanish with the process; restored editor tabs get the last saved content instead of an error.
  memfs.fallback = (uri) => {
    const saved = ctx.globalState.get<{ input?: string; expression?: string }>(STATE_KEY);
    if (uri.path === '/input.json') return saved?.input ?? demoInputText(DEMOS[0]);
    if (uri.path === '/expression.jsonata') return saved?.expression ?? DEMOS[0].expression;
    return undefined;
  };

  // Register the file systems defensively: right after an update the previous extension host can still
  // hold the scheme, and a throw here would abort activation and leave every command unregistered.
  try {
    ctx.subscriptions.push(
      vscode.workspace.registerFileSystemProvider(MemFs.scheme, memfs, { isCaseSensitive: true }),
      vscode.workspace.registerFileSystemProvider(ResultContent.scheme, resultContent, { isCaseSensitive: true, isReadonly: true })
    );
  } catch (e: any) {
    void vscode.window
      .showWarningMessage(
        `JSONata Exerciser could not register its scratch documents (${e?.message ?? e}). Reload the window to finish the update.`,
        'Reload Window'
      )
      .then((c) => {
        if (c) void vscode.commands.executeCommand('workbench.action.reloadWindow');
      });
  }

  ctx.subscriptions.push(
    diag,
    session,
    inspector,
    profiler,
    navigator,
    ...registerProviders(session),
    ...registerAi(ctx, session)
  );

  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('jsonataExerciser.open', () => session.openFrom());
  const runHandler = () => {
    const ed = vscode.window.activeTextEditor;
    const lang = ed?.document.languageId;
    const ok = ed && ed.document.uri.scheme !== ResultContent.scheme && (lang === 'json' || lang === 'jsonc' || lang === 'jsonata');
    return session.openFrom(ok ? ed!.document.uri : undefined);
  };
  reg('jsonataExerciser.run', runHandler);
  reg('jsonataExerciser.runExpression', runHandler);
  reg('jsonataExerciser.openWith', (uri?: vscode.Uri) => session.openFrom(uri instanceof vscode.Uri ? uri : undefined));
  reg('jsonataExerciser.bindInput', (uri?: vscode.Uri) => session.bindInput(uri instanceof vscode.Uri ? uri : undefined));
  reg('jsonataExerciser.saveAs', (uri?: vscode.Uri) => session.saveScratchAs(uri instanceof vscode.Uri ? uri : undefined));
  reg('jsonataExerciser.resetScratch', () => session.resetScratch());

  reg('jsonataExerciser.openDemo', async () => {
    const pick = await vscode.window.showQuickPick(
      DEMOS.map((d) => ({ label: d.label, detail: d.description, demo: d })),
      { title: 'JSONata Exerciser: choose a demo', matchOnDetail: true }
    );
    if (pick) await session.open({ demo: pick.demo });
  });

  reg('jsonataExerciser.openWithFiles', async () => {
    const active = vscode.window.activeTextEditor?.document;
    let exprUri = active?.languageId === 'jsonata' && active.uri.scheme === 'file' ? active.uri : undefined;
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
    await session.link({ inputUri: pickedInput[0], exprUri });
  });

  reg('jsonataExerciser.evaluate', async () => {
    // From a JSON / .jsonata file that is not yet part of the Exerciser: link it, then evaluate.
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.uri.scheme !== ResultContent.scheme && !session.isSessionUri(ed.document.uri)) {
      const lang = ed.document.languageId;
      if (lang === 'json' || lang === 'jsonc' || lang === 'jsonata') return session.openFrom(ed.document.uri);
    }
    if (!session.active) return session.open();
    return session.evaluateNow();
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

  reg('jsonataExerciser.profile', () => profiler.run());
  reg('jsonataExerciser.profileClear', () => profiler.clear());
  reg('jsonataExerciser.inspect', () => inspector.run({}));
  reg('jsonataExerciser.inspectExpand', () => inspector.run({ expand: true }));
  reg('jsonataExerciser.inspectToggleLive', () => inspector.toggleLive());
  reg('jsonataExerciser.copyPath', () => navigator.copyPath());
  reg('jsonataExerciser.insertPath', () => navigator.insertPath());
  reg('jsonataExerciser.revealSource', () => navigator.revealSource());
  reg('jsonataExerciser.addAiInstructions', () => addAiInstructions());

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

  // Restart with the Exerciser panes open: resume live evaluation once the tabs are restored.
  setTimeout(() => void session.resumeFromTabs().catch(() => undefined), 800);

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
