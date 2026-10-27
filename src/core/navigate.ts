/**
 * Navigation between data and expression:
 *  - input JSON -> JSONata path (click a field, get `orders.items.price`)
 *  - result value -> the part of the expression that produced it
 *
 * Pure functions plus one helper that runs the probes; no `vscode` imports.
 */
import { isDeepStrictEqual } from 'node:util';
import type { Evaluator } from './evaluator';
import { allSpans, ProbeValue, Span } from './probe';

// ------------------------------------------------------------ JSON positions

export type PathSegment = string | number;

export interface JsonNode {
  /** Range of the value itself. */
  start: number;
  end: number;
  /** Range of the member (key + value) when the value belongs to an object key. */
  keyStart?: number;
  path: PathSegment[];
}

/** Tolerant scanner (comments allowed) that returns every value with its position and path. */
export function scanJson(text: string): JsonNode[] {
  const nodes: JsonNode[] = [];
  let i = 0;
  const n = text.length;

  const ws = () => {
    while (i < n) {
      if (/\s/.test(text[i])) i++;
      else if (text.startsWith('//', i)) while (i < n && text[i] !== '\n') i++;
      else if (text.startsWith('/*', i)) {
        const e = text.indexOf('*/', i + 2);
        i = e < 0 ? n : e + 2;
      } else break;
    }
  };

  const str = () => {
    i++;
    while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i = Math.min(i + 1, n);
  };

  const value = (path: PathSegment[], keyStart?: number): void => {
    ws();
    const start = i;
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      while (i < n && text[i] !== '}') {
        const before = i;
        ws();
        if (text[i] === '"') {
          const ks = i;
          str();
          let key = text.slice(ks + 1, i - 1);
          try {
            key = JSON.parse(text.slice(ks, i));
          } catch {
            /* keep raw */
          }
          ws();
          if (text[i] === ':') i++;
          value([...path, key], ks);
        } else if (i < n && text[i] !== '}') {
          i++;
        }
        ws();
        if (text[i] === ',') i++;
        ws();
        if (i === before) i++;
      }
      if (text[i] === '}') i++;
    } else if (c === '[') {
      i++;
      ws();
      let idx = 0;
      while (i < n && text[i] !== ']') {
        const before = i;
        value([...path, idx++]);
        ws();
        if (text[i] === ',') i++;
        ws();
        if (i === before) i++;
      }
      if (text[i] === ']') i++;
    } else if (c === '"') {
      str();
    } else if (i < n) {
      i++;
      while (i < n && !/[\s,}\]]/.test(text[i])) i++;
    }
    nodes.push({ start, end: i, keyStart, path });
  };

  value([]);
  return nodes;
}

/** The innermost value (or object member, when the cursor is on its key) at the offset. */
export function jsonNodeAt(text: string, offset: number): JsonNode | undefined {
  let best: JsonNode | undefined;
  let bestSize = Infinity;
  for (const nd of scanJson(text)) {
    const from = nd.keyStart ?? nd.start;
    if (offset < from || offset > nd.end) continue;
    const size = nd.end - from;
    if (size < bestSize) {
      best = nd;
      bestSize = size;
    }
  }
  return best;
}

// ------------------------------------------------------------ JSONata paths

const RESERVED = new Set(['and', 'or', 'in', 'true', 'false', 'null', 'function', 'λ']);

function stepName(key: string): string {
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(key) && !RESERVED.has(key) ? key : '`' + key.replace(/`/g, '') + '`';
}

/**
 * Converts a JSON path to a JSONata path. Array indexes are dropped by default because JSONata maps
 * over arrays automatically (`orders[1].id` becomes `orders.id`); `includeIndexes` keeps them.
 */
export function toJsonataPath(path: PathSegment[], includeIndexes = false): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') {
      if (includeIndexes) out = (out || '$') + `[${seg}]`;
    } else {
      out = out ? `${out}.${stepName(seg)}` : stepName(seg);
    }
  }
  return out || '$';
}

// ------------------------------------------------------------ result -> expression

export interface TraceMatch extends Span {
  /** The part's value equals the clicked value (otherwise the clicked value is an item of it). */
  exact: boolean;
  /** The part follows a literal `key:` that matches the clicked member. */
  keyed: boolean;
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseValue(s: string): { ok: boolean; v?: unknown } {
  try {
    return { ok: true, v: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

/**
 * Finds the parts of an expression whose value is (or contains) `target`. Best match first:
 * a part that follows the matching `"key":` wins, then exact matches (smallest part first), then
 * parts whose value is an array containing the target.
 */
export function matchResult(
  expression: string,
  probes: ProbeValue[],
  target: unknown,
  opts: { key?: string; atRoot?: boolean } = {}
): TraceMatch[] {
  const whole = expression.trim();
  const found: TraceMatch[] = [];
  const keyRe = opts.key
    ? new RegExp(`(?:"${esc(opts.key)}"|'${esc(opts.key)}'|\`${esc(opts.key)}\`|(?<![\\w$])${esc(opts.key)})\\s*:\\s*$`)
    : undefined;

  for (const p of probes) {
    if (p.parseError || p.calls === 0) continue;
    let exact = false;
    let inside = false;
    for (const raw of p.values) {
      const pv = parseValue(raw);
      if (!pv.ok) continue;
      if (isDeepStrictEqual(pv.v, target)) exact = true;
      else if (Array.isArray(pv.v) && pv.v.some((x) => isDeepStrictEqual(x, target))) inside = true;
    }
    if (!exact && !inside) continue;
    const keyed = !!keyRe && keyRe.test(expression.slice(0, p.start));
    found.push({ start: p.start, end: p.end, exact, keyed });
  }

  const isWhole = (m: Span) => expression.slice(m.start, m.end).trim() === whole;
  let list = found.filter((m) => opts.atRoot || !isWhole(m));
  if (list.length === 0) list = found; // fall back to the whole expression, better than nothing

  const rank = (m: TraceMatch) => (m.keyed && m.exact ? 0 : m.keyed ? 1 : m.exact ? 2 : 3);
  return list.sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    const la = a.end - a.start;
    const lb = b.end - b.start;
    return a.keyed ? lb - la : la - lb; // keyed: the whole value expression; else the smallest source
  });
}

export interface ProbeSet {
  probes: ProbeValue[];
  truncated: boolean;
}

/** Probes every part of the expression once (cap keeps huge expressions responsive). */
export async function probeAllParts(
  evaluator: Evaluator,
  args: { expression: string; input?: string; timeoutMs?: number; maxParts?: number }
): Promise<ProbeSet | undefined> {
  const all = allSpans(args.expression);
  const cap = args.maxParts ?? 250;
  const spans = all.slice(0, cap);
  const r = await evaluator.evaluate({ expression: args.expression, input: args.input, probes: spans, timeoutMs: args.timeoutMs });
  if (r.status !== 'probe') return undefined;
  return { probes: r.results, truncated: all.length > cap };
}
