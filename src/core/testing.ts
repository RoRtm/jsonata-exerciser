/**
 * Test cases for JSONata expressions: parsing of `*.test.json` files, running cases against an
 * expression with the official library, and readable diffs. No `vscode` imports, so the same code
 * serves the editor, the Test Explorer, the AI tools and the CI command line runner.
 *
 * File format (`orders.jsonata` -> `orders.test.json`; comments are allowed):
 *
 *   { "cases": [
 *       { "name": "two orders",
 *         "input": { ... }            // or "inputFile": "./orders.json"
 *         "expected": { ... } },      // or "expectUndefined": true, or "expectError": "T2002"
 *       { "name": "no orders", "input": {}, "expectUndefined": true }
 *   ] }
 *
 * A bare array of cases is accepted as well. `tolerance` (number) compares numbers with an
 * absolute tolerance, useful for floating point results.
 */
import { isDeepStrictEqual } from 'node:util';
import type { Evaluator } from './evaluator';
import { scanJson } from './navigate';
import { describeStructure } from './schema';

export interface TestCase {
  name: string;
  description?: string;
  input?: unknown;
  inputFile?: string;
  expected?: unknown;
  expectUndefined?: boolean;
  /** true: any error is expected; string: the error code (for example "T2002") must match. */
  expectError?: boolean | string;
  tolerance?: number;
}

export interface ParsedTests {
  cases: TestCase[];
  /** Human readable problems (the cases that could be read are still returned). */
  problems: string[];
}

/** Removes // and block comments outside strings (so JSONC test files parse as JSON). */
export function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? text.length : e + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export function parseTestFile(text: string): ParsedTests {
  const problems: string[] = [];
  let doc: unknown;
  try {
    doc = JSON.parse(stripComments(text));
  } catch (e: any) {
    return { cases: [], problems: [`Not valid JSON: ${e.message}`] };
  }
  const raw = Array.isArray(doc) ? doc : (doc as any)?.cases;
  if (!Array.isArray(raw)) return { cases: [], problems: ['Expected {"cases": [...]} or an array of cases.'] };
  const cases: TestCase[] = [];
  raw.forEach((c: any, i: number) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      problems.push(`Case ${i + 1} is not an object.`);
      return;
    }
    const hasOutcome = 'expected' in c || c.expectUndefined === true || c.expectError !== undefined;
    if (!hasOutcome) problems.push(`Case ${i + 1} ("${c.name ?? ''}") has no "expected", "expectUndefined" or "expectError".`);
    cases.push({ ...c, name: typeof c.name === 'string' && c.name.trim() ? c.name : `Case ${i + 1}` });
  });
  return { cases, problems };
}

// ------------------------------------------------------------------ comparison

function equal(a: unknown, b: unknown, tol: number): boolean {
  if (tol > 0 && typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tol;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i], tol));
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every((k) => k in (b as object) && equal((a as any)[k], (b as any)[k], tol));
  }
  return isDeepStrictEqual(a, b);
}

const short = (v: unknown): string => {
  const t = v === undefined ? 'undefined' : JSON.stringify(v);
  return t.length > 80 ? t.slice(0, 79) + '…' : t;
};

/** Paths where `expected` and `actual` differ, for example `orders[1].total: expected 5, actual 6`. */
export function diffValues(expected: unknown, actual: unknown, tol = 0, max = 8): string[] {
  const out: string[] = [];
  const walk = (e: unknown, a: unknown, path: string) => {
    if (out.length >= max || equal(e, a, tol)) return;
    if (Array.isArray(e) && Array.isArray(a)) {
      if (e.length !== a.length) out.push(`${path || 'result'}: expected ${e.length} item(s), got ${a.length}`);
      for (let i = 0; i < Math.min(e.length, a.length); i++) walk(e[i], a[i], `${path}[${i}]`);
    } else if (e && a && typeof e === 'object' && typeof a === 'object' && !Array.isArray(e) && !Array.isArray(a)) {
      const keys = new Set([...Object.keys(e as object), ...Object.keys(a as object)]);
      for (const k of keys) {
        const p = path ? `${path}.${k}` : k;
        if (!(k in (e as object))) out.push(`${p}: unexpected key, got ${short((a as any)[k])}`);
        else if (!(k in (a as object))) out.push(`${p}: missing, expected ${short((e as any)[k])}`);
        else walk((e as any)[k], (a as any)[k], p);
        if (out.length >= max) return;
      }
    } else {
      out.push(`${path || 'result'}: expected ${short(e)}, got ${short(a)}`);
    }
  };
  walk(expected, actual, '');
  return out;
}

// ------------------------------------------------------------------ running

export interface CaseOutcome {
  name: string;
  status: 'pass' | 'fail' | 'error';
  message?: string;
  expected?: unknown;
  actual?: unknown;
  /** Pretty-printed JSON for diff views. */
  expectedText?: string;
  actualText?: string;
  ms: number;
}

const pretty = (v: unknown): string => (v === undefined ? '(no result)' : JSON.stringify(v, null, 2));

export interface RunOptions {
  /** Resolves the input JSON text of a case (inline input, input file, ...). */
  loadInput?: (c: TestCase) => Promise<string | undefined>;
  timeoutMs?: number;
}

export async function runCase(evaluator: Evaluator, expression: string, c: TestCase, opts: RunOptions = {}): Promise<CaseOutcome> {
  const t0 = Date.now();
  const done = (o: Omit<CaseOutcome, 'name' | 'ms'>): CaseOutcome => ({ name: c.name, ms: Date.now() - t0, ...o });

  let input: string | undefined;
  try {
    input = opts.loadInput ? await opts.loadInput(c) : c.input !== undefined ? JSON.stringify(c.input) : undefined;
  } catch (e: any) {
    return done({ status: 'error', message: `Cannot load input: ${e.message ?? e}` });
  }

  const r = await evaluator.evaluate({ expression, input, timeoutMs: opts.timeoutMs });
  const wantsError = c.expectError !== undefined && c.expectError !== false;

  if (r.status === 'timeout') return done({ status: 'error', message: `Timed out after ${r.ms} ms.` });
  if (r.status === 'cancelled') return done({ status: 'error', message: 'Cancelled.' });
  if (r.status === 'probe' || r.status === 'profile') return done({ status: 'error', message: 'Unexpected evaluator state.' });

  if (r.status === 'error') {
    if (r.phase === 'input') return done({ status: 'error', message: `Input is not valid JSON: ${r.error.message}` });
    if (wantsError) {
      const want = typeof c.expectError === 'string' ? c.expectError : undefined;
      if (!want || r.error.code === want) return done({ status: 'pass' });
      return done({ status: 'fail', message: `Expected error ${want}, got ${r.error.code ?? 'another error'}: ${r.error.message}` });
    }
    return done({ status: 'error', message: `${r.error.code ? r.error.code + ': ' : ''}${r.error.message}` });
  }

  const actual: unknown = r.status === 'ok' ? JSON.parse(r.text) : undefined;
  if (wantsError) {
    return done({ status: 'fail', message: `Expected an error${typeof c.expectError === 'string' ? ' ' + c.expectError : ''}, but the expression returned ${short(actual)}.`, actual, actualText: pretty(actual) });
  }
  if (c.expectUndefined) {
    if (actual === undefined) return done({ status: 'pass' });
    return done({ status: 'fail', message: `Expected no result, got ${short(actual)}.`, expected: undefined, actual, expectedText: pretty(undefined), actualText: pretty(actual) });
  }
  if (!('expected' in c)) return done({ status: 'error', message: 'The case has no "expected", "expectUndefined" or "expectError".' });

  const tol = c.tolerance ?? 0;
  if (equal(c.expected, actual, tol)) return done({ status: 'pass', actual });
  const diffs = diffValues(c.expected, actual, tol);
  return done({
    status: 'fail',
    message: diffs.join('\n') || 'Result differs from expected.',
    expected: c.expected,
    actual,
    expectedText: pretty(c.expected),
    actualText: pretty(actual)
  });
}

export async function runCases(evaluator: Evaluator, expression: string, cases: TestCase[], opts: RunOptions = {}): Promise<CaseOutcome[]> {
  const out: CaseOutcome[] = [];
  for (const c of cases) out.push(await runCase(evaluator, expression, c, opts));
  return out;
}

export interface Summary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
}

export function summarize(outcomes: CaseOutcome[]): Summary {
  return {
    total: outcomes.length,
    passed: outcomes.filter((o) => o.status === 'pass').length,
    failed: outcomes.filter((o) => o.status === 'fail').length,
    errored: outcomes.filter((o) => o.status === 'error').length
  };
}

/** Plain text report (AI tools, CLI). */
export function formatReport(outcomes: CaseOutcome[], label?: string): string {
  const s = summarize(outcomes);
  const lines: string[] = [];
  if (label) lines.push(label);
  for (const o of outcomes) {
    const mark = o.status === 'pass' ? 'PASS' : o.status === 'fail' ? 'FAIL' : 'ERROR';
    lines.push(`${mark}  ${o.name} (${o.ms} ms)`);
    if (o.message) lines.push(...o.message.split('\n').map((l) => `      ${l}`));
  }
  lines.push(`${s.passed}/${s.total} passed` + (s.failed ? `, ${s.failed} failed` : '') + (s.errored ? `, ${s.errored} errored` : ''));
  return lines.join('\n');
}

// ------------------------------------------------------------------ files and new cases

/** `a/b/orders.jsonata` -> `a/b/orders.test.json` (works for paths and URI paths). */
export function testPathFor(exprPath: string): string {
  return exprPath.replace(/\.jsonata$/i, '') + '.test.json';
}

/** `a/b/orders.test.json` -> `a/b/orders.jsonata`. */
export function expressionPathFor(testPath: string): string {
  return testPath.replace(/\.test\.json$/i, '') + '.jsonata';
}

/** Builds a case from what the Exerciser shows right now (snapshot of the current result). */
export function caseFromResult(args: {
  name: string;
  input?: unknown;
  inputFile?: string;
  result: { status: 'ok'; text: string } | { status: 'empty' } | { status: 'error'; code?: string };
}): TestCase {
  const c: TestCase = { name: args.name };
  if (args.inputFile) c.inputFile = args.inputFile;
  else if (args.input !== undefined) c.input = args.input;
  if (args.result.status === 'ok') c.expected = JSON.parse(args.result.text);
  else if (args.result.status === 'empty') c.expectUndefined = true;
  else c.expectError = args.result.code ?? true;
  return c;
}

/** Adds a case to the text of a test file (strict JSON). Throws when the text cannot be rewritten safely. */
export function appendCase(existingText: string | undefined, c: TestCase): string {
  let doc: any = { cases: [] };
  if (existingText && existingText.trim()) {
    try {
      doc = JSON.parse(existingText);
    } catch {
      throw new Error('The test file contains comments or invalid JSON, so it was not rewritten. Add the case by hand.');
    }
    if (Array.isArray(doc)) doc = { cases: doc };
    if (!doc || !Array.isArray(doc.cases)) throw new Error('The test file has no "cases" array.');
  }
  doc.cases.push(c);
  return JSON.stringify(doc, null, 2) + '\n';
}

/**
 * Adds a case to the text of a test file without touching anything else: comments and formatting
 * stay as they are. Throws when the file has no "cases" array.
 */
export function appendCaseText(existing: string, c: TestCase): string {
  const nodes = scanJson(existing);
  const arr =
    nodes.find((n) => n.path.length === 1 && n.path[0] === 'cases' && existing[n.end - 1] === ']') ??
    nodes.find((n) => n.path.length === 0 && existing[n.start] === '[' && existing[n.end - 1] === ']');
  if (!arr) throw new Error('The test file has no "cases" array.');
  const body = JSON.stringify(c, null, 2)
    .split('\n')
    .map((l) => '    ' + l)
    .join('\n');
  const items = nodes.filter((n) => n.path.length === arr.path.length + 1 && arr.path.every((p, i) => n.path[i] === p) && n.start > arr.start && n.end < arr.end);
  if (items.length === 0) {
    return existing.slice(0, arr.start + 1) + '\n' + body + '\n  ' + existing.slice(arr.end - 1);
  }
  const last = Math.max(...items.map((n) => n.end));
  return existing.slice(0, last) + ',\n' + body + existing.slice(last);
}

const COMMENT_HELP = `// Each case has "input" (inline JSON) or "inputFile" (relative path) plus ONE of:
//   "expected": <value>        the exact result
//   "expectUndefined": true    the expression returns nothing
//   "expectError": "T2002"     the expression fails with this error code (or true for any error)
// Optional: "tolerance": 0.001 compares numbers with a tolerance, "description": "...".`;

/** A new test file whose first case is the working transformation (current input and result). */
export function testFileWithResult(exprName: string, first: TestCase): string {
  return `// Test cases for ${exprName}. Run them from the CodeLens above the expression or the Testing view.
${COMMENT_HELP}
{
  "cases": [
${JSON.stringify(first, null, 2).split('\n').map((l) => '    ' + l).join('\n')}
  ]
}
`;
}

/**
 * A new test file for an expression that does not produce a result yet: the structure of the
 * current input as comments, plus a case skeleton to fill in.
 */
export function testFileSkeleton(args: { exprName: string; reason: string; input?: unknown; inputFile?: string; inputError?: string }): string {
  const structure = args.input !== undefined ? describeStructure(args.input, { maxChars: 2500 }).split('\n') : [];
  const lines: string[] = [
    `// Test cases for ${args.exprName}.`,
    `// No test was generated from a result because ${args.reason}.`,
    COMMENT_HELP
  ];
  if (args.inputFile) lines.push('//', `// The first case uses the current input file (${args.inputFile}).`);
  if (structure.length) lines.push('//', '// Structure of the current input:', ...structure.map((l) => (l ? `//   ${l}` : '//')));
  if (args.inputError) lines.push('//', `// The current input could not be used: ${args.inputError}`);
  const inputLine =
    args.inputFile !== undefined
      ? `      "inputFile": ${JSON.stringify(args.inputFile)},`
      : args.input !== undefined
        ? `      "input": ${JSON.stringify(args.input, null, 2).split('\n').map((l, i) => (i ? '      ' + l : l)).join('\n')},`
        : '      "input": {},';
  return `${lines.join('\n')}
{
  "cases": [
    {
      "name": "current input",
${inputLine}
      // TODO: replace null with the output you expect for this input. Until then this case fails on purpose.
      "expected": null
    }
  ]
}
`;
}
