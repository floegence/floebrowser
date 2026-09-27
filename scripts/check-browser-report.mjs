import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function verifyBrowserReport(body) {
  const count = (name) => {
    const matches = [...body.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))];
    assert.equal(matches.length, 1, `Missing or ambiguous test count: ${name}`);
    return Number(matches[0][1]);
  };
  const passed = count('pass');
  assert(
    passed > 0 && count('tests') === passed,
    'Qualification must execute passing tests',
  );
  for (const name of ['fail', 'cancelled', 'skipped', 'todo'])
    assert.equal(count(name), 0, `Qualification contains ${name} tests`);
  return passed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(
    `Verified ${verifyBrowserReport(await readFile(process.argv[2], 'utf8'))} browser tests, zero skipped`,
  );
