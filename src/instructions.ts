import * as vscode from 'vscode';
import { CHEATSHEET, DIRECTIVES } from './core/cheatsheet';

const BEGIN = '<!-- jsonata-exerciser:begin -->';
const END = '<!-- jsonata-exerciser:end -->';

const TOOL_REFS = ['jsonataExerciserState', 'jsonataInputStructure', 'jsonataEvaluate', 'jsonataValidate', 'jsonataGuide', 'jsonataExerciserUpdate'];

const instructionsFile = `---
description: JSONata conventions and workflow (JSONata is not JavaScript)
applyTo: "**/*.jsonata"
---
${DIRECTIVES}

${CHEATSHEET}`;

const promptFile = `---
mode: agent
description: Write or fix a JSONata expression for my JSON data, tested with the JSONata Exerciser tools
tools: [${TOOL_REFS.map((t) => `'${t}'`).join(', ')}]
---
Goal: \${input:goal:What should the JSONata expression produce? (describe or paste an example output)}

Data and context:
- If the JSONata Exerciser is open, start with #jsonataExerciserState; otherwise use the JSON file I attached or the current file (\${file}) via the \`inputFile\` parameter of #jsonataEvaluate and #jsonataInputStructure.
- Existing expression (if any) is in the Exerciser or in the attached .jsonata file.

${DIRECTIVES}

Use #jsonataGuide if you are unsure about JSONata syntax.
`;

const agentSection = `${BEGIN}
## JSONata

This project uses JSONata (https://docs.jsonata.org), which is NOT JavaScript. When asked to write, fix or explain a JSONata expression:

1. Look at the data first. With the JSONata Exerciser MCP server / VS Code tools use \`jsonata_describe_input\` (or the \`jsonataInputStructure\` tool) on the JSON file, then write paths with the exact key names.
2. Test every expression with \`jsonata_evaluate\` (pass \`input_file\` / \`inputFile\`) and iterate until the result is what the user wants. Never present an untested expression.
3. Return the final expression in one \`\`\`jsonata block plus a short sample of the output; ask for an example output if the target shape is unclear.
4. Call \`jsonata_guide\` if unsure about syntax: equality is \`=\`, string concatenation is \`&\`, no loops/return/arrow functions, arrays flatten in paths, \`items.{...}\` maps to an array, \`items{key: value}\` groups into one object.
${END}
`;

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function writeNew(uri: vscode.Uri, content: string): Promise<'written' | 'skipped'> {
  if (await exists(uri)) {
    const pick = await vscode.window.showWarningMessage(
      `${vscode.workspace.asRelativePath(uri)} already exists. Overwrite it?`,
      { modal: true },
      'Overwrite'
    );
    if (pick !== 'Overwrite') return 'skipped';
  }
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
  return 'written';
}

async function upsertSection(uri: vscode.Uri, section: string): Promise<void> {
  let text = '';
  if (await exists(uri)) text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b >= 0 && e > b) text = text.slice(0, b) + section.trimEnd() + text.slice(e + END.length);
  else text = (text ? text.replace(/\s*$/, '\n\n') : '') + section;
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

/** Writes directive files so Copilot (and Claude Code) know how to work with JSONata in this repo. */
export async function addAiInstructions(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    void vscode.window.showWarningMessage('Open a folder first: the instruction files are created inside the workspace.');
    return;
  }
  const picks = await vscode.window.showQuickPick(
    [
      { label: 'Copilot instructions', description: '.github/instructions/jsonata.instructions.md (applies to *.jsonata)', key: 'ins', picked: true },
      { label: 'Copilot prompt file', description: '.github/prompts/jsonata.prompt.md (run with /jsonata in chat)', key: 'prompt', picked: true },
      { label: 'CLAUDE.md section', description: 'for Claude Code', key: 'claude', picked: true },
      { label: 'AGENTS.md section', description: 'for other coding agents', key: 'agents', picked: false }
    ],
    { canPickMany: true, title: 'Add JSONata directives for AI assistants' }
  );
  if (!picks?.length) return;
  const done: string[] = [];
  for (const p of picks) {
    if (p.key === 'ins') {
      if ((await writeNew(vscode.Uri.joinPath(root, '.github/instructions/jsonata.instructions.md'), instructionsFile)) === 'written') done.push('Copilot instructions');
    } else if (p.key === 'prompt') {
      if ((await writeNew(vscode.Uri.joinPath(root, '.github/prompts/jsonata.prompt.md'), promptFile)) === 'written') done.push('prompt file');
    } else if (p.key === 'claude') {
      await upsertSection(vscode.Uri.joinPath(root, 'CLAUDE.md'), agentSection);
      done.push('CLAUDE.md');
    } else if (p.key === 'agents') {
      await upsertSection(vscode.Uri.joinPath(root, 'AGENTS.md'), agentSection);
      done.push('AGENTS.md');
    }
  }
  if (done.length) {
    void vscode.window.showInformationMessage(
      `JSONata directives written: ${done.join(', ')}. Review and commit them; in Copilot Chat type /jsonata to use the prompt file.`
    );
  }
}
