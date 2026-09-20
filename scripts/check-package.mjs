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
import { createProjectionServer, PROTOCOL_VERSION } from '@floegence/floebrowser';
import { clientMessageSchema } from '@floegence/floebrowser/protocol';
assert.equal(PROTOCOL_VERSION, 2);
assert.equal(clientMessageSchema.safeParse({ type: 'resync' }).success, true);
const browser = await chromium.launch({ chromiumSandbox: true });
let server;
try {
  const source = await browser.newPage();
  server = await createProjectionServer(source, { authorize: () => true });
  await source.goto('data:text/html,<h1 id="packed">Packed source</h1>');
  const viewer = await browser.newPage();
  await viewer.goto(server.url);
  await viewer.locator('#status.live').waitFor();
  assert.equal(await viewer.frameLocator('#viewport iframe').locator('#packed').textContent(), 'Packed source');
  const css = await fetch(new URL('app.css', server.url));
  assert.equal(css.status, 200);
  assert.match(await css.text(), /floe-viewport/);
} finally { await server?.close(); await browser.close(); }
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
