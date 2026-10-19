# Instructions for AI assistants working on this repository

- This is a VS Code extension written in TypeScript, bundled with esbuild (`npm run build`). Tests: `npm test`.
- `src/core/*` must stay free of `vscode` imports so it can be unit tested and reused by the MCP server.
- JSONata parsing and evaluation must always use the official `jsonata` package. Never write a custom parser.
- Never add network calls to the extension runtime (the extension must work fully offline). Opening documentation links in the browser is fine.
- The formatter output must always be verified with `sameAst` (see `src/core/format.ts`).
