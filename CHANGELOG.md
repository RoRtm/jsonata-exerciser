# Changelog

## 1.5.2

- README rewritten: hero section with badges, feature overview, screenshots for every major feature, and a complete list of capabilities.

## 1.5.1

- Profiler button (gauge icon) in the title bar of `.jsonata` editors, next to Run Expression.

## 1.5.0

- **Performance profiler:** *JSONata: Profile Expression (find slow parts)* measures which parts of an expression take the most time. Heat map and inline hints in the editor, hover details, a clickable ranked report, suggestions for common problems (quadratic filters in loops, `$append` in `$reduce`, `**`, sorting/`$eval` in loops), and an option to simulate larger data (arrays ×10 / ×100 / ×1000).
- New AI tool `#jsonataProfile` (MCP: `jsonata_profile`).
- Fix: inspection no longer offers parts that cannot stand alone (the right side of `~>`, call targets, argument lists, group-by tails).

## 1.4.0

- **Step-through inspection:** see what any part of an expression evaluates to in its real context. Live inline hint and hover for the part under the cursor or the selection, per-item values, a step-by-step breakdown for paths, and "not reached" detection. Commands: Inspect Value at Cursor / Selection (`Ctrl+Alt+J`), Inspect Larger Expression (`Ctrl+Alt+Shift+J`), Toggle Live Value Inspection.
- New AI tool `#jsonataInspect` (MCP: `jsonata_inspect`) so Copilot and Claude can debug expressions part by part; the recommended workflow mentions it.

## 1.3.1

- Formatter: new setting `jsonataExerciser.format.objectLayout` (`preserve` default, `expanded`, `auto`). Objects you wrote on several lines are no longer collapsed onto one line.

## 1.3.0

- Five new, more complex demos (8-12): sales report (helper functions, grouping, ranking, tiers), joining two datasets (lookup, orphans, group by), recursive tree walk with `**`, event-log statistics (per-day stats, busiest hour, running total with `$reduce`, weekday formatting) and data cleansing (normalize, validate, de-duplicate). The error demo is now number 13.

## 1.2.6

- Fix: restarting VS Code with the Exerciser panes open showed "The editor could not be opened due to an unexpected error". The scratch input/expression and the result pane are now real (virtual) file systems that wake the extension up on restore, scratch files reopen with their last content, and the Exerciser resumes live evaluation automatically. The result pane is now `result.jsonc`.

## 1.2.5

- Faster, more visible start: the extension now activates as soon as a JSON / JSONC / JSONata editor is restored (not only after VS Code finished starting), a **JSONata** status bar entry shows when it is ready, opening the Exerciser shows a progress spinner, and the evaluator thread is started in the background.

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
