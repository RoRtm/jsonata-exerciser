# Publishing guide

How to get this extension into the Visual Studio Marketplace (what VS Code's Extensions view uses), Open VSX (VSCodium, Cursor, Windsurf, Gitpod) or distribute it privately as a `.vsix`.

> Check with your legal/compliance contact before publishing under a company name: publisher identity, license (MIT by default), trademark use of "JSONata"/"Exerciser", and whether open-sourcing is permitted. Have a qualified person review the package contents before anything is released externally.

## 1. Build, test and package locally

```bash
npm ci
npm run typecheck
npm test
npx vsce package --no-dependencies      # produces jsonata-exerciser-0.1.0.vsix
```

`--no-dependencies` is correct here because everything is bundled by esbuild into `dist/`.

Install and try the `.vsix` before publishing:

```bash
code --install-extension jsonata-exerciser-0.1.0.vsix
```

Run through this smoke test in a real VS Code window:

1. *JSONata: Open Exerciser with Demo...* and open each demo; the result updates while typing.
2. Introduce a syntax error: red squiggle plus a message in the Problems panel. Demo 8 shows a runtime error.
3. Type `$su` and check completions; type `$substring(` and check signature help.
4. Format the expression (`Shift+Alt+F`).
5. *JSONata: Open Online Help...* opens the browser.
6. In Copilot Chat (agent mode) ask: "Use #jsonataExerciserState and explain my expression", and try `@jsonata /explain`.
7. Run *JSONata: Copy MCP Server Config*, add it to Claude Code, and ask it to evaluate an expression.

## 2. Publish to the Visual Studio Marketplace

```bash
npx vsce login <publisher-id>            # paste the PAT
npx vsce publish                          # publishes the version in package.json
# or bump and publish in one step:
npx vsce publish patch                    # 1.0.0 -> 1.0.1 (also: minor, major)
```

The listing appears after an automated verification (usually minutes). Update by increasing `version`, adding a `CHANGELOG.md` entry and publishing again. Use `npx vsce publish --pre-release` for a pre-release channel (needs an odd/even minor-version convention, see the VS Code docs on pre-release extensions).

Unpublish or deprecate from <https://marketplace.visualstudio.com/manage>.

## 3. Optional: Open VSX (non-Microsoft editors)

```bash
npx ovsx create-namespace <publisher-id> -p <OVSX_TOKEN>   # once
npx ovsx publish jsonata-exerciser-1.0.0.vsix -p <OVSX_TOKEN>
```

Create the token at <https://open-vsx.org> (sign in with GitHub, accept the publisher agreement).

## 4. Optional: Private distribution inside your company

Send the `.vsix` file (or attach it to a GitHub Release). Users install it via *Extensions view > ... menu > Install from VSIX...* or `code --install-extension <file>`. No Marketplace account is needed. For managed rollouts, put the file on an internal share and use your endpoint-management tooling.

## 5. Automated releases with GitHub Actions

`.github/workflows/publish.yml` publishes on every tag that starts with `v`.

1. Add repository secrets `VSCE_PAT` (Marketplace token) and optionally `OVSX_PAT`.
2. Release:

   ```bash
   npm version patch            # bumps package.json and creates the tag
   git push --follow-tags
   ```

`.github/workflows/ci.yml` type-checks, tests and builds a `.vsix` artifact on every push and pull request.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `vsce` says *Missing publisher name* | Set `publisher` in `package.json` |
| `401`/`403` on publish | PAT must have scope *Marketplace > Manage* and org *All accessible organizations*; publisher id must match |
| Extension installs but nothing happens | Check *Output > Log (Extension Host)*; make sure `dist/` was built (`vscode:prepublish` does this automatically on `vsce package`) |
| Chat participant / tools missing | Needs VS Code 1.101+ and GitHub Copilot Chat; see `engines.vscode` |
| Claude Code cannot start the MCP server | Run `node "<path>/mcp-server.js"` manually; it must stay silent and wait for input. Node 20+ required |
