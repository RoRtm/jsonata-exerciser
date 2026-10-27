/**
 * Editor-independent IntelliSense helpers: data-aware field suggestions derived from the input
 * JSON, and call-context detection for signature help.
 */

export interface FieldInfo {
  name: string;
  type: string;
  sample?: string;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function sampleOf(v: unknown): string | undefined {
  if (v === null || typeof v === 'object') return undefined;
  const s = JSON.stringify(v);
  return s.length > 40 ? s.slice(0, 37) + '...' : s;
}

/** Values reachable from `v` one level down (arrays are flattened like JSONata does). */
function children(v: unknown): unknown[] {
  if (Array.isArray(v)) return v.flatMap(children);
  return [v];
}

function fieldsOf(nodes: unknown[], into: Map<string, FieldInfo>): void {
  for (const n of nodes) {
    for (const item of children(n)) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        for (const [k, val] of Object.entries(item as Record<string, unknown>)) {
          if (!into.has(k)) into.set(k, { name: k, type: typeOf(val), sample: sampleOf(val) });
        }
      }
    }
  }
}

function descend(nodes: unknown[], key: string): unknown[] {
  const out: unknown[] = [];
  for (const n of nodes) {
    for (const item of children(n)) {
      if (item && typeof item === 'object' && !Array.isArray(item) && key in (item as object)) {
        out.push((item as Record<string, unknown>)[key]);
      }
    }
  }
  return out;
}

/** Finds all values stored under `key` anywhere in the document (depth-limited). */
function findByKey(root: unknown, key: string, limit = 200): unknown[] {
  const out: unknown[] = [];
  const stack: Array<[unknown, number]> = [[root, 0]];
  while (stack.length && out.length < limit) {
    const [v, depth] = stack.pop()!;
    if (depth > 12 || v === null || typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      for (const x of v) stack.push([x, depth + 1]);
    } else {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k === key) out.push(val);
        stack.push([val, depth + 1]);
      }
    }
  }
  return out;
}

/** All distinct keys anywhere in the document. */
export function allFields(root: unknown, limit = 500): FieldInfo[] {
  const map = new Map<string, FieldInfo>();
  const stack: Array<[unknown, number]> = [[root, 0]];
  while (stack.length && map.size < limit) {
    const [v, depth] = stack.pop()!;
    if (depth > 12 || v === null || typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 50)) stack.push([x, depth + 1]);
    } else {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (!map.has(k)) map.set(k, { name: k, type: typeOf(val), sample: sampleOf(val) });
        stack.push([val, depth + 1]);
      }
    }
  }
  return [...map.values()];
}

/** Values reached by following a path (`a.b.c`) from the root; the first step may be found anywhere. */
function resolveSegments(root: unknown, segments: string[]): unknown[] {
  let nodes: unknown[];
  let rest = segments;
  if (segments[0] === '$' || segments[0] === '$$') {
    nodes = [root];
    rest = segments.slice(1);
  } else {
    const first = segments[0];
    const atRoot = descend([root], first);
    nodes = atRoot.length ? atRoot : findByKey(root, first);
    rest = segments.slice(1);
  }
  for (const seg of rest) {
    nodes = descend(nodes, seg);
    if (nodes.length === 0) break;
  }
  return nodes;
}

const SEGMENT = '(?:[A-Za-z_][\\w]*|`[^`]*`|\\$\\$|\\$)';
const CHAIN_RE = new RegExp(`(${SEGMENT}(?:\\s*\\.\\s*${SEGMENT})*)\\s*\\.\\s*([\\w]*)$`);

function unquote(seg: string): string {
  return seg.startsWith('`') ? seg.slice(1, -1) : seg;
}

/**
 * Given the text before the cursor, returns the field suggestions that make sense after a '.'.
 * `Account.Order.|` -> keys of Account.Order. Falls back to every key in the document when the
 * path cannot be resolved (e.g. inside predicates or after function calls).
 */
export function fieldSuggestions(root: unknown, textBefore: string): FieldInfo[] {
  if (root === undefined) return [];
  const m = CHAIN_RE.exec(textBefore);
  if (!m) return allFields(root);
  const segments = m[1].split('.').map((s) => unquote(s.trim()));
  const nodes = resolveSegments(root, segments);
  if (nodes.length === 0) return allFields(root);
  const into = new Map<string, FieldInfo>();
  fieldsOf(nodes, into);
  return into.size ? [...into.values()] : [];
}

export interface CallContext {
  name: string; // function name without $
  argIndex: number;
}

/**
 * Finds the innermost unclosed `$name(` call at the end of `text` and which argument the cursor
 * is in. Strings, comments and regex-ish content are skipped.
 */
export function callContextAt(text: string): CallContext | undefined {
  const stack: Array<{ name?: string; commas: number }> = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return undefined; // inside a comment
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) return undefined; // inside a string
      i = j + 1;
      continue;
    }
    if (c === '(') {
      const before = text.slice(0, i);
      const m = /\$([A-Za-z_]\w*)\s*$/.exec(before);
      stack.push({ name: m?.[1], commas: 0 });
    } else if (c === '[' || c === '{') {
      stack.push({ commas: 0 });
    } else if (c === ')' || c === ']' || c === '}') {
      stack.pop();
    } else if (c === ',' && stack.length) {
      stack[stack.length - 1].commas++;
    }
    i++;
  }
  for (let k = stack.length - 1; k >= 0; k--) {
    const frame = stack[k];
    if (frame.name) return { name: frame.name, argIndex: frame.commas };
    // bracket/brace frames nested inside a call belong to the argument, keep looking outward
  }
  return undefined;
}

// ------------------------------------------------------------ filter value suggestions

export interface ValueSuggestion {
  /** Text to insert (already quoted/escaped for the context). */
  insert: string;
  /** Raw value for display. */
  label: string;
  type: 'string' | 'number' | 'boolean';
  count: number;
}

export interface ValueCompletion {
  /** Quote character the user already typed (none: a value is being started). */
  quote?: '"' | "'";
  /** Number of characters of the value typed so far (the part to replace). */
  partialLength: number;
  field: string;
  values: ValueSuggestion[];
}

const CMP_RE = new RegExp(`(${SEGMENT}(?:\\s*\\.\\s*${SEGMENT})*)\\s*(!?=)\\s*(?:(["'])((?:\\\\.|(?!\\3)[^\\\\])*))?$`);

/**
 * Detects `... [ field = '|` (or `!=`, with or without an opened quote) at the end of `textBefore` and
 * lists the distinct values of that field in the input, most frequent first. Returns undefined when
 * the cursor is not at the value of a comparison inside a predicate.
 */
export function valueCompletion(root: unknown, textBefore: string, max = 200): ValueCompletion | undefined {
  if (root === undefined) return undefined;
  const m = CMP_RE.exec(textBefore);
  if (!m) return undefined;
  const quote = m[3] as '"' | "'" | undefined;
  const partial = m[4] ?? '';

  // must sit inside an unclosed predicate [ ... ]
  let depth = 0;
  let open = -1;
  for (let i = m.index - 1; i >= 0; i--) {
    const c = textBefore[i];
    if (c === ']') depth++;
    else if (c === '[') {
      if (depth === 0) {
        open = i;
        break;
      }
      depth--;
    }
  }
  if (open < 0) return undefined;

  const fieldSegs = m[1].split('.').map((x) => unquote(x.trim()));
  const containerMatch = new RegExp(`(${SEGMENT}(?:\\s*\\.\\s*${SEGMENT})*)\\s*$`).exec(textBefore.slice(0, open));
  const containers = containerMatch ? resolveSegments(root, containerMatch[1].split('.').map((x) => unquote(x.trim()))) : [];

  let nodes: unknown[] = containers;
  for (const seg of fieldSegs) {
    nodes = descend(nodes, seg);
    if (nodes.length === 0) break;
  }
  if (nodes.length === 0) nodes = resolveSegments(root, fieldSegs); // container unknown: search the document

  const counts = new Map<string, { v: string | number | boolean; n: number }>();
  for (const n of nodes) {
    for (const item of children(n)) {
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        const key = `${typeof item}:${item}`;
        const e = counts.get(key);
        if (e) e.n++;
        else counts.set(key, { v: item, n: 1 });
      }
    }
  }

  const values: ValueSuggestion[] = [];
  const esc = (t: string, q: string) => t.replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), '\\' + q);
  for (const { v, n } of [...counts.values()].sort((a, b) => b.n - a.n || String(a.v).localeCompare(String(b.v)))) {
    if (values.length >= max) break;
    if (typeof v === 'string') {
      if (quote) {
        if (quote === "'" && v.includes("'")) continue; // JSONata has no \' escape inside single quotes
        values.push({ insert: esc(v, quote), label: v, type: 'string', count: n });
      } else {
        const q = v.includes("'") ? '"' : "'";
        values.push({ insert: q + esc(v, q) + q, label: v, type: 'string', count: n });
      }
    } else if (!quote) {
      values.push({ insert: String(v), label: String(v), type: typeof v as 'number' | 'boolean', count: n });
    }
  }
  return { quote, partialLength: partial.length, field: m[1], values };
}
