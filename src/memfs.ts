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

  /**
   * Content for scratch files that do not exist yet. VS Code restores editor tabs of this scheme after
   * a restart, when the in-memory files are gone; this makes them open with the last saved content.
   */
  fallback?: (uri: vscode.Uri) => string | undefined;

  private ensure(uri: vscode.Uri): void {
    if (this.files.has(uri.path) || !this.fallback) return;
    const text = this.fallback(uri);
    if (text === undefined) return;
    const now = Date.now();
    this.files.set(uri.path, { data: new TextEncoder().encode(text), ctime: now, mtime: now });
  }

  private key(uri: vscode.Uri): string {
    return uri.path;
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    if (uri.path === '/') return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    this.ensure(uri);
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
    this.ensure(uri);
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

/**
 * Read-only virtual file for the result pane. Implemented as a file system provider (not a content
 * provider) so VS Code can restore the tab after a restart: the extension is activated through
 * `onFileSystem:jsonata-result`. The .jsonc extension gives it comment-tolerant highlighting.
 */
export class ResultContent implements vscode.FileSystemProvider {
  static readonly scheme = 'jsonata-result';
  static readonly uri = vscode.Uri.parse(`${ResultContent.scheme}:/result.jsonc`);
  private emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private text = '// JSONata Exerciser is starting...';
  private mtime = Date.now();

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(): vscode.FileStat {
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: this.mtime,
      size: new TextEncoder().encode(this.text).byteLength,
      permissions: vscode.FilePermission.Readonly
    };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  readFile(): Uint8Array {
    return new TextEncoder().encode(this.text);
  }

  writeFile(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(oldUri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(oldUri);
  }

  set(text: string): void {
    if (text === this.text) return;
    this.text = text;
    this.mtime = Date.now();
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri: ResultContent.uri }]);
  }

  get current(): string {
    return this.text;
  }
}
