import { writeThirdPartyLicenses } from './licenses.mjs';
import { buildMedia } from './build-media.mjs';
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
await build({
  entryPoints: ['src/viewer/media-worker.ts'],
  outfile: 'dist/assets/media-worker.js',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
});
await build({
  entryPoints: ['src/viewer/audio-worklet.ts'],
  outfile: 'dist/assets/audio-worklet.js',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
});

const targets = await buildMedia(process.argv.includes('--release'));
await writeThirdPartyLicenses(targets);
