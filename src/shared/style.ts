/** Preserve selector values separately from attributes made inert for replay. */
export const STYLESHEET_LINK_ATTRIBUTE = 'data-floebrowser-stylesheet-link';
export const CANVAS_ATTRIBUTE = 'data-floebrowser-canvas';
export const MATHML_ATTRIBUTE = 'data-floebrowser-mathml';
export const styleAttributes: Record<string, string> = {
  href: 'data-floebrowser-href',
  src: 'data-floebrowser-src',
  'xlink:href': 'data-floebrowser-xlink-href',
  srcset: 'data-floebrowser-srcset',
  sizes: 'data-floebrowser-sizes',
  poster: 'data-floebrowser-poster',
  background: 'data-floebrowser-background',
  contenteditable: 'data-floebrowser-editable',
};

export type SourceStylesheet = {
  href: string;
  text: string | null;
  enabled: boolean;
  media: string;
};

export type SourceCanvasSize = { width: number; height: number };
