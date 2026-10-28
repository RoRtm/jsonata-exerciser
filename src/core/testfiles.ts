/**
 * Node file system helpers around core/testing: used by the CI command line runner, the MCP server
 * and the Copilot tool. (The editor reads files through the VS Code file system instead.)
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Evaluator } from './evaluator';
import { CaseOutcome, expressionPathFor, formatReport, parseTestFile, runCases, TestCase } from './testing';

/** A test file, or every `*.test.json` below a directory (node_modules and dot folders are skipped). */
export async function findTestFiles(target: string): Promise<string[]> {
  const st = await fs.stat(target);
  if (st.isFile()) return [target];
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.test\.json$/i.test(e.name)) out.push(p);
    }
  };
  await walk(target);
  return out.sort();
}

export interface FileRun {
  testFile: string;
  expressionFile: string;
  outcomes: CaseOutcome[];
  problems: string[];
  /** Set when nothing could be run (missing expression, unreadable file). */
  error?: string;
}

export async function runTestFile(
  evaluator: Evaluator,
  testFile: string,
  opts: { expressionFile?: string; timeoutMs?: number } = {}
): Promise<FileRun> {
  const expressionFile = opts.expressionFile ?? expressionPathFor(testFile);
  const base: FileRun = { testFile, expressionFile, outcomes: [], problems: [] };
  let text: string;
  let expression: string;
  try {
    text = await fs.readFile(testFile, 'utf8');
  } catch (e: any) {
    return { ...base, error: `Cannot read test file: ${e.message}` };
  }
  try {
    expression = await fs.readFile(expressionFile, 'utf8');
  } catch {
    return { ...base, error: `Expression file not found: ${expressionFile}` };
  }
  const parsed = parseTestFile(text);
  const dir = path.dirname(testFile);
  const loadInput = async (c: TestCase): Promise<string | undefined> => {
    if (c.inputFile) return fs.readFile(path.resolve(dir, c.inputFile), 'utf8');
    return c.input !== undefined ? JSON.stringify(c.input) : undefined;
  };
  const outcomes = await runCases(evaluator, expression, parsed.cases, { loadInput, timeoutMs: opts.timeoutMs });
  return { ...base, outcomes, problems: parsed.problems };
}

export function formatFileRun(r: FileRun, cwd = process.cwd()): string {
  const rel = path.relative(cwd, r.testFile) || r.testFile;
  if (r.error) return `${rel}\n  ${r.error}`;
  const body = formatReport(r.outcomes, rel);
  return r.problems.length ? body + '\n' + r.problems.map((p) => `  warning: ${p}`).join('\n') : body;
}

export function failed(r: FileRun): boolean {
  return !!r.error || r.outcomes.some((o) => o.status !== 'pass');
}
