import { fileURLToPath } from 'node:url';

/** Resolved within the released package, never through PATH or a sibling repo. */
export function mediaExecutable(): string {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  return fileURLToPath(
    new URL(
      `../bin/${process.platform}-${process.arch}/floebrowser-media${suffix}`,
      import.meta.url,
    ),
  );
}
