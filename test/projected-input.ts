import type { Locator } from 'playwright';

/** Locate inert content, then deliver a real pointer event to the trusted host
 * surface at that content's position. Check actionability on the actual input
 * surface so dialogs and other browser chrome cannot swallow a forced click. */
export async function clickProjected(
  locator: Locator,
  options: Parameters<Locator['click']>[0] = {},
): Promise<void> {
  await ready(locator);
  const { surface, position } = await destination(locator, options.position);
  await surface.click({ ...options, position });
}

export async function hoverProjected(
  locator: Locator,
  options: Parameters<Locator['hover']>[0] = {},
): Promise<void> {
  await ready(locator);
  const { surface, position } = await destination(locator, options.position);
  await surface.hover({ ...options, position });
}

async function destination(locator: Locator, at?: { x: number; y: number }) {
  const surface = locator.page().locator('.floe-input-surface');
  const [target, origin] = await Promise.all([
    locator.boundingBox(),
    surface.boundingBox(),
  ]);
  if (!target || !origin)
    throw new Error('Projected input geometry unavailable');
  return {
    surface,
    position: {
      x: target.x - origin.x + (at?.x ?? target.width / 2),
      y: target.y - origin.y + (at?.y ?? target.height / 2),
    },
  };
}

async function ready(locator: Locator): Promise<void> {
  await locator.waitFor({ state: 'visible' });
  await locator.page().waitForFunction(() => {
    const surface = document.querySelector<HTMLElement>('.floe-projection');
    return (
      !!surface &&
      !surface.inert &&
      getComputedStyle(surface).visibility !== 'hidden'
    );
  });
}
