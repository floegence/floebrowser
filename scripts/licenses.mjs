import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { readFile, readdir, writeFile } from 'node:fs/promises';

// Include original license/notice text alongside the compiled third-party code.
export async function writeThirdPartyLicenses() {
  const root = JSON.parse(await readFile('package.json', 'utf8'));
  const pending = Object.keys(root.dependencies).map((name) => ({
    name,
    parent: resolve('package.json'),
  }));
  const visited = new Set();
  const sections = [await readFile('THIRD_PARTY_NOTICES.md', 'utf8')];
  while (pending.length) {
    const { name, parent } = pending.shift();
    const require = createRequire(parent);
    let directory;
    try {
      directory = dirname(require.resolve(`${name}/package.json`));
    } catch {
      directory = dirname(require.resolve(name));
    }
    let manifest;
    for (;;) {
      try {
        manifest = JSON.parse(
          await readFile(join(directory, 'package.json'), 'utf8'),
        );
      } catch {
        manifest = undefined;
      }
      if (manifest?.name === name) break;
      const next = dirname(directory);
      if (next === directory)
        throw new Error(`Cannot locate license owner: ${name}`);
      directory = next;
    }
    if (visited.has(directory)) continue;
    visited.add(directory);
    const files = (await readdir(directory)).filter((file) =>
      /^(license|licence|copying|notice)(\..*)?$/i.test(file),
    );
    sections.push(
      `\n${manifest.name}@${manifest.version} — ${manifest.license}\n`,
    );
    for (const file of files)
      sections.push(await readFile(join(directory, file), 'utf8'));
    if (!files.length)
      sections.push(
        `Original license: ${typeof manifest.repository === 'string' ? manifest.repository : (manifest.repository?.url ?? manifest.homepage)}\nSee the upstream project and the notices above.`,
      );
    for (const child of Object.keys(manifest.dependencies ?? {}))
      pending.push({ name: child, parent: join(directory, 'package.json') });
  }
  await writeFile('dist/THIRD_PARTY_LICENSES.txt', sections.join('\n\n'));
}
