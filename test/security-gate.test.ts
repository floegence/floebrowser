import assert from 'node:assert/strict';
import test from 'node:test';
import {
  verifySecurity,
  verifyDependencyRun,
} from '../scripts/check-security.mjs';

const commit = 'a'.repeat(40);
const analyses = ['actions', 'go', 'javascript-typescript'].map((language) => ({
  commit_sha: commit,
  tool: { name: 'CodeQL' },
  category: `/language:${language}`,
  error: '',
  warning: '',
}));
const clean = { code: [], dependency: [], secret: [] };

test('security release gate requires exact-commit coverage and zero unresolved findings', () => {
  assert.doesNotThrow(() => verifySecurity(commit, analyses, clean));
  assert.throws(
    () => verifySecurity('b'.repeat(40), analyses, clean),
    /Missing/,
  );
  assert.throws(
    () => verifySecurity(commit, analyses.slice(1), clean),
    /Missing/,
  );
  assert.throws(
    () =>
      verifySecurity(
        commit,
        [{ ...analyses[0], error: 'failed' }, ...analyses.slice(1)],
        clean,
      ),
    /did not complete/,
  );
  assert.throws(
    () =>
      verifySecurity(
        commit,
        [{ ...analyses[0], warning: 'partial' }, ...analyses.slice(1)],
        clean,
      ),
    /incomplete/,
  );
  for (const kind of Object.keys(clean))
    assert.throws(
      () =>
        verifySecurity(commit, analyses, { ...clean, [kind]: [{ number: 1 }] }),
      /Unresolved/,
    );
});

test('security release gate rejects absent, stale, failed or unfinished dependency runs', () => {
  const run = {
    head_sha: commit,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
  };
  assert.doesNotThrow(() => verifyDependencyRun(commit, [run]));
  assert.throws(() => verifyDependencyRun(commit, []), /Missing/);
  for (const change of [
    { head_sha: 'b'.repeat(40) },
    { head_branch: 'feature' },
    { event: 'pull_request' },
  ])
    assert.throws(
      () => verifyDependencyRun(commit, [{ ...run, ...change }]),
      /Missing/,
    );
  assert.throws(
    () => verifyDependencyRun(commit, [{ ...run, status: 'in_progress' }]),
    /incomplete/,
  );
  assert.throws(
    () => verifyDependencyRun(commit, [{ ...run, conclusion: 'failure' }]),
    /did not pass/,
  );
  assert.throws(
    () => verifyDependencyRun(commit, [{ ...run, conclusion: 'skipped' }]),
    /did not pass/,
  );
});
