import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export const mediaTargets = [
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['linux', 'arm64'],
  ['linux', 'x64'],
  ['win32', 'arm64'],
  ['win32', 'x64'],
];
export async function buildMedia(release) {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))
    throw new Error('Invalid package version');
  const targets = release ? mediaTargets : [[process.platform, process.arch]];
  const artifacts = [];
  for (const [platform, arch] of targets) {
    if (!mediaTargets.some(([os, cpu]) => os === platform && cpu === arch))
      throw new Error(`Unsupported media build target: ${platform}-${arch}`);
    const directory = `dist/bin/${platform}-${arch}`;
    await mkdir(directory, { recursive: true });
    const filename = `floebrowser-media${platform === 'win32' ? '.exe' : ''}`;
    execFileSync(
      'go',
      [
        'build',
        '-trimpath',
        `-ldflags=-s -w -X main.version=${version}`,
        '-o',
        `../${directory}/${filename}`,
        './cmd/floebrowser-media',
      ],
      {
        cwd: 'media',
        env: {
          ...process.env,
          GOWORK: 'off',
          CGO_ENABLED: '0',
          GOOS: platform === 'win32' ? 'windows' : platform,
          GOARCH: arch === 'x64' ? 'amd64' : arch,
        },
        stdio: 'inherit',
      },
    );
    const body = await readFile(`${directory}/${filename}`);
    artifacts.push({
      platform,
      arch,
      path: `${platform}-${arch}/${filename}`,
      bytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
  }
  await writeFile(
    'dist/bin/manifest.json',
    JSON.stringify({ version, mediaWireVersion: 1, artifacts }, null, 2) + '\n',
  );
  return targets;
}
