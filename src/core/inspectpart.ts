import type { Evaluator } from './evaluator';
import { isValidSpan, pathPrefixes } from './probe';

/**
 * Evaluates a part of an expression in its real context and returns a readable report. Used by the
 * Copilot tool and the MCP server so AI assistants can debug step by step like the editor does.
 */
export async function inspectPart(
  evaluator: Evaluator,
  args: { expression: string; part: string; input?: string; occurrence?: number; timeoutMs?: number }
): Promise<{ text: string; isError: boolean }> {
  const { expression, part } = args;
  const trimmed = part.trim();
  if (!trimmed) return { text: 'Provide the part of the expression to inspect.', isError: true };

  // find the n-th occurrence of the text inside the expression
  let idx = -1;
  for (let n = 0; n <= (args.occurrence ?? 0); n++) {
    idx = expression.indexOf(trimmed, idx + 1);
    if (idx < 0) break;
  }
  if (idx < 0) return { text: 'That text does not occur in the expression.', isError: true };
  const span = { start: idx, end: idx + trimmed.length };
  if (!isValidSpan(expression, span)) {
    return { text: `"${trimmed}" is not a complete sub-expression at that position (it must parse on its own).`, isError: true };
  }
  const steps = pathPrefixes(trimmed).map((p) => ({ start: span.start, end: span.start + p.end, label: p.label }));
  const spans = [span, ...steps.filter((s) => s.end !== span.end)];
  const r = await evaluator.evaluate({ expression, input: args.input, probes: spans, timeoutMs: args.timeoutMs });
  if (r.status === 'error') return { text: `${r.phase} error: ${r.error.message}`, isError: true };
  if (r.status !== 'probe') return { text: `Inspection ${r.status}.`, isError: true };

  const describe = (p: (typeof r.results)[number]): string => {
    if (p.parseError) return 'cannot be inspected on its own';
    if (p.calls === 0) return 'not reached (nothing evaluated here; e.g. an earlier step matched nothing)';
    const head = p.calls === 1 ? 'evaluated once' : `evaluated ${p.calls} times (e.g. once per item)`;
    const vals = p.values.slice(0, 5).map((v, i) => (p.calls === 1 ? v : `#${i + 1}: ${v}`));
    return `${head}\n${vals.join('\n')}${p.calls > 5 ? '\n...' : ''}`;
  };
  const compact = (v: string): string => {
    let t = v;
    try {
      t = JSON.stringify(JSON.parse(v));
    } catch {
      /* keep as is */
    }
    return t.length > 120 ? t.slice(0, 119) + '…' : t;
  };
  const brief = (p: (typeof r.results)[number]): string => {
    if (p.parseError || p.calls === 0) return describe(p);
    const vals = p.values.slice(0, 3).map(compact).join(', ');
    return `${p.calls === 1 ? 'once' : p.calls + ' times'}: ${vals}${p.calls > 3 ? ', …' : ''}`;
  };
  const lines = [`Part: ${trimmed}`, describe(r.results[0])];
  if (steps.length) {
    lines.push('', 'Step by step:');
    let k = 1;
    for (const s of steps) {
      const p = s.end === span.end ? r.results[0] : r.results[k++];
      lines.push(`- ${s.label}: ${brief(p)}`);
    }
  }
  const err = r.results[0].error;
  if (err && r.results[0].calls > 0) lines.push('', `Note: the full expression fails later: ${err.code ?? ''} ${err.message}`);
  return { text: lines.join('\n'), isError: false };
}
