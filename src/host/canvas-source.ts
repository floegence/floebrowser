/** Keep only the current bitmap of rendered source canvases. WebGL discards its
 * drawing buffer after presentation, so observation must precede that boundary.
 * Commands are never recorded or replayed; no website code reaches the viewer. */
export function observeCanvas(win: Window & typeof globalThis, key: string) {
  type Surface = {
    bitmap: OffscreenCanvas;
    width: number;
    height: number;
    revision: number;
    error?: string;
  };
  const existing = (win as any)[key] as ReturnType<typeof install> | undefined;
  if (existing) return existing;
  function install() {
    const surfaces = new Map<HTMLCanvasElement, Surface>();
    const dirty = new Set<HTMLCanvasElement>();
    const contexts = new WeakMap<HTMLCanvasElement, string>();
    const restores: (() => void)[] = [];
    let queued = false;
    let closed = false;
    let revision = 0;
    const capture = (canvas: HTMLCanvasElement) => {
      if (closed || !canvas.isConnected || !canvas.width || !canvas.height)
        return;
      if (!canvas.checkVisibility()) return;
      // This is a bounded source-local current-state cache, not a recording.
      // Hidden and detached surfaces cannot displace visible editor content.
      let surface = surfaces.get(canvas);
      if (!surface) {
        for (const element of surfaces.keys())
          if (!element.isConnected || !element.checkVisibility())
            surfaces.delete(element);
        if (surfaces.size >= 8) return;
        surface = {
          bitmap: new OffscreenCanvas(1, 1),
          width: 0,
          height: 0,
          revision: 0,
        };
        surfaces.set(canvas, surface);
      }
      surface.width = canvas.width;
      surface.height = canvas.height;
      const scale = Math.min(1, 1280 / Math.max(canvas.width, canvas.height));
      const width = Math.max(1, Math.round(canvas.width * scale));
      const height = Math.max(1, Math.round(canvas.height * scale));
      if (surface.bitmap.width !== width || surface.bitmap.height !== height) {
        surface.bitmap.width = width;
        surface.bitmap.height = height;
      }
      try {
        if (contexts.get(canvas) === 'offscreen')
          throw new Error('This graphics context is not supported.');
        const ctx = surface.bitmap.getContext('2d')!;
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(canvas, 0, 0, width, height);
        surface.error = undefined;
      } catch {
        surface.error = 'This canvas cannot be forwarded.';
      }
      surface.revision = ++revision;
    };
    const changed = (canvas: HTMLCanvasElement) => {
      dirty.add(canvas);
      if (queued) return;
      queued = true;
      // Coalesce the complete render task, before the browser discards WebGL's
      // back buffer. Never force redraws or change context creation options.
      queueMicrotask(() => {
        queued = false;
        for (const canvas of dirty) capture(canvas);
        dirty.clear();
      });
    };
    const watch = (
      prototype: any,
      names: string[],
      elements = (context: { canvas: HTMLCanvasElement }) => [context.canvas],
    ) => {
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        if (!descriptor?.configurable || typeof descriptor.value !== 'function')
          continue;
        const original = descriptor.value;
        const observed = function (
          this: { canvas: HTMLCanvasElement },
          ...args: unknown[]
        ) {
          const result = Reflect.apply(original, this, args);
          try {
            for (const canvas of elements(this)) changed(canvas);
          } catch {
            /* Preserve the native result. */
          }
          return result;
        };
        Object.defineProperty(prototype, name, {
          ...descriptor,
          value: observed,
        });
        restores.push(() => {
          if (prototype[name] === observed)
            Object.defineProperty(prototype, name, descriptor);
        });
      }
    };
    for (const name of ['getContext', 'transferControlToOffscreen'] as const) {
      const prototype = win.HTMLCanvasElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (!descriptor?.configurable || typeof descriptor.value !== 'function')
        continue;
      const original = descriptor.value;
      const observed = function (this: HTMLCanvasElement, ...args: unknown[]) {
        const result = Reflect.apply(original, this, args);
        try {
          if (result && !contexts.has(this)) {
            // Do not coerce the native argument a second time: conversion can
            // have website-owned effects or throw.
            contexts.set(
              this,
              name === 'transferControlToOffscreen'
                ? 'offscreen'
                : typeof args[0] === 'string'
                  ? args[0]
                  : 'unknown',
            );
            changed(this);
          }
        } catch {
          /* Preserve the native result. */
        }
        return result;
      };
      Object.defineProperty(prototype, name, {
        ...descriptor,
        value: observed,
      });
      restores.push(() => {
        if (prototype[name] === observed)
          Object.defineProperty(prototype, name, descriptor);
      });
    }
    watch(win.CanvasRenderingContext2D.prototype, [
      'clearRect',
      'fillRect',
      'strokeRect',
      'fill',
      'stroke',
      'fillText',
      'strokeText',
      'drawImage',
      'putImageData',
      'reset',
    ]);
    for (const Context of [
      win.WebGLRenderingContext,
      win.WebGL2RenderingContext,
    ]) {
      if (!Context) continue;
      watch(Context.prototype, [
        'clear',
        'drawArrays',
        'drawElements',
        'drawArraysInstanced',
        'drawElementsInstanced',
        'blitFramebuffer',
        'clearBufferfv',
        'clearBufferiv',
        'clearBufferuiv',
        'clearBufferfi',
      ]);
    }
    const gpu = win as any;
    if (gpu.GPUCanvasContext && gpu.GPUQueue) {
      watch(
        gpu.GPUCanvasContext.prototype,
        ['getCurrentTexture'],
        (context) => {
          // Late attachment may miss getContext(). Texture acquisition identifies
          // the native context so subsequent asynchronous submission is observed.
          contexts.set(context.canvas, 'webgpu');
          return [context.canvas];
        },
      );
      // A command buffer may be submitted in a later microtask than texture
      // acquisition. Observe completion of native submission before automatic
      // presentation expires the texture; never record GPU commands or redraw.
      watch(gpu.GPUQueue.prototype, ['submit'], () =>
        [...surfaces.keys()].filter(
          (canvas) => contexts.get(canvas) === 'webgpu',
        ),
      );
    }
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes' && record.target.nodeName === 'CANVAS')
          changed(record.target as HTMLCanvasElement);
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          const element = node as Element;
          if (element.localName === 'canvas')
            changed(element as HTMLCanvasElement);
          element.querySelectorAll('canvas').forEach(changed);
        }
      }
      for (const element of surfaces.keys())
        if (!element.isConnected) surfaces.delete(element);
    });
    mutations.observe(win.document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['width', 'height'],
    });
    return {
      get(canvas: HTMLCanvasElement) {
        if (!surfaces.has(canvas)) capture(canvas);
        return surfaces.get(canvas);
      },
      close() {
        if (closed) return;
        closed = true;
        mutations.disconnect();
        restores.forEach((restore) => restore());
        surfaces.clear();
        dirty.clear();
        delete (win as any)[key];
      },
    };
  }
  const observer = install();
  (win as any)[key] = observer;
  return observer;
}
