// Standalone MCP server (stdio) exposing the same local JSONata tools to Claude Code,
// Claude Desktop, Cursor, or any other MCP client. Uses the official MCP SDK and the
// official jsonata library; no network access.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'node:fs/promises';
import { Evaluator, describeResult } from '../core/evaluator';
import { analyze } from '../core/analyze';
import { formatJsonata } from '../core/format';
import { FUNCTIONS, FUNCTION_BY_NAME } from '../core/functions';
import { describeStructure } from '../core/schema';
import { inspectPart } from '../core/inspectpart';
import { CHEATSHEET, DIRECTIVES } from '../core/cheatsheet';

const evaluator = new Evaluator();
const server = new McpServer({ name: 'jsonata-exerciser', version: '1.0.1' });
// The SDK's zod-generic typings are extremely deep; a loose alias keeps type-checking fast and stable.
const tool = server.registerTool.bind(server) as (name: string, config: unknown, cb: (args: any) => unknown) => void;

const text = (t: string, isError = false) => ({
  content: [{ type: 'text' as const, text: t }],
  ...(isError ? { isError: true } : {})
});

tool(
  'jsonata_evaluate',
  {
    title: 'Evaluate JSONata',
    description:
      'Evaluate a JSONata expression against JSON input locally (official jsonata library). ' +
      'Provide the input as a JSON string (`input`) or as a path to a local JSON file (`input_file`).',
    inputSchema: {
      expression: z.string().optional().describe('The JSONata expression (or use expression_file)'),
      expression_file: z.string().optional().describe('Path to a .jsonata file used instead of `expression`'),
      input: z.string().optional().describe('Input document as a JSON string'),
      input_file: z.string().optional().describe('Path to a local JSON file used as input'),
      timeout_ms: z.number().int().min(100).max(60000).optional().describe('Abort after this many ms (default 5000)')
    }
  },
  async ({ expression, expression_file, input, input_file, timeout_ms }) => {
    if (expression === undefined && expression_file) {
      try {
        expression = await fs.readFile(expression_file, 'utf8');
      } catch (e: any) {
        return text(`Cannot read expression_file: ${e.message}`, true);
      }
    }
    if (expression === undefined) return text('Provide `expression` or `expression_file`.', true);
    let doc = input;
    if (doc === undefined && input_file) {
      try {
        doc = await fs.readFile(input_file, 'utf8');
      } catch (e: any) {
        return text(`Cannot read input_file: ${e.message}`, true);
      }
    }
    const r = await evaluator.evaluate({ expression, input: doc, timeoutMs: timeout_ms });
    return text(describeResult(r), r.status === 'error' || r.status === 'timeout');
  }
);

tool(
  'jsonata_validate',
  {
    title: 'Validate JSONata',
    description: 'Parse a JSONata expression and report syntax errors and unknown $function calls. Does not evaluate.',
    inputSchema: { expression: z.string() }
  },
  async ({ expression }) => {
    const { issues } = analyze(expression);
    if (issues.length === 0) return text('OK: expression parses without errors.');
    const lines = issues.map(
      (i) => `${i.severity.toUpperCase()} [${i.start}-${i.end}]${i.code ? ' ' + i.code : ''}: ${i.message}`
    );
    return text(lines.join('\n'), issues.some((i) => i.severity === 'error'));
  }
);

tool(
  'jsonata_format',
  {
    title: 'Format JSONata',
    description: 'Pretty-print a JSONata expression. The result is verified to parse to the identical AST.',
    inputSchema: {
      expression: z.string(),
      print_width: z.number().int().min(20).max(300).optional(),
      object_layout: z.enum(['auto', 'preserve', 'expanded']).optional().describe('preserve (default): keep objects multi-line if written so; expanded: always one key per line; auto: collapse if it fits')
    }
  },
  async ({ expression, print_width, object_layout }) => {
    try {
      return text(await formatJsonata(expression, { printWidth: print_width, objectLayout: object_layout }));
    } catch (e: any) {
      return text(String(e.message ?? e), true);
    }
  }
);

tool(
  'jsonata_function_help',
  {
    title: 'JSONata function reference',
    description: 'Signature, description and documentation URL of a JSONata built-in function (omit name to list all).',
    inputSchema: { name: z.string().optional().describe('Function name with or without leading $') }
  },
  async ({ name }) => {
    if (!name) return text(FUNCTIONS.map((f) => `${f.signature}  - ${f.description}`).join('\n'));
    const f = FUNCTION_BY_NAME.get(name.replace(/^\$/, ''));
    return f
      ? text(`${f.signature}\n${f.description}\n${f.url}`)
      : text(`No built-in function named "${name}".`, true);
  }
);

tool(
  'jsonata_inspect',
  {
    title: 'Inspect part of a JSONata expression',
    description:
      'Step-through debugging: evaluates one sub-expression (`part`, exact text taken from the expression) in its real context and returns the value(s) it produced, once per evaluation (e.g. per array item), plus a step-by-step breakdown for dotted paths. Use it to find out where an expression returns nothing or the wrong value.',
    inputSchema: {
      expression: z.string().optional(),
      expression_file: z.string().optional(),
      part: z.string().describe('Exact text of the sub-expression to inspect, e.g. "orders.items.price"'),
      occurrence: z.number().int().min(0).optional().describe('Which occurrence of `part` (0 = first)'),
      input: z.string().optional(),
      input_file: z.string().optional()
    }
  },
  async ({ expression, expression_file, part, occurrence, input, input_file }) => {
    try {
      if (expression === undefined && expression_file) expression = await fs.readFile(expression_file, 'utf8');
      if (input === undefined && input_file) input = await fs.readFile(input_file, 'utf8');
    } catch (e: any) {
      return text(`Cannot read file: ${e.message}`, true);
    }
    if (expression === undefined) return text('Provide `expression` or `expression_file`.', true);
    const r = await inspectPart(evaluator, { expression, part, occurrence, input });
    return text(r.text, r.isError);
  }
);

tool(
  'jsonata_describe_input',
  {
    title: 'Describe JSON structure',
    description:
      'Compact outline of a JSON document (keys, types, nesting, arrays, optional keys, sample values, example JSONata paths). Call this BEFORE writing a JSONata expression so paths use the exact key names. Pass `input` (JSON text) or `input_file` (path).',
    inputSchema: { input: z.string().optional(), input_file: z.string().optional() }
  },
  async ({ input, input_file }) => {
    let doc = input;
    if (doc === undefined && input_file) {
      try {
        doc = await fs.readFile(input_file, 'utf8');
      } catch (e: any) {
        return text(`Cannot read input_file: ${e.message}`, true);
      }
    }
    if (doc === undefined) return text('Provide `input` or `input_file`.', true);
    try {
      return text(describeStructure(JSON.parse(doc)));
    } catch (e: any) {
      return text(`Input is not valid JSON: ${e.message}`, true);
    }
  }
);

tool(
  'jsonata_guide',
  {
    title: 'JSONata guide',
    description: 'JSONata 2.x cheat sheet, all built-in function signatures and the recommended workflow. JSONata is NOT JavaScript: read this if unsure about syntax.',
    inputSchema: {}
  },
  async () => text(`${CHEATSHEET}\n\nAll built-in functions:\n${FUNCTIONS.map((f) => f.signature).join('\n')}\n\n${DIRECTIVES}`)
);

process.on('exit', () => evaluator.dispose());
server.connect(new StdioServerTransport()).catch((e) => {
  console.error('jsonata-exerciser MCP server failed:', e);
  process.exit(1);
});
