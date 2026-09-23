import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export function verifyPublication(source, packed, environment) {
  assert.equal(
    environment.GITHUB_ACTIONS,
    'true',
    'Publish only in GitHub Actions',
  );
  assert.equal(environment.GITHUB_REPOSITORY, 'floegence/floebrowser');
  assert.match(source.version, /^\d+\.\d+\.\d+$/u);
  assert.equal(environment.RELEASE_TAG, `v${source.version}`);
  if (environment.GITHUB_EVENT_NAME === 'release') {
    assert.equal(environment.GITHUB_REF, `refs/tags/v${source.version}`);
  } else {
    assert.equal(environment.GITHUB_EVENT_NAME, 'workflow_dispatch');
    assert.equal(environment.GITHUB_REF, 'refs/heads/main');
  }
  assert.ok(environment.ACTIONS_ID_TOKEN_REQUEST_URL, 'OIDC must be available');
  assert.ok(
    environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    'OIDC must be available',
  );
  assert.ok(
    !environment.NODE_AUTH_TOKEN && !environment.NPM_TOKEN,
    'Publish without persistent tokens',
  );
  for (const pkg of [source, packed]) {
    assert.equal(pkg.name, '@floegence/floebrowser');
    assert.equal(pkg.version, source.version);
    assert.equal(
      pkg.repository?.url,
      'git+https://github.com/floegence/floebrowser.git',
    );
  }
}

export async function publish() {
  const source = JSON.parse(
    await readFile('qualified-source/package.json', 'utf8'),
  );
  assert.match(source.version, /^\d+\.\d+\.\d+$/u);
  const archive = resolve(
    `release/floegence-floebrowser-${source.version}.tgz`,
  );
  const packed = JSON.parse(
    execFileSync('tar', ['-xOf', archive, 'package/package.json'], {
      encoding: 'utf8',
    }),
  );
  verifyPublication(source, packed, process.env);
  const bytes = await readFile(archive);
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const endpoint = `https://registry.npmjs.org/@floegence%2ffloebrowser/${source.version}`;
  const existing = await fetch(endpoint);
  if (existing.status === 404) {
    execFileSync(
      'npm',
      [
        'publish',
        archive,
        '--access=public',
        '--provenance',
        '--ignore-scripts',
        '--registry=https://registry.npmjs.org',
      ],
      { stdio: 'inherit' },
    );
  } else {
    assert.ok(existing.ok, `Registry lookup failed: ${existing.status}`);
    assert.equal(
      (await existing.json()).dist?.integrity,
      integrity,
      'An existing version must match the qualified archive',
    );
  }
  const response = await fetch(endpoint);
  assert.ok(response.ok, `Registry readback failed: ${response.status}`);
  const metadata = await response.json();
  assert.equal(metadata.dist?.integrity, integrity);
  const url = new URL(metadata.dist.tarball);
  assert.equal(url.origin, 'https://registry.npmjs.org');
  const download = await fetch(url);
  assert.ok(download.ok, `Tarball readback failed: ${download.status}`);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.ok(
    metadata.dist.attestations?.url,
    'Trusted publication must include provenance',
  );
  await writeFile(
    'release/npm-readback.json',
    JSON.stringify(
      {
        version: source.version,
        integrity,
        tarball: url.href,
        attestations: metadata.dist.attestations,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `Verified @floegence/floebrowser@${source.version}: registry bytes and provenance match the qualified release`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await publish();
