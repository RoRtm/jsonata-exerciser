# JSONata Exerciser for VS Code

A local, real-time [JSONata](https://jsonata.org) playground and debugger inside VS Code, modeled on the online [JSONata Exerciser](https://try.jsonata.org/), plus a proper editor experience (IntelliSense, validation, formatter) and AI integration (GitHub Copilot and Claude).

* **100% local.** No API calls, no telemetry. Evaluation uses the official [`jsonata`](https://www.npmjs.com/package/jsonata) npm library, bundled into the extension.
* **Real time.** The result pane updates as you type (debounced, configurable).
* **Safe.** Evaluation runs in a worker thread with a timeout, so an endless recursion cannot freeze VS Code.

```
┌───────────────────┬────────────────────────────┐
│ input.json        │ expression.jsonata         │
│ (your JSON)       │ (JSONata, with IntelliSense│
│                   │  + live error squiggles)   │
│                   ├────────────────────────────┤
│                   │ result.json  (live output) │
└───────────────────┴────────────────────────────┘
```

![JSONata Exerciser showing the input JSON, expression editor, and live result panes](images/jsonata-exerciser-screenshot.png)

## Getting started

1. Run **JSONata: Open Exerciser** from the Command Palette (`Ctrl+Shift+P`), or **JSONata: Open Exerciser with Demo...** to start from one of 8 built-in demos (paths, grouping, higher-order functions, regex/dates, recursion, and an intentionally broken expression to practice debugging).
2. Edit the JSON on the left or the expression on the right. The result updates immediately.
3. Your last session is restored the next time you open the Exerciser.

Already have files? **JSONata: Open Exerciser with Existing Files...** wires any `.jsonata` file and any `.json` file into the three-pane view (edits are saved to your real files).

Any `*.jsonata` file also gets syntax highlighting, validation, IntelliSense and formatting on its own.

## Features

| Feature | Details |
| --- | --- |
| Live output | Re-evaluates on every edit; status bar shows timing and errors. `Ctrl+Alt+Enter` forces an evaluation. |
| Validation | Syntax errors come from the official parser with exact positions. Runtime errors (e.g. `T2002`) are underlined in the expression. Calls to unknown `$functions` get a warning. |
| IntelliSense | All built-in `$functions` with signatures and snippets, signature help while typing arguments, hover docs, keywords, variables you defined, and **field names taken from your input JSON** (path-aware: `Account.Order.` suggests the children of `Order`). |
| Formatter | `Shift+Alt+F` / Format Document. Uses the [Stedi Prettier plugin](https://github.com/Stedi/prettier-plugin-jsonata) on top of the official parser. Every result is re-parsed and must produce an identical AST, otherwise the text is left untouched and you get a message. |
| Demos | `JSONata: Open Exerciser with Demo...` |
| Online help | `JSONata: Open Online Help...` (searchable list of doc pages and every function), `Shift+F1` on a `$function`, hover link, and `JSONata: Open try.jsonata.org`. Opens docs.jsonata.org in your browser; the extension itself never makes network calls. |
| Snippets | `map`, `filter`, `reduce`, `sort`, `block`, `fn`, `groupby`, `reshape`, `regex`, ... |

## GitHub Copilot integration

Requires GitHub Copilot Chat. Works with whichever model you select, including Claude models offered through Copilot.

* **Agent mode tools** (referenced as `#jsonataEvaluate`, `#jsonataValidate`, `#jsonataExerciserState`, `#jsonataExerciserUpdate` or picked automatically): the model can evaluate and validate expressions against real data locally, read what is in your Exerciser (expression, input, result, error) and, after confirmation, update it. Example prompt: *"Use #jsonataExerciserState and fix my expression."*
* **`@jsonata` chat participant** with `/write`, `/explain` and `/fix`. It sees your current Exerciser content, answers with a `jsonata` code block, then **verifies the proposed expression locally** against your input and offers an **Apply to Exerciser** button.

Note: AI answers can be wrong. The local check catches syntax errors and shows the real output, but you remain responsible for confirming the logic is what you intended.

## Claude integration

Any Claude surface that supports MCP can use the same tools through the bundled stdio MCP server (`dist/mcp-server.js`, built with the official MCP SDK). Tools: `jsonata_evaluate`, `jsonata_validate`, `jsonata_format`, `jsonata_function_help`.

1. Run **JSONata: Copy MCP Server Config (Claude Code / Claude Desktop)** to copy ready-made snippets with the correct absolute path.
2. **Claude Code** (CLI or VS Code extension): paste `claude mcp add jsonata -- node "<path>/mcp-server.js"` in a terminal. Or put the `mcpServers` JSON into a project `.mcp.json`.
3. **Claude Desktop / Cursor / others:** merge the JSON snippet into their MCP configuration.

The extension folder name contains the version number, so after an extension update re-run the copy command (or copy `mcp-server.js` and `worker.js` together to a fixed folder and point the config there). Node.js 20+ must be on `PATH`.

VS Code users can alternatively enable `jsonataExerciser.ai.registerMcpServerInVsCode` to list the server in VS Code's MCP tools. This is off by default because Copilot already gets the native tools.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `jsonataExerciser.autoEvaluate` | `true` | Evaluate while typing |
| `jsonataExerciser.debounceMs` | `150` | Delay after the last keystroke |
| `jsonataExerciser.evaluationTimeoutMs` | `5000` | Abort long-running evaluations |
| `jsonataExerciser.format.printWidth` | `80` | Formatter line width |
| `jsonataExerciser.intellisense.fieldSuggestions` | `true` | Suggest field names from the input JSON |
| `jsonataExerciser.ai.registerMcpServerInVsCode` | `false` | Also register the MCP server in VS Code |

## Known limitations

* The formatter is the community Prettier plugin. It has at least one printer bug (a predicate after an object constructor, e.g. `a.{"x":y}[x>1]`, is dropped). The AST check blocks such output, so the formatter refuses instead of corrupting your expression.
* JSONata *bindings* (`jsonata.evaluate(input, bindings)`) are not exposed in the UI, so a `$function` supplied by a host application shows an "unknown function" warning here.
* The Exerciser targets the JSONata version bundled in the extension (2.x). Behavior of your production runtime may differ if it uses another version or a different implementation (for example a non-JavaScript port).
* Large inputs (several MB) are re-parsed on every keystroke; raise `debounceMs` if typing lags.

## Development

```bash
npm install
npm run build        # bundles extension, worker and MCP server into dist/
npm test             # builds, then runs unit tests (evaluator, demos, formatter, intellisense helpers)
npm run typecheck
```

Press `F5` in VS Code to launch an Extension Development Host. The `src/core` folder has no dependency on `vscode`, so it is covered by plain Node tests. See [PUBLISHING.md](PUBLISHING.md) for how to release.

## Third-party software

Bundled (all MIT): `jsonata`, `prettier`, `@stedi/prettier-plugin-jsonata`, `@modelcontextprotocol/sdk`, `zod`. JSONata is an independent open-source project; this extension is not affiliated with or endorsed by the JSONata project.

## License

MIT, see [LICENSE](LICENSE).
