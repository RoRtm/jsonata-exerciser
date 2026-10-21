# Changelog

## 1.2.4

- The scratch `expression.jsonata` / `input.json` panes live in memory only, so Ctrl+S appeared to do nothing. Ctrl+S / Save As on a scratch pane now opens a Save dialog, writes a real file and links the Exerciser to it (command **JSONata: Save Scratch Expression/Input to File...**).

## 1.2.3

- The JSON editor title-bar button uses a white variant of the button image (`images/jsonata-button-32-dark.png`) on dark themes.

## 1.2.2

- JSON and result editors: title-bar button **Open JSONata Exerciser** uses the JSONata button image (`images/jsonata-button-32.png`).
- `.jsonata` editors: separate **Run JSONata Expression** button with the play triangle.
- Removed the unused brace/play SVG icons.

## 1.2.1

- README restructured: screenshot and a "What it can do" overview at the top, commands and shortcuts table.

## 1.2.0

- Better hints for GitHub Copilot and Claude: new tools `#jsonataInputStructure` (compact outline of the JSON: keys, nesting, arrays, optional keys, example paths) and `#jsonataGuide` (cheat sheet, function list, workflow); `#jsonataExerciserState` now includes the input structure and workflow directives; `#jsonataEvaluate` accepts `inputFile` / `expressionFile` paths so large files never need to be pasted.
- `@jsonata` reads data and expression from the prompt itself: `#file:data.json`, `#file:expr.jsonata`, ```json and ```jsonata blocks override what is in the Exerciser; the model always gets the input structure and a JSONata cheat sheet.
- New command **Add Copilot / Claude Instructions to Workspace...** writes `.github/instructions/jsonata.instructions.md`, `.github/prompts/jsonata.prompt.md` (`/jsonata` in chat) and CLAUDE.md / AGENTS.md sections.
- MCP server: new `jsonata_describe_input` and `jsonata_guide`; `jsonata_evaluate` accepts `expression_file`.
- Title-bar button now uses a 32 px version of `images/jsonata256.png`.

## 1.1.3

- The title-bar button is now called **Open JSONata Exerciser** and uses a dedicated icon (light and dark variants).

## 1.1.2

- New **Run JSONata Expression** button (play icon) in the title bar of JSON, `.jsonata` and result editors. It links the file and restores any pane you closed, so the input, expression and result are always three clicks away from any of them.
- Opening the Exerciser again now always re-shows all three panes (previously a closed expression pane stayed closed).

## 1.1.1

- While the Exerciser is open, JSON files opened from the Explorer (or anywhere) are moved into the left pane as the input, and `.jsonata` files into the top-right pane, instead of opening in the focused group.

## 1.1.0

- Input and expression are now linked independently and can be any real file. A JSON file shown in the left group becomes the input, a `.jsonata` file shown in the second group becomes the expression (setting `jsonataExerciser.followEditors`).
- "Evaluate Now" / "Open Exerciser" on a JSON or `.jsonata` file uses that file instead of opening a scratch `input.json`; the window layout is no longer reset when it already exists.
- New "Open in JSONata Exerciser" entry in the Explorer, editor and editor-tab context menus for `.json`, `.jsonc` and `.jsonata` files.
- `.jsonata` files remember their input JSON ("Bind Input JSON to Expression File..." and automatic memory), optionally as an `/* input: ./file.json */` header comment that travels with the file.
- New command "Switch Back to Scratch Input/Expression".

## 1.0.1

- Add a screenshot preview to the README.

## 1.0.0

- Initial release: three-pane Exerciser with live evaluation, JSONata language support (syntax, validation, IntelliSense, signature help, hover), AST-verified formatter, demos, online help, Copilot language-model tools, `@jsonata` chat participant and a standalone MCP server for Claude.
