/**
 * Performance profiler for JSONata expressions.
 *
 * jsonata has no timing hooks, so the expression is rewritten once: every sub-expression `x` of a
 * nested (non-overlapping) set of parts becomes `$__e($__s(n), x)`. Arguments are evaluated left to
 * right, so `$__s` fires right before `x` starts and `$__e` right after it finished. A single run
 * therefore yields, for every part, how often it was evaluated and how much time it took (inclusive
 * of the parts inside it; re-entrant calls of recursive functions are only counted once). The time
 * spent in a part itself is its inclusive time minus that of its direct children.
 */
import jsonata from 'jsonata';
import { allSpans, Span } from './probe';

export interface ProfileSpan extends Span {
  calls: number;
  /** Total time spent in this part, including everything it contains. */
  inclusiveMs: number;
  /** Time spent in this part itself (without the measured parts inside it); undefined if not broken down. */
  selfMs?: number;
  failed?: boolean;
  /** Nesting depth in the part tree (0 = outermost). */
  depth?: number;
}

export interface ProfileResult {
  /** Wall time of the plain, uninstrumented evaluation. */
  baselineMs: number;
  /** Time of the instrumented outermost parts (100% for the percentages; includes probe overhead). */
  totalMs: number;
  spans: ProfileSpan[];
  runs: number;
  /** Reserved (kept for compatibility). */
  truncated: boolean;
  error?: { code?: string; message: string };
}

const now = () => performance.now();

export interface ProfileOptions {
  /** Maximum number of instrumented parts (default 120). */
  maxParts?: number;
}

interface Node {
  span: Span;
  id: number;
  children: Node[];
  depth: number;
}

/** Largest parts first; keeps only parts that are nested in or disjoint from the ones already kept. */
function laminar(spans: Span[], max: number): Span[] {
  const sorted = [...spans].sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: Span[] = [];
  for (const s of sorted) {
    if (kept.length >= max) break;
    const clash = kept.some((o) => {
      const overlap = s.start < o.end && o.start < s.end;
      const nested = (s.start >= o.start && s.end <= o.end) || (o.start >= s.start && o.end <= s.end);
      return overlap && !nested;
    });
    if (!clash && !kept.some((o) => o.start === s.start && o.end === s.end)) kept.push(s);
  }
  return kept;
}

function buildTree(spans: Span[]): Node[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const roots: Node[] = [];
  const stack: Node[] = [];
  sorted.forEach((span, id) => {
    while (stack.length && !(span.start >= stack[stack.length - 1].span.start && span.end <= stack[stack.length - 1].span.end)) stack.pop();
    const node: Node = { span, id, children: [], depth: stack.length };
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    stack.push(node);
  });
  return roots;
}

function render(text: string, nodes: Node[], from: number, to: number): string {
  let out = '';
  let pos = from;
  for (const n of nodes) {
    out += text.slice(pos, n.span.start);
    out += `$__e($__s(${n.id}), ${render(text, n.children, n.span.start, n.span.end)})`;
    pos = n.span.end;
  }
  return out + text.slice(pos, to);
}

export async function profileExpression(expression: string, data: unknown, opts: ProfileOptions = {}): Promise<ProfileResult> {
  const maxParts = opts.maxParts ?? 120;

  // baseline: warm-up, then the best of up to three plain runs
  let baseline = Infinity;
  let runs = 0;
  try {
    for (let i = 0; i < 3; i++) {
      const c = jsonata(expression);
      const t = now();
      await c.evaluate(data);
      runs++;
      baseline = Math.min(baseline, now() - t);
      if (baseline > 200) break;
    }
  } catch (err: any) {
    return { baselineMs: 0, totalMs: 0, spans: [], runs, truncated: false, error: { code: err?.code, message: String(err?.message ?? err) } };
  }

  const candidates = allSpans(expression);
  // try the full set, then shallower sets if the combined rewrite does not parse or run cleanly
  const attempts = [maxParts, 40, 12, 4];
  const repeats = baseline < 50 ? 3 : 1;
  for (const limit of attempts) {
    const parts = laminar(candidates, limit);
    if (parts.length === 0) break;
    const roots = buildTree(parts);
    const all: Node[] = [];
    const collect = (ns: Node[]) => ns.forEach((n) => (all.push(n), collect(n.children)));
    collect(roots);
    let compiledSrc: string;
    try {
      compiledSrc = render(expression, roots, 0, expression.length);
      jsonata(compiledSrc);
    } catch {
      continue;
    }

    let best: { totals: number[]; calls: number[]; rootTotal: number } | undefined;
    let ok = true;
    for (let r = 0; r < repeats && ok; r++) {
      const totals = new Array(all.length).fill(0);
      const calls = new Array(all.length).fill(0);
      const depth = new Array(all.length).fill(0);
      const start = new Array(all.length).fill(0);
      const c = jsonata(compiledSrc);
      c.registerFunction('__s', (id: number) => {
        if (depth[id] === 0) start[id] = now();
        depth[id]++;
        return id;
      });
      c.registerFunction('__e', (id: number, v: unknown) => {
        depth[id]--;
        calls[id]++;
        if (depth[id] === 0) totals[id] += now() - start[id];
        return v;
      });
      try {
        await c.evaluate(data);
      } catch {
        ok = false;
        break;
      }
      runs++;
      const rootTotal = roots.reduce((a, n) => a + totals[n.id], 0);
      if (!best || rootTotal < best.rootTotal) best = { totals, calls, rootTotal };
    }
    if (!ok || !best) continue;

    // The probes make the instrumented run slower than the plain one, and the extra time is roughly
    // proportional to how often each part runs. Estimate that cost per evaluation from this very run
    // (instrumented total minus plain baseline, spread over all evaluations), subtract it from every
    // part's own time and rescale so that the own times add up to the plain baseline.
    const measuredSelf = new Map<number, number>();
    const flat: Node[] = [];
    const walk = (n: Node) => {
      flat.push(n);
      const kids = n.children.reduce((a, c) => a + best!.totals[c.id], 0);
      measuredSelf.set(n.id, Math.max(0, best!.totals[n.id] - kids));
      n.children.forEach(walk);
    };
    roots.forEach(walk);
    const totalCalls = flat.reduce((a, n) => a + best!.calls[n.id], 0) || 1;
    const perCall = Math.max(0, best.rootTotal - baseline) / totalCalls;
    const adjSelf = new Map<number, number>();
    for (const n of flat) adjSelf.set(n.id, Math.max(0, measuredSelf.get(n.id)! - perCall * best.calls[n.id]));
    const sumAdj = [...adjSelf.values()].reduce((a, b) => a + b, 0);
    const scale = sumAdj > 0 ? Math.min(5, Math.max(0.2, baseline / sumAdj)) : 1;

    const inclOf = new Map<number, number>();
    const visit = (n: Node): number => {
      const incl = adjSelf.get(n.id)! * scale + n.children.reduce((a, c) => a + visit(c), 0);
      inclOf.set(n.id, incl);
      return incl;
    };
    const totalMs = roots.reduce((a, n) => a + visit(n), 0);
    const spans: ProfileSpan[] = [];
    const emit = (n: Node) => {
      spans.push({ ...n.span, calls: best!.calls[n.id], inclusiveMs: inclOf.get(n.id)!, selfMs: adjSelf.get(n.id)! * scale, depth: n.depth });
      n.children.forEach(emit);
    };
    roots.forEach(emit);
    return { baselineMs: baseline, totalMs, spans, runs, truncated: limit < maxParts };
  }
  return { baselineMs: baseline, totalMs: baseline, spans: [], runs, truncated: true };
}

/** Replicates arrays (one level, nearest to the root) `factor` times to simulate larger inputs. */
export function scaleArrays(value: unknown, factor: number, maxItems = 2_000_000): unknown {
  if (factor <= 1) return value;
  let budget = maxItems;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const n = Math.min(v.length * factor, Math.max(v.length, budget));
      budget -= n;
      if (v.length === 0) return v;
      return Array.from({ length: n }, (_, i) => v[i % v.length]);
    }
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value);
}

export interface RankedPart {
  text: string;
  span: ProfileSpan;
  share: number;
}

/** Spans ranked by their own time (non-overlapping), the hot spots of the expression. */
export function hotSpots(expression: string, r: ProfileResult, limit = 10): RankedPart[] {
  const base = r.totalMs || r.baselineMs || 1;
  const ranked = r.spans
    .filter((s) => !s.failed && s.selfMs !== undefined && s.selfMs > 0)
    .sort((a, b) => (b.selfMs ?? 0) - (a.selfMs ?? 0));
  // own times are exclusive by construction (a part's own time excludes the parts inside it), so
  // nested parts can be listed side by side
  const picked = ranked.slice(0, limit);
  return picked.map((s) => ({ text: expression.slice(s.start, s.end), span: s, share: (s.selfMs ?? 0) / base }));
}

/** One row of the "where does the time go" tree. */
export interface TreeRow {
  text: string;
  span: ProfileSpan;
  depth: number;
  /** Share of the total including everything inside the part. */
  share: number;
  /** Share of the total spent in the part itself. */
  ownShare: number;
}

/** Parts in document-tree order with at least `minShare` of the total time (inclusive). */
export function timeTree(expression: string, r: ProfileResult, minShare = 0.03, maxRows = 25): TreeRow[] {
  const total = r.totalMs || r.baselineMs || 1;
  const rows: TreeRow[] = [];
  for (const s of r.spans) {
    if (s.failed) continue;
    const share = s.inclusiveMs / total;
    if (share < minShare) continue;
    rows.push({ text: expression.slice(s.start, s.end), span: s, depth: s.depth ?? 0, share, ownShare: (s.selfMs ?? 0) / total });
  }
  // drop rows that only repeat their single child at (almost) the same share, to keep the tree readable
  const kept: TreeRow[] = [];
  rows.forEach((row, i) => {
    const next = rows[i + 1];
    const same = next && next.depth === row.depth + 1 && row.share - next.share < 0.02 && row.ownShare < 0.02;
    if (!same) kept.push(row);
  });
  // indentation = number of displayed rows that contain this one
  const stack: ProfileSpan[] = [];
  const out = kept.map((row) => {
    while (stack.length && !(row.span.start >= stack[stack.length - 1].start && row.span.end <= stack[stack.length - 1].end)) stack.pop();
    const depth = stack.length;
    stack.push(row.span);
    return { ...row, depth };
  });
  return out.slice(0, maxRows);
}

/** A few concrete, common performance hints derived from the parts that take the most time. */
export function adviceFor(expression: string, r: ProfileResult): string[] {
  const total = r.totalMs || r.baselineMs || 1;
  const heavy = r.spans
    .filter((s) => !s.failed && s.inclusiveMs / total >= 0.2)
    .sort((a, b) => b.inclusiveMs - a.inclusiveMs);
  // per kind of problem keep the most specific (shortest) matching part
  const byKind = new Map<string, { span: ProfileSpan; text: string }>();
  const consider = (kind: string, sp: ProfileSpan, text: string) => {
    const cur = byKind.get(kind);
    if (!cur || text.length < cur.text.length) byKind.set(kind, { span: sp, text });
  };
  for (const sp of heavy) {
    const x = expression.slice(sp.start, sp.end);
    if (sp.calls >= 500 && /\[[^\]]*=[^\]]*\]/.test(x)) consider('filter', sp, x);
    if (/\*\*/.test(x)) consider('descendant', sp, x);
    if (/\$reduce\(/.test(x) && /\$append\(/.test(x)) consider('append', sp, x);
    if (/\$sort\(|\^\(/.test(x) && sp.calls > 1) consider('sort', sp, x);
    if (sp.calls >= 2000 && /\$eval\(/.test(x)) consider('eval', sp, x);
  }
  const out: string[] = [];
  const f = byKind.get('filter');
  if (f) {
    out.push(
      `\`${short(f.text)}\` runs ${f.span.calls}x and filters inside a loop (quadratic). If it looks records up by a key, build an index once, e.g. \`$idx := items{ id: $ }\`, and use \`$lookup($idx, key)\`.`
    );
  }
  const d = byKind.get('descendant');
  if (d) out.push(`\`${short(d.text)}\` uses \`**\`, which walks the whole document. Use an explicit path if you know where the data is.`);
  if (byKind.has('append')) out.push('`$append` inside `$reduce` copies the array on every step (quadratic). Prefer `$map`/`$filter` or a path expression.');
  const so = byKind.get('sort');
  if (so) out.push(`\`${short(so.text)}\` sorts ${so.span.calls} times. Sort once, outside the repeated part.`);
  if (byKind.has('eval')) out.push('`$eval` parses its text on every call; avoid it in loops.');
  return out;
}

function short(s: string): string {
  const t = s.replace(/\s+/g, ' ');
  return t.length > 60 ? t.slice(0, 59) + '…' : t;
}

/** Plain-text report (used by the AI tool). */
export function formatProfileReport(expression: string, r: ProfileResult): string {
  if (r.error) return `Cannot profile: the expression fails: ${r.error.code ?? ''} ${r.error.message}`;
  const lines = [
    `Evaluation time: ${r.baselineMs.toFixed(2)} ms (percentages refer to the total of the measured parts, with the measuring overhead estimated and removed).`,
    '',
    'Where the time goes (share of total, including the parts inside; indented = nested):'
  ];
  for (const row of timeTree(expression, r, 0.03, 14)) {
    lines.push(`${'  '.repeat(Math.min(row.depth, 6))}- ${(row.share * 100).toFixed(0)}%  x${row.span.calls}  ${short(row.text)}${row.ownShare >= 0.1 ? `  (own ${(row.ownShare * 100).toFixed(0)}%)` : ''}`);
  }
  lines.push('', 'Hot spots (own time, without the parts inside):');
  const spots = hotSpots(expression, r, 8);
  if (spots.length === 0) lines.push('- nothing measurable: the expression is too fast to profile. Try a larger input.');
  for (const s of spots) {
    lines.push(`- ${(s.share * 100).toFixed(0)}%  ${(s.span.selfMs ?? 0).toFixed(2)} ms  x${s.span.calls}  ${short(s.text)}`);
  }
  const advice = adviceFor(expression, r);
  if (advice.length) lines.push('', 'Suggestions:', ...advice.map((a) => `- ${a}`));
  return lines.join('\n');
}
