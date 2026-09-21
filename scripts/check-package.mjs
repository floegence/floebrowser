import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this check with npm run check:package.');
const directory = await mkdtemp(join(tmpdir(), 'floebrowser-package-'));
try {
  const packed = JSON.parse(
    execFileSync(
      process.execPath,
      [
        npm,
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        directory,
      ],
      { encoding: 'utf8' },
    ),
  );
  execFileSync(
    process.execPath,
    [
      npm,
      'install',
      '--prefix',
      directory,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(directory, packed[0].filename),
    ],
    { stdio: 'pipe' },
  );
  const help = execFileSync(
    process.execPath,
    [
      join(directory, 'node_modules/@floegence/floebrowser/dist/host/cli.js'),
      '--help',
    ],
    { encoding: 'utf8' },
  );
  assert.match(help, /DOM-based remote browser/);
  await writeFile(
    join(directory, 'smoke.mjs'),
    `
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import { createProjectionServer, launchSourceBrowser, PROTOCOL_VERSION } from '@floegence/floebrowser';
import { clientMessageSchema } from '@floegence/floebrowser/protocol';
const packageRoot = new URL('./node_modules/@floegence/floebrowser/', import.meta.url);
const bundle = JSON.parse(await readFile(new URL('dist/bin/manifest.json', packageRoot), 'utf8'));
const pkg = JSON.parse(await readFile(new URL('package.json', packageRoot), 'utf8'));
assert.equal(bundle.version, pkg.version);
assert.equal(bundle.mediaWireVersion, 1);
assert.equal(bundle.artifacts.length, 6, 'Formal package qualification requires build:release');
for (const artifact of bundle.artifacts) {
  const bytes=await readFile(new URL('dist/bin/'+artifact.path, packageRoot));
  assert.equal(bytes.length, artifact.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
}
assert.equal(PROTOCOL_VERSION, 14);
assert.equal(clientMessageSchema.safeParse({ type: 'resync' }).success, true);
const browser = await chromium.launch({ chromiumSandbox: true });
let server, context;
try {
  context = await launchSourceBrowser();
  const source = await context.newPage();
  assert.doesNotMatch(await source.evaluate(() => navigator.userAgent), /HeadlessChrome/);
  server = await createProjectionServer(source, { authorize: () => true });
  await source.goto('data:text/html,<h1 id="packed">Packed source</h1>');
  const viewer = await browser.newPage();
  await viewer.goto(server.url);
  await viewer.locator('#status.live').waitFor();
  assert.equal(await viewer.frameLocator('#viewport iframe').locator('#packed').textContent(), 'Packed source');
  const css = await fetch(new URL('app.css', server.url));
  assert.equal(css.status, 200);
  assert.match(await css.text(), /floe-viewport/);
  await server.close(); server=undefined;
  const native=bundle.artifacts.find(a=>a.platform===process.platform && a.arch===process.arch);
  const nativeURL=new URL('dist/bin/'+native.path, packageRoot);
  const original=await readFile(nativeURL);
  try {
    const changed=Buffer.from(original);changed[0]^=255;
    await writeFile(nativeURL,changed);
    await assert.rejects(()=>createProjectionServer(source,{authorize:()=>true}),/integrity verification/);
  } finally { await writeFile(nativeURL,original); }
} finally { await server?.close(); await context?.close(); await browser.close(); }
`,
  );
  execFileSync(process.execPath, [join(directory, 'smoke.mjs')], {
    cwd: directory,
    stdio: 'inherit',
    timeout: 45000,
  });
  console.log(
    'Packed package: public exports, CLI, source recorder, viewer and styles passed outside the checkout.',
  );
  console.log(
    `Package size: ${Math.round(packed[0].size / 1024)} KiB compressed.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
