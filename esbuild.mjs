// Bundles everything (including the official `jsonata` library) into ./dist so the
// packaged extension has zero runtime dependencies and runs fully offline.
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  legalComments: 'linked'
};

const builds = [
  // VS Code extension host entry
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  // Worker thread that evaluates JSONata (so runaway expressions can be killed)
  { ...common, entryPoints: ['src/core/worker.ts'], outfile: 'dist/worker.js' },
  // Standalone MCP server (Claude Code / Claude Desktop / any MCP client)
  { ...common, entryPoints: ['src/mcp/server.ts'], outfile: 'dist/mcp-server.js' },
  // Command line test runner for CI (node dist/test-cli.js <folder>)
  { ...common, entryPoints: ['src/test-cli.ts'], outfile: 'dist/test-cli.js' }
];

if (watch) {
  for (const b of builds) {
    const ctx = await esbuild.context(b);
    await ctx.watch();
  }
  console.log('watching...');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
