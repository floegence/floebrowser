import type { SourcePage, SourceTransport } from './source.js';

/** Close one explicitly authorized native page, honoring its beforeunload
 * decision. A response to Page.close alone does not prove the page has closed. */
export function closeCDPPage(
  page: Pick<SourcePage, 'isClosed' | 'on' | 'off'>,
  transport: SourceTransport,
): Promise<void> {
  if (page.isClosed()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      page.off('close', closed);
      transport.off('Page.javascriptDialogClosed', answered);
    };
    const closed = () => {
      cleanup();
      resolve();
    };
    const answered = ({ result }: { result: boolean }) => {
      if (!result) {
        cleanup();
        resolve();
      }
    };
    page.on('close', closed);
    transport.on('Page.javascriptDialogClosed', answered);
    void transport.send('Page.close').catch((error) => {
      cleanup();
      if (page.isClosed()) resolve();
      else reject(error);
    });
  });
}
