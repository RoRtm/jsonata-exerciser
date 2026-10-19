# Publishing guide

How to get this extension into the Visual Studio Marketplace (what VS Code's Extensions view uses), Open VSX (VSCodium, Cursor, Windsurf, Gitpod) or distribute it privately as a `.vsix`.

> Check with your legal/compliance contact before publishing under a company name: publisher identity, license (MIT by default), trademark use of "JSONata"/"Exerciser", and whether open-sourcing is permitted. Have a qualified person review the package contents before anything is released externally.

## 0. One-time preparation

1. **Pick the final name and publisher id.** In `package.json` change:
   * `publisher` (currently the placeholder `your-publisher-id`), lowercase letters/digits/dashes
   * `name` / `displayName` if you want something other than "JSONata Exerciser"
   * `repository`, `bugs`, `homepage` URLs
   * `LICENSE` copyright holder
2. Make sure `README.md` and `CHANGELOG.md` read well: they become the Marketplace page. Relative image links need `repository` to be set; add screenshots/GIFs to `images/` and reference them in the README for a much better listing.
3. Push the repo to GitHub (or your Git host):

   ```bash
   git remote add origin https://github.com/<org>/jsonata-exerciser.git
   git push -u origin main
   ```

## 1. Create a Marketplace publisher and token

1. Sign in at <https://dev.azure.com> with a Microsoft account and create an organization if you have none.
2. In Azure DevOps: *User settings > Personal access tokens > New Token*. Set **Organization: All accessible organizations**, **Scopes: Custom defined > Marketplace > Manage**. Copy the token (it is shown once). Store it in your password manager.
3. Go to <https://marketplace.visualstudio.com/manage> and **Create publisher**. The *id* must equal `publisher` in `package.json`.

## 2. Build, test and package locally

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

## 3. Publish to the Visual Studio Marketplace

```bash
npx vsce login <publisher-id>            # paste the PAT
npx vsce publish                          # publishes the version in package.json
# or bump and publish in one step:
npx vsce publish patch                    # 0.1.0 -> 0.1.1 (also: minor, major)
```

The listing appears after an automated verification (usually minutes). Update by increasing `version`, adding a `CHANGELOG.md` entry and publishing again. Use `npx vsce publish --pre-release` for a pre-release channel (needs an odd/even minor-version convention, see the VS Code docs on pre-release extensions).

Unpublish or deprecate from <https://marketplace.visualstudio.com/manage>.

## 4. Optional: Open VSX (non-Microsoft editors)

```bash
npx ovsx create-namespace <publisher-id> -p <OVSX_TOKEN>   # once
npx ovsx publish jsonata-exerciser-0.1.0.vsix -p <OVSX_TOKEN>
```

Create the token at <https://open-vsx.org> (sign in with GitHub, accept the publisher agreement).

## 5. Optional: Private distribution inside your company

Send the `.vsix` file (or attach it to a GitHub Release). Users install it via *Extensions view > ... menu > Install from VSIX...* or `code --install-extension <file>`. No Marketplace account is needed. For managed rollouts, put the file on an internal share and use your endpoint-management tooling.

## 6. Automated releases with GitHub Actions

`.github/workflows/publish.yml` publishes on every tag that starts with `v`.

1. Add repository secrets `VSCE_PAT` (Marketplace token) and optionally `OVSX_PAT`.
2. Release:

   ```bash
   npm version patch            # bumps package.json and creates the tag
   git push --follow-tags
   ```

`.github/workflows/ci.yml` type-checks, tests and builds a `.vsix` artifact on every push and pull request.

## Checklist before every release

- [ ] `publisher`, `repository` and `LICENSE` are final
- [ ] `npm test` passes, `npx vsce package --no-dependencies` succeeds without warnings you do not understand
- [ ] Manual smoke test above done in a real VS Code window (the automated tests do not start VS Code)
- [ ] `CHANGELOG.md` updated, version bumped
- [ ] Token (PAT) not committed anywhere; rotate it if it ever leaked (tokens expire after at most one year)
- [ ] Third-party licenses in the README are still accurate (`npm ls` and check each license after dependency updates)
- [ ] Security review of new dependencies (`npm audit`)

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `vsce` says *Missing publisher name* | Set `publisher` in `package.json` |
| `401`/`403` on publish | PAT must have scope *Marketplace > Manage* and org *All accessible organizations*; publisher id must match |
| Extension installs but nothing happens | Check *Output > Log (Extension Host)*; make sure `dist/` was built (`vscode:prepublish` does this automatically on `vsce package`) |
| Chat participant / tools missing | Needs VS Code 1.101+ and GitHub Copilot Chat; see `engines.vscode` |
| Claude Code cannot start the MCP server | Run `node "<path>/mcp-server.js"` manually; it must stay silent and wait for input. Node 20+ required |
