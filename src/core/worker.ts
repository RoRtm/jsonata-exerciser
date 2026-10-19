// Runs in a worker thread. Evaluating here lets the host kill runaway expressions
// (e.g. infinite recursion) without freezing the VS Code extension host.
import { parentPort } from 'node:worker_threads';
import jsonata from 'jsonata';

export interface WorkerRequest {
  id: number;
  expression: string;
  input?: string; // JSON text; undefined/blank => no input
}

export type WorkerResponse =
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
