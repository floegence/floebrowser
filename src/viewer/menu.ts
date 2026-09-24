/** Host-owned actions only. Labels and descriptions are plain, localized text;
 * callbacks run directly in the user's activation and are never replayed. */
export type BrowserMenu = {
  label: string;
  actions: readonly {
    label: string;
    description?: string;
    run(): void | Promise<void>;
    failureMessage: string | ((error: unknown) => string);
  }[];
};

export function mountBrowserMenu(
  root: HTMLElement,
  trigger: HTMLButtonElement,
  menu: HTMLElement,
  options: BrowserMenu | undefined,
  notice: (message: string) => void,
  signal: AbortSignal,
): void {
  if (!options?.actions.length) return;
  trigger.hidden = false;
  trigger.title = options.label;
  trigger.setAttribute('aria-label', options.label);
  trigger.setAttribute('aria-controls', menu.id);
  menu.setAttribute('aria-label', options.label);
  const close = (restoreFocus = false) => {
    menu.hidePopover();
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !signal.aborted) trigger.focus();
  };
  const buttons = options.actions.map((action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.setAttribute('aria-label', action.label);
    const label = document.createElement('span');
    label.textContent = action.label;
    button.append(label);
    if (action.description) {
      const description = document.createElement('small');
      description.textContent = action.description;
      button.append(description);
    }
    button.addEventListener(
      'click',
      async () => {
        if (button.disabled || signal.aborted) return;
        close(true);
        button.disabled = true;
        try {
          await action.run();
        } catch (error) {
          if (!signal.aborted)
            notice(
              typeof action.failureMessage === 'function'
                ? action.failureMessage(error)
                : action.failureMessage,
            );
        } finally {
          button.disabled = false;
        }
      },
      { signal },
    );
    menu.append(button);
    return button;
  });
  const open = (last = false) => {
    menu.showPopover();
    trigger.setAttribute('aria-expanded', 'true');
    const bounds = trigger.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(bounds.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(bounds.bottom + 4, innerHeight - menu.offsetHeight - 8))}px`;
    const enabled = buttons.filter((button) => !button.disabled);
    (last ? enabled.at(-1) : enabled[0])?.focus();
  };
  trigger.addEventListener(
    'click',
    () => {
      if (menu.matches(':popover-open')) close();
      else open();
    },
    { signal },
  );
  trigger.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      event.stopPropagation();
      open(event.key === 'ArrowUp');
    },
    { signal },
  );
  menu.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      if (event.key === 'Tab') {
        close();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const enabled = buttons.filter((button) => !button.disabled);
      const index = enabled.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? enabled.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) %
              enabled.length;
      enabled[next]?.focus();
    },
    { signal },
  );
  root.ownerDocument.addEventListener(
    'pointerdown',
    (event) => {
      if (
        !menu.contains(event.target as Node) &&
        !trigger.contains(event.target as Node)
      )
        close();
    },
    { signal, capture: true },
  );
  menu.addEventListener(
    'focusout',
    (event) => {
      if (
        !menu.contains(event.relatedTarget as Node | null) &&
        event.relatedTarget !== trigger
      )
        close();
    },
    { signal },
  );
  window.addEventListener('blur', () => close(), { signal });
  window.addEventListener('resize', () => close(), { signal });
  signal.addEventListener('abort', () => close(), { once: true });
}
