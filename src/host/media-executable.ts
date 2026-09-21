import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const manifestSchema = z
  .object({
    version: z.string(),
    mediaWireVersion: z.literal(1),
    artifacts: z
      .array(
        z
          .object({
            platform: z.enum(['darwin', 'linux', 'win32']),
            arch: z.enum(['x64', 'arm64']),
            path: z.string(),
            bytes: z.number().int().positive(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(6),
  })
  .strict();

/** Resolves and verifies the released helper, never PATH or a sibling checkout. */
export function mediaExecutable(): string {
  const manifest = manifestSchema.parse(
    JSON.parse(
      readFileSync(new URL('../bin/manifest.json', import.meta.url), 'utf8'),
    ),
  );
  const { version } = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  if (manifest.version !== version)
    throw new Error('The source media bundle needs to be updated with the SDK');
  const artifact = manifest.artifacts.find(
    (item) => item.platform === process.platform && item.arch === process.arch,
  );
  const filename = `${process.platform}-${process.arch}/floebrowser-media${process.platform === 'win32' ? '.exe' : ''}`;
  if (!artifact || artifact.path !== filename)
    throw new Error(
      `Source media helper unavailable for ${process.platform}-${process.arch}`,
    );
  const url = new URL(`../bin/${filename}`, import.meta.url);
  const bytes = readFileSync(url);
  if (
    bytes.length !== artifact.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
  )
    throw new Error('Source media helper failed bundle integrity verification');
  return fileURLToPath(url);
}
