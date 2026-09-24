import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readPublishedMetadata,
  verifyPublication,
} from '../scripts/publish-npm.mjs';

const pkg = {
  name: '@floegence/floebrowser',
  version: '0.1.9',
  repository: { url: 'git+https://github.com/floegence/floebrowser.git' },
};
const environment = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'floegence/floebrowser',
  GITHUB_REF: 'refs/tags/v0.1.9',
  GITHUB_EVENT_NAME: 'release',
  RELEASE_TAG: 'v0.1.9',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-only',
};

test('registry readback waits for acknowledged npm publication to become visible', async () => {
  let calls = 0;
  const waits: number[] = [];
  const metadata = await readPublishedMetadata(
    'https://registry.npmjs.org/example/1.0.0',
    async () =>
      ++calls < 3
        ? new Response(null, { status: 404 })
        : Response.json({ version: '1.0.0' }),
    async (ms: number) => {
      waits.push(ms);
    },
  );
  assert.deepEqual(metadata, { version: '1.0.0' });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [5000, 5000]);
});

test('registry readback fails immediately on other errors and bounds processing time', async () => {
  await assert.rejects(
    readPublishedMetadata(
      'https://registry.npmjs.org/example/1.0.0',
      async () => new Response(null, { status: 403 }),
      async () => {
        assert.fail('Do not wait on authorization errors');
      },
    ),
    /Registry readback failed: 403/,
  );
  let calls = 0;
  await assert.rejects(
    readPublishedMetadata(
      'https://registry.npmjs.org/example/1.0.0',
      async () => {
        calls++;
        return new Response(null, { status: 404 });
      },
      async () => {},
    ),
    /remained unavailable for 10 minutes/,
  );
  assert.equal(calls, 121);
});

test('registry readback rejects external endpoints and refuses redirects', async () => {
  for (const endpoint of [
    'https://example.com/version',
    'https://registry.npmjs.org@evil.test/version',
    'http://registry.npmjs.org/version',
  ])
    await assert.rejects(
      readPublishedMetadata(endpoint, async () => {
        assert.fail('Untrusted endpoints cannot be requested');
      }),
    );
  await readPublishedMetadata(
    'https://registry.npmjs.org/example/1.0.0',
    async (_url: URL, options: RequestInit) => {
      assert.equal(options.redirect, 'error');
      return Response.json({ version: '1.0.0' });
    },
  );
});

test('npm publication accepts only the matching release artifact and GitHub OIDC identity', () => {
  assert.doesNotThrow(() => verifyPublication(pkg, pkg, environment));
  for (const changed of [
    { GITHUB_ACTIONS: 'false' },
    { GITHUB_REPOSITORY: 'other/floebrowser' },
    { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_REF: 'refs/tags/v0.1.8' },
    { RELEASE_TAG: 'v0.1.8' },
    { GITHUB_EVENT_NAME: 'push' },
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

test('manual recovery uses the qualified release tag from the main publication workflow', () => {
  const manual = {
    ...environment,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
  };
  assert.doesNotThrow(() => verifyPublication(pkg, pkg, manual));
  assert.throws(() =>
    verifyPublication(pkg, pkg, {
      ...manual,
      GITHUB_REF: 'refs/heads/feature',
    }),
  );
  assert.throws(() =>
    verifyPublication(pkg, pkg, { ...manual, RELEASE_TAG: 'v0.1.8' }),
  );
});
