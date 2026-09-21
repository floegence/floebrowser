import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mediaExecutable } from '../dist/host/media-executable.js';

test(
  'the packaged helper separates media and control using only portable standard handles',
  { timeout: 5000 },
  async (t) => {
    const child = spawn(mediaExecutable(), [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    const media: Buffer[] = [];
    const control: Buffer[] = [];
    child.stdout.on('data', (data) => media.push(data));
    child.stderr.on('data', (data) => control.push(data));
    const exited = new Promise<number | null>((resolve, reject) => {
      child.on('close', resolve);
      child.on('error', reject);
    });
    child.stdin.end(
      JSON.stringify({
        id: 'request-1',
        collector: 'retired-collector',
        op: 'keyframe',
      }) + '\n',
    );
    assert.equal(await exited, 0);
    assert.equal(
      Buffer.concat(media).length,
      0,
      'A control reply must never enter the encoded media pipe',
    );
    assert.deepEqual(JSON.parse(Buffer.concat(control).toString('utf8')), {
      id: 'request-1',
    });
  },
);
