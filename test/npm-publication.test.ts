import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyPublication } from '../scripts/publish-npm.mjs';

const pkg = {
  name: '@floegence/floebrowser',
  version: '0.1.9',
  repository: { url: 'git+https://github.com/floegence/floebrowser.git' },
};
const environment = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'floegence/floebrowser',
  GITHUB_REF: 'refs/tags/v0.1.9',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-only',
};

test('npm publication accepts only the matching release artifact and GitHub OIDC identity', () => {
  assert.doesNotThrow(() => verifyPublication(pkg, pkg, environment));
  for (const changed of [
    { GITHUB_ACTIONS: 'false' },
    { GITHUB_REPOSITORY: 'other/floebrowser' },
    { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_REF: 'refs/tags/v0.1.8' },
    { ACTIONS_ID_TOKEN_REQUEST_URL: '' },
    { ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' },
    { NODE_AUTH_TOKEN: 'test-only' },
    { NPM_TOKEN: 'test-only' },
  ])
    assert.throws(() =>
      verifyPublication(pkg, pkg, { ...environment, ...changed }),
    );
  for (const changed of [
    { version: '0.1.8' },
    { name: '@other/floebrowser' },
    { repository: { url: 'git+https://github.com/other/floebrowser.git' } },
  ])
    assert.throws(() =>
      verifyPublication(pkg, { ...pkg, ...changed }, environment),
    );
});
