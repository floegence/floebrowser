import type { SourceFrame, SourcePage } from './source.js';

/** Chromium performs text matching, range selection and scrolling. No index of
 * website text or second DOM search implementation is kept by the host. */
export class SourceFind {
  private previous?: { query: string; frame: SourceFrame; context: number };
  constructor(private page: SourcePage) {}

  async next(
    query: string,
    backwards: boolean,
    restart: boolean,
    assertCurrent: () => void,
  ): Promise<boolean> {
    const frames = this.page
      .frames()
      .filter((frame) => frame.contextID && !frame.isDetached());
    if (!frames.length) return false;
    const previous = this.previous;
    const continuing =
      !restart &&
      previous?.query === query &&
      previous.context === previous.frame.contextID &&
      frames.includes(previous.frame);
    const start = continuing
      ? frames.indexOf(previous.frame)
      : backwards
        ? frames.length - 1
        : 0;
    const direction = backwards ? -1 : 1;
    // Search the remainder of the current frame, the other frames, then the
    // beginning of the original frame. A frame is reset only at a wrap boundary.
    const attempts = continuing ? frames.length + 1 : frames.length;
    for (let offset = 0; offset < attempts; offset++) {
      assertCurrent();
      const frame =
        frames[(start + offset * direction + frames.length) % frames.length]!;
      const found = await frame.evaluate(
        ({ query, backwards, reset }) => {
          const selection = window.getSelection();
          if (reset && document.body && selection) {
            const range = document.createRange();
            range.selectNodeContents(document.body);
            range.collapse(!backwards);
            selection.removeAllRanges();
            selection.addRange(range);
          }
          const found = (
            window as unknown as { find: (...args: unknown[]) => boolean }
          ).find(query, false, backwards, false, false, false, false);
          if (!found) selection?.removeAllRanges();
          return found;
        },
        { query, backwards, reset: !continuing || offset > 0 },
      );
      assertCurrent();
      if (!found) continue;
      this.previous = { query, frame, context: frame.contextID };
      for (
        let child: SourceFrame | null = frame;
        child?.parentFrame();
        child = child.parentFrame()
      ) {
        assertCurrent();
        const owner = await child.frameElement();
        try {
          assertCurrent();
          await owner.evaluate((node) => {
            node.scrollIntoView({
              block: 'nearest',
              inline: 'nearest',
              behavior: 'instant',
            });
          }, undefined);
        } finally {
          await owner.dispose();
        }
      }
      return true;
    }
    this.previous = undefined;
    return false;
  }
}
