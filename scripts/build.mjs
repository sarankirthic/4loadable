// Bundles the extension with esbuild (the bundler Vite itself uses), without any Vite config to maintain.
//   node scripts/build.mjs [--watch] [--production] [--firefox]
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const prod = args.has('--production');
const watch = args.has('--watch');
const firefox = args.has('--firefox');
const out = resolve(root, firefox ? 'dist-firefox' : 'dist');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

function copyStatic() {
  cpSync(resolve(root, 'public'), out, { recursive: true });
  const m = JSON.parse(readFileSync(resolve(root, 'public/manifest.json'), 'utf8'));
  if (firefox) {
    // Firefox MV3 uses event pages (background.scripts), not service workers. UNTESTED in Firefox.
    m.background = { scripts: ['background.js'] };
    m.browser_specific_settings = { gecko: { id: 'chan-media-downloader@example.invalid', strict_min_version: '115.0' } };
    delete m.minimum_chrome_version;
  }
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(m, null, 2));
}

const common = {
  bundle: true, format: 'iife', target: ['chrome116', 'firefox115'], jsx: 'automatic', logLevel: 'info',
  minify: prod, sourcemap: prod ? false : 'inline', legalComments: 'none',
  define: { 'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development') },
  absWorkingDir: root,
};
const entryPoints = {
  background: 'src/background/service-worker.ts',
  content: 'src/content/index.ts',
  popup: 'src/popup/main.tsx',
  manager: 'src/media-manager/main.tsx',
  options: 'src/options/main.tsx',
};

copyStatic();
const ctx = await esbuild.context({ ...common, entryPoints, outdir: out });
if (watch) { await ctx.watch(); console.log(`Watching… output in ${out}. Reload the extension in chrome://extensions after changes.`); }
else { await ctx.rebuild(); await ctx.dispose(); console.log(`Built ${firefox ? 'Firefox' : 'Chrome'} extension -> ${out}`); }
