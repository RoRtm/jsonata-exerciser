// Command line runner for JSONata test files (CI):  node test-cli.js [--timeout ms] [--json] <file-or-folder>...
// Finds `*.test.json` files, runs each against its sibling `.jsonata` file with the official library
// and exits with code 1 if any case fails. Fully local; no network.
import * as path from 'node:path';
import { Evaluator } from './core/evaluator';
import { failed, findTestFiles, formatFileRun, runTestFile } from './core/testfiles';
import { summarize } from './core/testing';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  let timeoutMs = 5000;
  let json = false;
  const targets: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--timeout') timeoutMs = Number(args[++i]) || timeoutMs;
    else if (args[i] === '--json') json = true;
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node test-cli.js [--timeout ms] [--json] <test-file-or-folder>...\n\nRuns *.test.json files against their sibling .jsonata expression. Exit code 1 on failures.');
      return 0;
    } else targets.push(args[i]);
  }
  if (targets.length === 0) targets.push('.');

  const files: string[] = [];
  for (const t of targets) {
    try {
      files.push(...(await findTestFiles(t)));
    } catch (e: any) {
      console.error(`Cannot read ${t}: ${e.message}`);
      return 2;
    }
  }
  if (files.length === 0) {
    console.error('No *.test.json files found.');
    return 2;
  }

  const evaluator = new Evaluator({ workerPath: path.join(__dirname, 'worker.js') });
  let bad = false;
  let total = 0;
  let passed = 0;
  const report: unknown[] = [];
  for (const f of files) {
    const r = await runTestFile(evaluator, f, { timeoutMs });
    const s = summarize(r.outcomes);
    total += s.total;
    passed += s.passed;
    if (failed(r)) bad = true;
    if (json) report.push({ testFile: r.testFile, expressionFile: r.expressionFile, error: r.error, problems: r.problems, ...s, cases: r.outcomes.map((o) => ({ name: o.name, status: o.status, message: o.message })) });
    else console.log(formatFileRun(r) + '\n');
  }
  evaluator.dispose();
  if (json) console.log(JSON.stringify({ files: report, total, passed, ok: !bad }, null, 2));
  else console.log(`${files.length} test file(s), ${passed}/${total} cases passed.`);
  return bad ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(2);
  }
);
