import type { Action, DialogState } from '../shared/protocol.js';
import type { BrowserText } from './messages.js';

/** Page-local browser chrome: the tab strip remains operable while the website
 * waits. Website strings are always text, never markup or browser instructions. */
export class WebsiteDialog {
  private root = document.createElement('section');
  private heading = document.createElement('h2');
  private origin = document.createElement('p');
  private message = document.createElement('p');
  private truncation = document.createElement('p');
  private input = document.createElement('input');
  private accept = document.createElement('button');
  private cancel = document.createElement('button');
  private state: DialogState | null = null;
  private restore?: HTMLElement;
  constructor(
    container: HTMLElement,
    private text: BrowserText,
    private dispatch: (action: Action) => Promise<boolean>,
    private changed: (visible: boolean) => void,
  ) {
    this.root.className = 'website-dialog';
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', text('dialog.label'));
    this.root.tabIndex = -1;
    const description = `floe-dialog-${crypto.randomUUID()}`;
    this.message.id = description;
    this.root.setAttribute('aria-describedby', description);
    this.origin.className = 'dialog-origin';
    this.message.className = 'dialog-message';
    this.truncation.className = 'dialog-message';
    this.truncation.textContent = text('dialog.truncated');
    this.input.setAttribute('aria-label', text('dialog.response'));
    this.input.autocomplete = 'off';
    this.input.maxLength = 16000;
    this.accept.type = this.cancel.type = 'button';
    this.accept.className = 'primary-button';
    this.cancel.className = 'secondary-button';
    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    actions.append(this.cancel, this.accept);
    this.root.append(
      this.origin,
      this.heading,
      this.message,
      this.truncation,
      this.input,
      actions,
    );
    container.append(this.root);
    this.accept.addEventListener('click', () => void this.respond(true));
    this.cancel.addEventListener('click', () => void this.respond(false));
    this.root.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (
        event.key === 'Escape' ||
        (event.key === 'Enter' && event.target === this.input)
      ) {
        event.preventDefault();
        event.stopPropagation();
        void this.respond(event.key === 'Enter');
      } else if (event.key === 'Tab') {
        const controls = [this.input, this.cancel, this.accept].filter(
          (node) => !node.hidden && !node.disabled,
        );
        const index = controls.indexOf(
          document.activeElement as HTMLInputElement,
        );
        if (controls.length) {
          event.preventDefault();
          controls[
            (index + (event.shiftKey ? -1 : 1) + controls.length) %
              controls.length
          ]!.focus();
        }
      }
    });
  }
  show(state: DialogState | null): void {
    if (state?.id && state.id === this.state?.id) {
      // The source reoffers only a response it definitively rejected before
      // execution. Keep the user's draft; any retry requires another gesture.
      this.accept.disabled = this.cancel.disabled = this.input.disabled = false;
      return;
    }
    const wasInside = this.root.contains(document.activeElement);
    const wasOpen = !!this.state;
    this.state = state;
    this.root.hidden = !state;
    this.changed(!!state);
    if (!state) {
      this.input.value = '';
      if (wasInside && this.restore?.isConnected)
        this.restore.focus({ preventScroll: true });
      this.restore = undefined;
      return;
    }
    if (!wasOpen) this.restore = document.activeElement as HTMLElement;
    let origin = this.text('dialog.source');
    try {
      origin = new URL(state.url).host || origin;
    } catch {
      /* Opaque source URL. */
    }
    this.origin.textContent = origin;
    this.heading.textContent = this.text(`dialog.${state.type}`);
    this.message.textContent =
      state.type === 'beforeunload'
        ? this.text('dialog.unsaved')
        : state.message;
    this.truncation.hidden = !state.truncated;
    this.input.hidden = state.type !== 'prompt';
    this.input.value = state.defaultPrompt;
    this.cancel.hidden = state.type === 'alert';
    this.cancel.textContent = this.text(
      state.type === 'beforeunload' ? 'dialog.stay' : 'dialog.cancel',
    );
    this.accept.textContent = this.text(
      state.type === 'beforeunload' ? 'dialog.leave' : 'dialog.accept',
    );
    this.accept.disabled = this.cancel.disabled = this.input.disabled = false;
    if (state.type === 'prompt') {
      this.input.focus();
      this.input.select();
    } else (state.type === 'beforeunload' ? this.cancel : this.accept).focus();
  }
  private async respond(accept: boolean): Promise<void> {
    const state = this.state;
    if (!state || this.accept.disabled) return;
    this.accept.disabled = this.cancel.disabled = this.input.disabled = true;
    const ok = await this.dispatch({
      kind: 'dialog_reply',
      dialog: state.id,
      accept,
      ...(state.type === 'prompt' && accept ? { text: this.input.value } : {}),
    });
    if (this.state !== state) return;
    if (ok) this.show(null);
    // Do not re-enable an uncertain response. Reconnection revokes the pending
    // dialog and the host reports the unknown outcome through normal notices.
  }
  destroy(): void {
    this.show(null);
    this.root.remove();
  }
}
