import jsonata from 'jsonata';
import { FUNCTION_NAMES } from './functions';

/** A problem in an expression, expressed as 0-based character offsets. */
export interface Issue {
  message: string;
  code?: string;
  start: number;
  end: number;
  severity: 'error' | 'warning';
}

export interface Analysis {
  issues: Issue[];
  /** AST from the official parser, if the expression parsed. */
  ast?: any;
}

/** Converts a jsonata error (parse or runtime) into character offsets. */
export function errorToRange(err: any, text: string): { start: number; end: number } {
  const len = text.length;
  let end = typeof err?.position === 'number' ? err.position : len;
  end = Math.max(0, Math.min(end, len));
  let start = end - 1;
  const token = err?.token;
  if (typeof token === 'string' && token.length > 0 && end - token.length >= 0) {
    if (text.substr(end - token.length, token.length) === token) start = end - token.length;
  }
  if (start < 0) start = 0;
  if (end <= start) {
    // zero-width: highlight the previous character (or the last one at EOF)
    start = Math.max(0, Math.min(start, len - 1));
    end = Math.min(len, start + 1);
  }
  return { start, end };
}

export function formatJsonataError(err: any): string {
  if (!err) return 'Unknown error';
  const code = err.code ? `${err.code}: ` : '';
  return `${code}${err.message ?? String(err)}`;
}

/** Walks the AST (every object-valued property) and calls fn for each node. */
function walk(node: any, fn: (n: any) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, fn);
    return;
  }
  if (node && typeof node === 'object') {
    if (typeof node.type === 'string') fn(node);
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (v && typeof v === 'object') walk(v, fn);
    }
  }
}

/** Parses with the official parser and runs a few static checks. */
export function analyze(expression: string): Analysis {
  const issues: Issue[] = [];
  if (expression.trim().length === 0) return { issues };

  let ast: any;
  try {
    ast = (jsonata(expression) as any).ast();
  } catch (err: any) {
    const { start, end } = errorToRange(err, expression);
    issues.push({ message: formatJsonataError(err), code: err?.code, start, end, severity: 'error' });
    return { issues };
  }

  // Static check: calling a $function that is neither built-in nor defined anywhere.
  const defined = new Set<string>();
  walk(ast, (n) => {
    if (n.type === 'bind' && n.lhs?.type === 'variable') defined.add(n.lhs.value);
    if (n.type === 'lambda' && Array.isArray(n.arguments)) {
      for (const a of n.arguments) if (a?.type === 'variable') defined.add(a.value);
    }
    // path step bindings: Order@$o#$i
    if (typeof n.focus === 'string') defined.add(n.focus);
    if (typeof n.index === 'string') defined.add(n.index);
  });
  walk(ast, (n) => {
    if ((n.type === 'function' || n.type === 'partial') && n.procedure?.type === 'variable') {
      const name: string = n.procedure.value;
      if (name === '' || name === '$') return;
      if (FUNCTION_NAMES.has(name) || defined.has(name)) return;
      const pos: number = n.procedure.position ?? n.position ?? 0;
      const needle = `$${name}`;
      let start = pos - needle.length;
      if (start < 0 || expression.substr(start, needle.length) !== needle) {
        const idx = expression.indexOf(needle);
        start = idx >= 0 ? idx : Math.max(0, pos - 1);
      }
      issues.push({
        message: `Unknown function ${needle}(). It is not a JSONata built-in and no variable named "${name}" is defined in this expression (it may still be supplied as a binding).`,
        code: 'W-UNKNOWN-FN',
        start,
        end: Math.min(expression.length, start + needle.length),
        severity: 'warning'
      });
    }
  });

  return { issues, ast };
}

/** Removes position info so two ASTs can be compared structurally. */
function normalizeAst(ast: any): string {
  return JSON.stringify(ast, (k, v) => (k === 'position' ? undefined : v));
}

/** True if both expressions parse to the same AST (ignoring source positions). */
export function sameAst(a: string, b: string): boolean {
  try {
    return normalizeAst((jsonata(a) as any).ast()) === normalizeAst((jsonata(b) as any).ast());
  } catch {
    return false;
  }
}
