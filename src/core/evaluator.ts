import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import type { WorkerRequest, WorkerResponse } from './worker';

export type EvalResult =
  | { status: 'ok'; text: string; ms: number }
  | { status: 'empty'; ms: number }
  | {
      status: 'error';
      phase: 'input' | 'parse' | 'eval';
      error: { code?: string; message: string; position?: number; token?: string };
      ms: number;
    }
  | { status: 'timeout'; ms: number }
  | { status: 'cancelled'; ms: number };

export interface EvaluatorOptions {
  /** Path to the bundled worker script (defaults to ./worker.js next to this bundle). */
  workerPath?: string;
  /** When true a new request aborts any request still running (used for live typing). */
  supersede?: boolean;
}

interface Pending {
  resolve: (r: EvalResult) => void;
  timer: NodeJS.Timeout;
  started: number;
}

/**
 * Evaluates JSONata in a worker thread with a hard timeout. Fully local: no network involved.
 */
export class Evaluator {
  private worker?: Worker;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private readonly workerPath: string;
  private readonly supersede: boolean;

  constructor(opts: EvaluatorOptions = {}) {
    this.workerPath = opts.workerPath ?? path.join(__dirname, 'worker.js');
    this.supersede = opts.supersede ?? false;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(this.workerPath);
    w.on('message', (msg: WorkerResponse) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve(msg as EvalResult);
    });
    const fail = (message: string) => {
      this.worker = undefined;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({
          status: 'error',
          phase: 'eval',
          error: { message },
          ms: Date.now() - p.started
        });
        this.pending.delete(id);
      }
    };
    w.on('error', (e) => fail(`Evaluator crashed: ${e.message}`));
    w.on('exit', (code) => {
      if (this.worker === w) fail(`Evaluator stopped unexpectedly (exit code ${code})`);
    });
    this.worker = w;
    return w;
  }

  private killWorker(result: 'timeout' | 'cancelled'): void {
    const w = this.worker;
    this.worker = undefined;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ status: result, ms: Date.now() - p.started });
      this.pending.delete(id);
    }
    void w?.terminate();
  }

  evaluate(req: { expression: string; input?: string; timeoutMs?: number }): Promise<EvalResult> {
    if (this.supersede && this.pending.size > 0) this.killWorker('cancelled');
    const timeoutMs = req.timeoutMs ?? 5000;
    const id = ++this.seq;
    return new Promise<EvalResult>((resolve) => {
      const timer = setTimeout(() => this.killWorker('timeout'), timeoutMs);
      this.pending.set(id, { resolve, timer, started: Date.now() });
      const msg: WorkerRequest = { id, expression: req.expression, input: req.input };
      this.ensureWorker().postMessage(msg);
    });
  }

  /** Starts the worker thread in the background so the first real evaluation is instant. */
  warmUp(): void {
    void this.evaluate({ expression: '1', timeoutMs: 15000 });
  }

  dispose(): void {
    this.killWorker('cancelled');
  }
}

/** Human readable one-liner for a result (used by tools and the status bar). */
export function describeResult(r: EvalResult): string {
  switch (r.status) {
    case 'ok':
      return r.text;
    case 'empty':
      return '(no result: the expression evaluated to undefined)';
    case 'timeout':
      return `Evaluation timed out after ${r.ms} ms (aborted).`;
    case 'cancelled':
      return 'Evaluation cancelled.';
    case 'error': {
      const e = r.error;
      const where = typeof e.position === 'number' ? ` at position ${e.position}` : '';
      const label =
        r.phase === 'input' ? 'Input JSON is invalid' : r.phase === 'parse' ? 'Syntax error' : 'Evaluation error';
      return `${label}${e.code ? ` (${e.code})` : ''}${where}: ${e.message}`;
    }
  }
}
