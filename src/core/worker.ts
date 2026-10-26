// Runs in a worker thread. Evaluating here lets the host kill runaway expressions
// (e.g. infinite recursion) without freezing the VS Code extension host.
import { parentPort } from 'node:worker_threads';
import jsonata from 'jsonata';
import { PROBE_FN, Span, ProbeValue, wrapSpan } from './probe';
import { profileExpression, ProfileOptions, ProfileResult } from './profile';

export interface WorkerRequest {
  id: number;
  expression: string;
  input?: string; // JSON text; undefined/blank => no input
  /** When set, evaluates the expression once per span with a value probe at that span. */
  probes?: Span[];
  /** When set, profiles the expression (times its parts) instead of just evaluating it. */
  profile?: ProfileOptions;
}

export type WorkerResponse =
  | { id: number; status: 'profile'; result: ProfileResult; ms: number }
  | { id: number; status: 'probe'; results: ProbeValue[]; ms: number }
  | { id: number; status: 'ok'; text: string; ms: number }
  | { id: number; status: 'empty'; ms: number }
  | {
      id: number;
      status: 'error';
      phase: 'input' | 'parse' | 'eval';
      error: { code?: string; message: string; position?: number; token?: string };
      ms: number;
    };

function plainError(err: any) {
  return {
    code: typeof err?.code === 'string' ? err.code : undefined,
    message: String(err?.message ?? err),
    position: typeof err?.position === 'number' ? err.position : undefined,
    token: typeof err?.token === 'string' ? err.token : undefined
  };
}

parentPort!.on('message', async (req: WorkerRequest) => {
  const t0 = Date.now();
  const reply = (r: Omit<WorkerResponse, 'id' | 'ms'> & Record<string, unknown>) =>
    parentPort!.postMessage({ ...r, id: req.id, ms: Date.now() - t0 });

  let data: unknown = undefined;
  if (req.input !== undefined && req.input.trim() !== '') {
    try {
      data = JSON.parse(req.input);
    } catch (err: any) {
      return reply({ status: 'error', phase: 'input', error: plainError(err) });
    }
  }

  if (req.profile) {
    return reply({ status: 'profile', result: await profileExpression(req.expression, data, req.profile) });
  }

  if (req.probes) {
    const results: ProbeValue[] = [];
    for (const span of req.probes) results.push(await runProbe(req.expression, data, span));
    return reply({ status: 'probe', results });
  }

  let compiled: ReturnType<typeof jsonata>;
  try {
    compiled = jsonata(req.expression);
  } catch (err: any) {
    return reply({ status: 'error', phase: 'parse', error: plainError(err) });
  }

  try {
    const result = await compiled.evaluate(data);
    if (result === undefined) return reply({ status: 'empty' });
    const text = JSON.stringify(
      result,
      (_k, v) => (typeof v === 'function' ? undefined : v),
      2
    );
    return reply({ status: 'ok', text: text ?? '' });
  } catch (err: any) {
    return reply({ status: 'error', phase: 'eval', error: plainError(err) });
  }
});

const MAX_VALUES = 20;
const MAX_CHARS = 20000;

function serialize(v: unknown): string {
  if (v === undefined) return '(undefined)';
  try {
    const t = JSON.stringify(v, (_k, x) => (typeof x === 'function' ? '<function>' : x), 2);
    if (t === undefined) return '<function>';
    return t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) + '\n... (truncated)' : t;
  } catch {
    return '(not serializable)';
  }
}

async function runProbe(expression: string, data: unknown, span: Span): Promise<ProbeValue> {
  const base = { start: span.start, end: span.end };
  let compiled: ReturnType<typeof jsonata>;
  try {
    compiled = jsonata(wrapSpan(expression, span));
  } catch (err: any) {
    return { ...base, calls: 0, values: [], parseError: String(err?.message ?? err) };
  }
  const values: string[] = [];
  let calls = 0;
  compiled.registerFunction(PROBE_FN, (v: unknown) => {
    calls++;
    if (values.length < MAX_VALUES) values.push(serialize(v));
    return v;
  });
  let error: ProbeValue['error'];
  try {
    await compiled.evaluate(data);
  } catch (err: any) {
    error = { code: err?.code, message: String(err?.message ?? err), position: err?.position };
  }
  return { ...base, calls, values, error };
}
