import * as vscode from 'vscode';

/**
 * Tiny in-memory file system so the Exerciser panes get proper tab names (input.json,
 * expression.jsonata), full language-service support, and never trigger "save changes?" prompts.
 */
export class MemFs implements vscode.FileSystemProvider {
  static readonly scheme = 'jsonata-exerciser';
  private files = new Map<string, { data: Uint8Array; ctime: number; mtime: number }>();
  private emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  private key(uri: vscode.Uri): string {
    return uri.path;
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    if (uri.path === '/') return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    const f = this.files.get(this.key(uri));
    if (!f) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: vscode.FileType.File, ctime: f.ctime, mtime: f.mtime, size: f.data.byteLength };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [...this.files.keys()].map((k) => [k.replace(/^\//, ''), vscode.FileType.File]);
  }

  createDirectory(): void {
    /* flat file system */
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const f = this.files.get(this.key(uri));
    if (!f) throw vscode.FileSystemError.FileNotFound(uri);
    return f.data;
  }

  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    const k = this.key(uri);
    const existing = this.files.get(k);
    const now = Date.now();
    this.files.set(k, { data: content, ctime: existing?.ctime ?? now, mtime: now });
    this.emitter.fire([{ type: existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
  }

  delete(uri: vscode.Uri): void {
    this.files.delete(this.key(uri));
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  rename(oldUri: vscode.Uri, newUri: vscode.Uri): void {
    const f = this.files.get(this.key(oldUri));
    if (!f) throw vscode.FileSystemError.FileNotFound(oldUri);
    this.files.delete(this.key(oldUri));
    this.files.set(this.key(newUri), f);
    this.emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri }
    ]);
  }

  /** Convenience for the session: write text without firing UI-visible change if unchanged. */
  writeText(uri: vscode.Uri, text: string): void {
    this.writeFile(uri, new TextEncoder().encode(text));
  }
}

/** Read-only virtual document for the result pane. */
export class ResultContent implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'jsonata-result';
  static readonly uri = vscode.Uri.parse(`${ResultContent.scheme}:/result.json`);
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private text = '';

  provideTextDocumentContent(): string {
    return this.text;
  }

  set(text: string): void {
    if (text === this.text) return;
    this.text = text;
    this.emitter.fire(ResultContent.uri);
  }

  get current(): string {
    return this.text;
  }
}
