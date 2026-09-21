const paths = {
  up: '<path d="m6 14 6-6 6 6"/>',
  down: '<path d="m6 10 6 6 6-6"/>',
  reload: '<path d="M19 11a7 7 0 1 0-1 5M19 4v7h-7"/>',
  play: '<path d="m8 5 10 7-10 7Z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 6v12M16 6v12" stroke-width="3"/>',
  sound:
    '<path d="m11 5-5 4H3v6h3l5 4V5Z"/><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  muted: '<path d="m11 5-5 4H3v6h3l5 4V5Z"/><path d="m16 9 5 6m0-6-5 6"/>',
  video:
    '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3Z" fill="currentColor" stroke="none"/>',
  audio:
    '<path d="M9 17V5l11-2v12M9 9l11-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="17" cy="16" rx="3" ry="3"/>',
  close: '<path d="m7 7 10 10M17 7 7 17"/>',
  locate:
    '<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/><circle cx="12" cy="12" r="3"/>',
};
export function setIcon(element: HTMLElement, name: keyof typeof paths) {
  if (element.dataset.icon === name) return;
  element.dataset.icon = name;
  element.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
