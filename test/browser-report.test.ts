import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyBrowserReport } from '../scripts/check-browser-report.mjs';

const report =
  '# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
test('qualification requires a complete passing report', () => {
  assert.equal(verifyBrowserReport(report), 2);
  for (const body of [
    '',
    report.replaceAll('2', '0'),
    report + report,
    report.replace('# todo 0\n', ''),
  ])
    assert.throws(() => verifyBrowserReport(body));
});
test('qualification rejects failures, cancellation and incomplete cases', () => {
  for (const field of ['fail', 'cancelled', 'skipped', 'todo'])
    assert.throws(() =>
      verifyBrowserReport(report.replace(`# ${field} 0`, `# ${field} 1`)),
    );
  assert.throws(() =>
    verifyBrowserReport(report.replace('# pass 2', '# pass 1')),
  );
});
