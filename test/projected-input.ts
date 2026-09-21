import type { Locator } from 'playwright';

/** Locate inert content, then deliver a real pointer event to the trusted host
 * surface at that content's position. Frame-node actionability deliberately
 * fails because projected nodes never receive local browser input. */
export async function clickProjected(
  locator: Locator,
  options: Parameters<Locator['click']>[0] = {},
): Promise<void> {
  await ready(locator);
  await locator.click({ ...options, force: true });
}

export async function hoverProjected(
  locator: Locator,
  options: Parameters<Locator['hover']>[0] = {},
): Promise<void> {
  await ready(locator);
  await locator.hover({ ...options, force: true });
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
