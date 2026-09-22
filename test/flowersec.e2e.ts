import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';

// This is a transport contract check with synthetic encoded payloads. Real codec
// decoding lives in viewer-engines.e2e.ts; neither check qualifies WAN latency.
test(
  'published Flowersec streams keep control responsive during media stalls, resources and writer cancellation',
  { timeout: 60000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'floebrowser-flowersec-'));
    let fixtureProcess: ChildProcess | undefined;
    let exited: Promise<unknown> | undefined;
    let browser: Browser | undefined;
    t.after(async () => {
      try {
        await browser?.close();
      } finally {
        fixtureProcess?.kill();
        await exited;
        await rm(directory, { recursive: true, force: true });
      }
    });
    const executable = join(
      directory,
      process.platform === 'win32' ? 'fixture.exe' : 'fixture',
    );
    await promisify(execFile)('go', ['build', '-o', executable, '.'], {
      cwd: 'test/flowersec',
      env: { ...process.env, GOWORK: 'off' },
      timeout: 30000,
    });
    const fixture = spawn(executable, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    fixtureProcess = fixture;
    exited = once(fixture, 'exit');
    let errors = '';
    fixture.stderr.on('data', (chunk) => (errors += chunk));
    const url = await new Promise<string>((resolve, reject) => {
      let line = '';
      fixture.stdout.on('data', (chunk) => {
        line += chunk;
        if (line.includes('\n')) resolve(JSON.parse(line.trim()).url);
      });
      fixture.once('error', reject);
      fixture.once('exit', () =>
        reject(new Error(errors || 'Fixture exited before startup')),
      );
    });
    const bundle = await build({
      entryPoints: ['test/flowersec/client.ts'],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      write: false,
    });
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(url);
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    const result = await page.evaluate(() => (window as any).qualify());
    t.diagnostic(JSON.stringify(result));
    await mkdir('.test-artifacts', { recursive: true });
    const commit = await promisify(execFile)('git', ['rev-parse', 'HEAD']);
    const status = await promisify(execFile)('git', ['status', '--porcelain']);
    await writeFile(
      '.test-artifacts/flowersec-mixed-lanes.json',
      JSON.stringify(
        {
          at: new Date().toISOString(),
          commit: commit.stdout.trim(),
          dirty: !!status.stdout.trim(),
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          browser: browser.version(),
          sdk: { typescript: '5.4.1', go: 'v5.4.1' },
          profile: 'flowersec-private-loopback/1',
          network: 'local loopback, no simulated WAN',
          result,
        },
        null,
        2,
      ) + '\n',
    );
    assert.equal(
      result.stalledStable,
      true,
      'A stalled media consumer stops writes at the application credit limit',
    );
    assert.ok(result.stalledBytes > 0 && result.stalledBytes < 256 * 1024);
    assert.ok(result.maxChunk <= 16 * 1024);
    assert.equal(result.resourceBytes, 8 * 1024 * 1024);
    assert.equal(result.resumed, true);
    assert.equal(result.blocked, true);
    assert.equal(result.canceled, true);
    assert.ok(result.cancelMs < 1000);
    assert.ok(result.loadedP95 - result.baselineP95 < 100);
    assert.equal(errors, '');
  },
);
