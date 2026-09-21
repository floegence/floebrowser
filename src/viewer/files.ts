import type { Action, FileChooserState } from '../shared/protocol.js';
import type { BrowserText } from './messages.js';

/** The remote request cannot open the local picker without a new client gesture.
 * Selected bytes use the host file carrier; commands contain only opaque IDs. */
export class FilePicker {
  private root = document.createElement('section');
  private origin = document.createElement('p');
  private title = document.createElement('h2');
  private status = document.createElement('p');
  private select = document.createElement('button');
  private cancel = document.createElement('button');
  private input = document.createElement('input');
  private request: FileChooserState | null = null;
  private abort?: AbortController;
  private restore?: HTMLElement;
  constructor(
    container: HTMLElement,
    private text: BrowserText,
    private upload: (
      request: FileChooserState,
      file: File,
      signal: AbortSignal,
    ) => Promise<string>,
    private dispatch: (action: Action) => Promise<boolean>,
    private changed: (open: boolean) => void,
  ) {
    this.root.className = 'website-dialog file-picker';
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', text('files.label'));
    this.origin.className = 'dialog-origin';
    this.status.className = 'dialog-message';
    this.status.setAttribute('role', 'status');
    this.select.type = this.cancel.type = 'button';
    this.select.className = 'primary-button';
    this.cancel.className = 'secondary-button';
    this.cancel.textContent = text('dialog.cancel');
    this.input.type = 'file';
    this.input.hidden = true;
    this.input.setAttribute('aria-label', text('files.label'));
    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    actions.append(this.cancel, this.select);
    this.root.append(this.origin, this.title, this.status, this.input, actions);
    container.append(this.root);
    this.select.addEventListener('click', () => this.input.click());
    this.input.addEventListener('change', () => void this.send());
    this.input.addEventListener('cancel', () => void this.dismiss());
    this.cancel.addEventListener('click', () => void this.dismiss());
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        void this.dismiss();
      } else if (event.key === 'Tab') {
        const next =
          document.activeElement === this.select || this.select.disabled
            ? this.cancel
            : this.select;
        event.preventDefault();
        next.focus();
      }
    });
  }
  show(request: FileChooserState | null, available = true): void {
    this.abort?.abort();
    this.abort = undefined;
    const wasInside = this.root.contains(document.activeElement);
    const wasOpen = !!this.request;
    this.request = request;
    this.root.hidden = !request;
    this.input.value = '';
    this.changed(!!request);
    if (!request) {
      if (wasInside && this.restore?.isConnected)
        this.restore.focus({ preventScroll: true });
      this.restore = undefined;
      return;
    }
    if (!wasOpen) this.restore = document.activeElement as HTMLElement;
    let origin = this.text('dialog.source');
    try {
      origin = new URL(request.url).host || origin;
    } catch {
      /* Opaque source URL. */
    }
    this.origin.textContent = origin;
    this.title.textContent = this.select.textContent = this.text(
      request.directory ? 'files.directory' : 'files.choose',
    );
    this.status.textContent = this.text(
      available ? 'files.description' : 'files.unavailable',
    );
    this.select.disabled = !available;
    this.cancel.disabled = false;
    this.input.multiple = request.multiple;
    this.input.webkitdirectory = request.directory;
    this.input.accept = request.accept;
    (available ? this.select : this.cancel).focus();
  }
  private async send(): Promise<void> {
    const request = this.request;
    const files = [...(this.input.files ?? [])];
    if (!request || !files.length || this.abort) return;
    if (
      files.length > request.maxFiles ||
      files.reduce((total, file) => total + file.size, 0) > request.maxBytes
    ) {
      this.status.textContent = this.text('files.limit');
      this.input.value = '';
      return;
    }
    const abort = (this.abort = new AbortController());
    this.select.disabled = true;
    const ids: string[] = [];
    try {
      for (const file of files) {
        this.status.textContent = this.text('files.uploading', {
          current: ids.length + 1,
          total: files.length,
        });
        ids.push(await this.upload(request, file, abort.signal));
        abort.signal.throwIfAborted();
      }
      this.cancel.disabled = true;
      const ok = await this.dispatch({
        kind: 'file_reply',
        chooser: request.id,
        files: ids,
      });
      if (this.request !== request) return;
      if (!ok) this.status.textContent = this.text('files.failed');
      // An uncertain source effect is never resubmitted. Cancel only retires its
      // old request; selecting again requires another gesture on the source.
      this.cancel.disabled = false;
    } catch {
      if (this.request === request && !abort.signal.aborted)
        this.status.textContent = this.text('files.failed');
    }
  }
  private async dismiss(): Promise<void> {
    const request = this.request;
    if (!request || this.cancel.disabled) return;
    this.abort?.abort();
    this.cancel.disabled = this.select.disabled = true;
    await this.dispatch({
      kind: 'file_reply',
      chooser: request.id,
      files: null,
    });
    if (this.request === request) this.show(null);
  }
  destroy(): void {
    this.show(null);
    this.root.remove();
  }
}
