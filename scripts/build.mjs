import { writeThirdPartyLicenses } from './licenses.mjs';
import { build } from 'esbuild';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
await rm('dist', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc'], {
  stdio: 'inherit',
});
await mkdir('dist/assets', { recursive: true });
await build({
  entryPoints: ['src/host/recorder.ts'],
  outfile: 'dist/assets/recorder.js',
  bundle: true,
  format: 'iife',
  globalName: 'FloeRecorder',
  target: 'chrome120',
  minify: true,
});
await build({
  entryPoints: ['src/viewer/app.ts'],
  outfile: 'dist/assets/app.js',
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  minify: true,
});
await copyFile('src/viewer/index.html', 'dist/assets/index.html');
await copyFile('src/viewer/style.css', 'dist/assets/style.css');

await writeThirdPartyLicenses();
