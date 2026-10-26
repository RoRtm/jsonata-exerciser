/**
 * "Step-through" inspection: find a sub-expression at the cursor and evaluate it in its real context.
 *
 * The trick: the sub-expression `x` inside the full expression is replaced by `$__probe(x)`. The probe
 * function records every value it receives (once per evaluation of that spot, e.g. once per array
 * item) and returns it unchanged, so the surrounding expression still behaves the same. Only the
 * official jsonata parser/evaluator is involved.
 */
import jsonata from 'jsonata';

export interface Span {
  start: number;
  end: number;
}

export const PROBE_FN = '__probe';

export function wrapSpan(text: string, s: Span): string {
  return `${text.slice(0, s.start)}$${PROBE_FN}(${text.slice(s.start, s.end)})${text.slice(s.end)}`;
}

function parses(src: string): boolean {
  try {
    jsonata(src);
    return true;
  } catch {
    return false;
  }
}

/** A span is inspectable if it is a complete expression on its own and the wrapped whole still parses. */
export function isValidSpan(text: string, s: Span): boolean {
  const sub = text.slice(s.start, s.end);
  if (!sub.trim() || sub !== sub.trim()) return false;
  return parses(sub) && parses(wrapSpan(text, s));
}

// ---------------------------------------------------------------- tokenizer

type Kind = 'str' | 'comment' | 'name' | 'var' | 'num' | 'punct';
interface Tok {
  kind: Kind;
  start: number;
  end: number;
  text: string;
}

function tokenize(text: string): Tok[] {
  const toks: Tok[] = [];
  const push = (kind: Kind, start: number, end: number) => toks.push({ kind, start, end, text: text.slice(start, end) });
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      const end = e < 0 ? text.length : e + 2;
      push('comment', i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      const end = Math.min(j + 1, text.length);
      push('str', i, end);
      i = end;
    } else if (c === '`') {
      const j = text.indexOf('`', i + 1);
      const end = j < 0 ? text.length : j + 1;
      push('name', i, end);
      i = end;
    } else if (c === '$') {
      const m = /^\$\$|^\$[A-Za-z_]\w*|^\$/.exec(text.slice(i))!;
      push('var', i, i + m[0].length);
      i += m[0].length;
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i))!;
      push('num', i, i + m[0].length);
      i += m[0].length;
    } else if (/[\p{L}_]/u.test(c)) {
      const m = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(text.slice(i))!;
      push('name', i, i + m[0].length);
      i += m[0].length;
    } else {
      const two = text.slice(i, i + 2);
      const len = ['~>', ':=', '..', '**', '!=', '<=', '>='].includes(two) ? 2 : 1;
      push('punct', i, i + len);
      i += len;
    }
  }
  return toks.filter((t) => t.kind !== 'comment');
}

const OPEN = '([{';
const CLOSE = ')]}';

/** open token index -> close token index, and the reverse. */
function matchBrackets(toks: Tok[]): { open2close: Map<number, number>; close2open: Map<number, number> } {
  const open2close = new Map<number, number>();
  const close2open = new Map<number, number>();
  const stack: number[] = [];
  toks.forEach((t, idx) => {
    if (t.kind !== 'punct') return;
    if (OPEN.includes(t.text)) stack.push(idx);
    else if (CLOSE.includes(t.text)) {
      const o = stack.pop();
      if (o !== undefined && OPEN.indexOf(toks[o].text) === CLOSE.indexOf(t.text)) {
        open2close.set(o, idx);
        close2open.set(idx, o);
      }
    }
  });
  return { open2close, close2open };
}

/**
 * Candidate sub-expressions around `offset`, smallest first. Every candidate is validated with the
 * official parser. Repeated "expand" simply walks this list.
 */
function rawSpans(text: string, offset: number): Span[] {
  const toks = tokenize(text);
  if (toks.length === 0) return [];
  const { open2close, close2open } = matchBrackets(toks);
  const raw: Span[] = [];
  const add = (s: number, e: number) => {
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s && s <= offset && offset <= e) raw.push({ start: s, end: e });
  };

  const isOperandEnd = (k: number) => k >= 0 && (toks[k].kind === 'name' || toks[k].kind === 'var' || close2open.has(k));
  const startOfOperandEndingAt = (k: number): number => {
    let i = k;
    for (;;) {
      if (close2open.has(i)) i = close2open.get(i)!;
      if (i > 0 && OPEN.includes(toks[i].text) && toks[i].kind === 'punct' && isOperandEnd(i - 1)) {
        i = i - 1;
        continue;
      }
      return i;
    }
  };
  const extendLeft = (first: number): number => {
    let i = first;
    while (i >= 2 && toks[i - 1].text === '.' && isOperandEnd(i - 2)) i = startOfOperandEndingAt(i - 2);
    return i;
  };

  // 1. the token under the cursor and the dotted paths / calls / predicates built around it
  let ti = toks.findIndex((t) => t.start <= offset && offset < t.end);
  if (ti < 0) {
    for (let k = toks.length - 1; k >= 0; k--) {
      if (toks[k].end <= offset) {
        ti = k;
        break;
      }
    }
  }
  if (ti >= 0 && ['name', 'var', 'num', 'str'].includes(toks[ti].kind)) {
    // right-extensions: .name chains and trailing (...) [...] {...} groups
    const rights: number[] = [ti];
    let r = ti;
    for (;;) {
      if (toks[r + 1] && toks[r + 1].kind === 'punct' && OPEN.includes(toks[r + 1].text) && open2close.has(r + 1)) {
        r = open2close.get(r + 1)!;
        rights.push(r);
      } else if (toks[r + 1]?.text === '.' && toks[r + 2] && (toks[r + 2].kind === 'name' || toks[r + 2].kind === 'var')) {
        r += 2;
        rights.push(r);
      } else break;
    }
    let l = ti;
    const lefts: number[] = [ti];
    while (l >= 2 && toks[l - 1].text === '.' && isOperandEnd(l - 2)) {
      l = startOfOperandEndingAt(l - 2);
      lefts.push(l);
    }
    for (const lf of lefts) for (const rt of rights) add(toks[lf].start, toks[rt].end);
  }

  // 2. every bracket group around the cursor: argument, inner expression, group with call target / path
  for (const [o, c] of open2close) {
    if (!(toks[o].start <= offset && offset <= toks[c].end)) continue;
    const innerStart = toks[o].end;
    const innerEnd = toks[c].start;
    if (offset >= innerStart && offset <= innerEnd) {
      // segment between top-level , or ;
      let segStart = innerStart;
      let segEnd = innerEnd;
      let k = o + 1;
      let cursorSeg: [number, number] | undefined;
      let curStart = innerStart;
      while (k < c) {
        const t = toks[k];
        if (t.kind === 'punct' && OPEN.includes(t.text) && open2close.has(k)) {
          k = open2close.get(k)! + 1;
          continue;
        }
        if (t.kind === 'punct' && (t.text === ',' || t.text === ';')) {
          if (offset >= curStart && offset <= t.start) cursorSeg = [curStart, t.start];
          curStart = t.end;
        }
        k++;
      }
      if (!cursorSeg && offset >= curStart && offset <= innerEnd) cursorSeg = [curStart, innerEnd];
      if (cursorSeg) {
        segStart = cursorSeg[0];
        segEnd = cursorSeg[1];
        add(segStart, segEnd);
      }
      add(innerStart, innerEnd);
    }
    // a bare (...) / [...] / {...} that is the argument list, predicate or group of something is not an expression of its own
    if (!(o > 0 && isOperandEnd(o - 1))) add(toks[o].start, toks[c].end);
    const first = extendLeft(o > 0 && isOperandEnd(o - 1) ? startOfOperandEndingAt(o - 1) : o);
    add(toks[first].start, toks[c].end);
  }

  // 3. the whole expression
  add(toks[0].start, toks[toks.length - 1].end);

  // Spans that cannot be replaced by a function call without changing what they mean:
  //  - the right side of `~>` (an implicit-argument call such as `$uppercase()`),
  //  - something directly followed by `(` (e.g. `a.$f` of `a.$f(x)`: the call target),
  //  - the tail of a path that ends in a group-by `{...}` (group-by applies to the whole path).
  const semanticOk = (s: Span): boolean => {
    let prev = -1;
    let next = -1;
    for (let k = 0; k < toks.length; k++) {
      if (toks[k].end <= s.start) prev = k;
      if (next < 0 && toks[k].start >= s.end) next = k;
    }
    if (prev >= 0 && toks[prev].text === '~>') return false;
    if (next >= 0 && toks[next].kind === 'punct' && toks[next].text === '(') return false;
    if (prev >= 0 && toks[prev].text === '.') {
      const last = toks.findIndex((t) => t.end === s.end);
      if (last >= 0 && toks[last].text === '}') {
        const open = close2open.get(last);
        if (open !== undefined && open > 0 && isOperandEnd(open - 1)) return false;
      }
    }
    return true;
  };

  const seen = new Set<string>();
  return raw.filter((s) => {
    const key = `${s.start}:${s.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return semanticOk(s);
  });
}

export function candidateSpans(text: string, offset: number): Span[] {
  return rawSpans(text, offset)
    .sort((a, b) => a.end - a.start - (b.end - b.start))
    .filter((s) => isValidSpan(text, s));
}

/** Every inspectable sub-expression of the text (used by the profiler). */
export function allSpans(text: string): Span[] {
  const toks = tokenize(text);
  const map = new Map<string, Span>();
  for (const t of toks) {
    for (const off of [t.start, t.end]) {
      for (const s of rawSpans(text, Math.min(off, text.length))) map.set(`${s.start}:${s.end}`, s);
    }
  }
  return [...map.values()]
    .filter((s) => {
      const sub = text.slice(s.start, s.end);
      return !/^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[0-9][0-9.eE+-]*)$/.test(sub); // plain literals are not worth timing
    })
    .filter((s) => isValidSpan(text, s))
    .sort((a, b) => a.start - b.start || b.end - a.end);
}

/**
 * For a dotted path made of plain steps (a.b.c) returns the cumulative prefixes (a, a.b, a.b.c) as
 * end offsets inside `sub`, so each step's value can be shown.
 */
export function pathPrefixes(sub: string): Array<{ label: string; end: number }> {
  let ast: any;
  try {
    ast = (jsonata(sub) as any).ast();
  } catch {
    return [];
  }
  if (ast?.type !== 'path' || !Array.isArray(ast.steps)) return [];
  const out: Array<{ label: string; end: number }> = [];
  for (const st of ast.steps) {
    const plain =
      (st.type === 'name' || st.type === 'variable') &&
      !st.stages &&
      !st.predicate &&
      !st.group &&
      st.focus === undefined &&
      st.index === undefined &&
      typeof st.position === 'number';
    if (!plain) break;
    const rest = sub.slice(st.position).trimStart();
    if (rest !== '' && rest[0] !== '.') break; // position did not land on a step boundary
    out.push({ label: sub.slice(0, st.position), end: st.position });
  }
  return out.length >= 2 ? out : [];
}

export interface ProbeValue extends Span {
  /** Number of times the probed spot was evaluated (e.g. once per array item). */
  calls: number;
  /** JSON text of the first few values. */
  values: string[];
  parseError?: string;
  /** Error raised by the surrounding expression (possibly after the probe was reached). */
  error?: { code?: string; message: string; position?: number };
}
