import {
  resourceReferences,
  type ResourceAvailable,
} from '../shared/resources.js';

export type ResourceFetch = (
  url: string,
  signal: AbortSignal,
) => Promise<Response>;
const unavailable = 'data:,';
const maxResource = 8 * 1024 * 1024;
const maxTotal = 64 * 1024 * 1024;
const attributes = [
  'src',
  'href',
  'xlink:href',
  'poster',
  'background',
  'style',
];
type Entry = {
  key: string;
  source: string;
  url: string;
  revision: number;
  pending: boolean;
  bytes: number;
  rendered?: string;
  lineage: Set<string>;
  dependencies: Set<string>;
  listeners: Set<() => void>;
  detach: Array<() => void>;
};

/** Source capture announces availability; unobserved website resources never
 * trigger a fetch or hold presentation. The trusted document reads opaque host
 * URLs and publishes blobs into the unchanged scriptless replay. Dependency
 * updates are driven by captured source responses, never polling or retries. */
export class ReplayResources {
  private lifetime = new AbortController();
  private entries = new Map<string, Entry>();
  private known = new Map<string, ResourceAvailable>();
  private observers = new Map<Node, MutationObserver>();
  private bindings = new Set<() => boolean>();
  private bytes = 0;
  private active = 0;
  private queue: Array<() => void> = [];
  private warned = false;

  constructor(
    private notice: () => void,
    private read: ResourceFetch = (url, signal) =>
      fetch(url, {
        signal,
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
      }),
  ) {}

  get pending(): boolean {
    return [...this.entries.values()].some(
      (entry) =>
        entry.pending && this.known.get(entry.key)?.type === 'text/css',
    );
  }

  get fontsPending(): boolean {
    return [...this.entries.values()].some(
      (entry) =>
        entry.pending &&
        /^(font\/|application\/octet-stream)/u.test(
          this.known.get(entry.key)?.type ?? '',
        ),
    );
  }

  available(resource: ResourceAvailable): void {
    if (this.lifetime.signal.aborted) return;
    const match = [...resource.reference.matchAll(resourceReferences())];
    if (
      match.length !== 1 ||
      match[0]![0] !== resource.reference ||
      !Number.isSafeInteger(resource.revision) ||
      resource.revision < 1
    )
      return;
    const key = match[0]![1]!;
    if ((this.known.get(key)?.revision ?? 0) >= resource.revision) return;
    if (!this.known.has(key) && this.known.size >= 2048) {
      this.warn();
      return;
    }
    this.known.set(key, resource);
    const entry = this.entries.get(key);
    if (entry) this.load(entry);
  }

  private warn(): void {
    if (!this.warned && !this.lifetime.signal.aborted) {
      this.warned = true;
      this.notice();
    }
  }

  private async body(
    response: Response,
    signal: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>> {
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('Resource unavailable');
    }
    if (Number(response.headers.get('content-length')) > maxResource) {
      await response.body.cancel();
      throw new Error('Resource limit');
    }
    const reader = response.body.getReader();
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    const chunks: Uint8Array[] = [];
    let length = 0,
      complete = false;
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        if (
          length + chunk.value.byteLength > maxResource ||
          this.bytes + chunk.value.byteLength > maxTotal
        )
          throw new Error('Resource limit');
        length += chunk.value.byteLength;
        this.bytes += chunk.value.byteLength;
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      complete = true;
      return bytes;
    } finally {
      if (!complete) this.bytes -= length;
      signal.removeEventListener('abort', abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  private async fetch(
    url: string,
  ): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string }> {
    if (this.active >= 8) {
      if (this.queue.length >= 512) throw new Error('Resource queue limit');
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else this.active++;
    try {
      this.lifetime.signal.throwIfAborted();
      const signal = AbortSignal.any([
        this.lifetime.signal,
        AbortSignal.timeout(10000),
      ]);
      const response = await this.read(url, signal);
      const type =
        response.headers
          .get('content-type')
          ?.split(';')[0]
          ?.trim()
          .toLowerCase() ?? '';
      if (
        !/^(?:text\/css|image\/(?:png|jpeg|gif|webp|avif|svg\+xml|x-icon|vnd.microsoft.icon)|font\/[a-z0-9.+-]+|application\/octet-stream)$/u.test(
          type,
        )
      ) {
        await response.body?.cancel();
        throw new Error('Unsupported resource');
      }
      return { bytes: await this.body(response, signal), type };
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }

  private resolve(
    key: string,
    ancestors = new Set<string>(),
  ): Entry | undefined {
    if (
      this.lifetime.signal.aborted ||
      ancestors.has(key) ||
      ancestors.size >= 8
    )
      return;
    const known = this.entries.get(key);
    if (known) {
      const pending = [key],
        visited = new Set<string>();
      while (pending.length) {
        const current = pending.pop()!;
        if (ancestors.has(current)) return;
        if (visited.has(current)) continue;
        visited.add(current);
        pending.push(...(this.entries.get(current)?.dependencies ?? []));
      }
      return known;
    }
    if (this.entries.size >= 2048) {
      this.warn();
      return;
    }
    let url: URL;
    try {
      url = new URL(decodeURIComponent(key), location.href);
      if (
        url.origin !== location.origin ||
        url.username ||
        url.password ||
        !['http:', 'https:'].includes(url.protocol)
      )
        return;
    } catch {
      return;
    }
    const entry: Entry = {
      key,
      source: url.href,
      url: unavailable,
      revision: 0,
      pending: false,
      bytes: 0,
      lineage: new Set(ancestors),
      dependencies: new Set(),
      listeners: new Set(),
      detach: [],
    };
    this.entries.set(key, entry);
    this.load(entry);
    return entry;
  }

  private publish(entry: Entry, body: BlobPart, type: string): void {
    if (this.lifetime.signal.aborted) return;
    const previous = entry.url;
    entry.url = URL.createObjectURL(new Blob([body], { type }));
    for (const listener of [...entry.listeners]) listener();
    if (previous !== unavailable) URL.revokeObjectURL(previous);
  }

  private load(entry: Entry): void {
    const resource = this.known.get(entry.key);
    if (
      !resource ||
      entry.pending ||
      entry.revision >= resource.revision ||
      this.lifetime.signal.aborted
    )
      return;
    entry.pending = true;
    entry.revision = resource.revision;
    void (async () => {
      const response = await this.fetch(entry.source);
      this.bytes -= entry.bytes;
      entry.bytes = response.bytes.byteLength;
      this.lifetime.signal.throwIfAborted();
      for (const detach of entry.detach.splice(0)) detach();
      entry.dependencies.clear();
      entry.rendered = undefined;
      if (response.type !== 'text/css') {
        this.publish(entry, response.bytes, response.type);
        return;
      }
      const css = new TextDecoder().decode(response.bytes);
      const dependencies = new Map<string, Entry | undefined>();
      for (const match of css.matchAll(resourceReferences())) {
        const key = match[1]!;
        const dependency = this.resolve(
          key,
          new Set(entry.lineage).add(entry.key),
        );
        dependencies.set(key, dependency);
        if (dependency) entry.dependencies.add(key);
      }
      const render = () => {
        const next = css.replace(
          resourceReferences(),
          (_match, key: string) => dependencies.get(key)?.url ?? unavailable,
        );
        if (next === entry.rendered) return;
        entry.rendered = next;
        this.publish(entry, next, 'text/css');
      };
      for (const dependency of dependencies.values())
        if (dependency) {
          dependency.listeners.add(render);
          entry.detach.push(() => dependency.listeners.delete(render));
        }
      render();
    })()
      .catch((error) => {
        if (error instanceof Error && /limit/u.test(error.message)) this.warn();
      })
      .finally(() => {
        entry.pending = false;
        // A newer captured response can supersede a read already in progress.
        // A failed read of this revision is terminal until the source changes.
        this.load(entry);
      });
  }

  private bind(
    get: () => string,
    set: (value: string) => void,
    live: () => boolean = () => true,
  ): void {
    const original = get();
    const matches = [...original.matchAll(resourceReferences())];
    if (!matches.length || this.lifetime.signal.aborted) return;
    if (this.bindings.size >= 16384) {
      set(original.replace(resourceReferences(), unavailable));
      this.warn();
      return;
    }
    const entries = new Map(
      matches.map((match) => [match[1]!, this.resolve(match[1]!)]),
    );
    let projected = original,
      initial = true;
    const dispose = () => {
      this.bindings.delete(apply);
      for (const entry of entries.values()) entry?.listeners.delete(apply);
    };
    const apply = (): boolean => {
      if (
        this.lifetime.signal.aborted ||
        (!initial && !live()) ||
        get() !== projected
      ) {
        dispose();
        return false;
      }
      initial = false;
      const next = original.replace(
        resourceReferences(),
        (_match, key: string) => entries.get(key)?.url ?? unavailable,
      );
      if (next !== projected) {
        projected = next;
        set(next);
      }
      return true;
    };
    this.bindings.add(apply);
    for (const entry of entries.values()) entry?.listeners.add(apply);
    apply();
  }

  font(source: string, ready: (source: string) => void): void {
    const matches = [...source.matchAll(resourceReferences())];
    if (!matches.length) {
      ready(source);
      return;
    }
    if (this.bindings.size >= 16384) {
      this.warn();
      return;
    }
    const entries = new Map(
      matches.map((match) => [match[1]!, this.resolve(match[1]!)]),
    );
    const apply = (): boolean => {
      if (this.lifetime.signal.aborted) return false;
      if (
        [...entries.values()].some(
          (entry) => !entry || entry.url === unavailable,
        )
      )
        return true;
      this.bindings.delete(apply);
      for (const entry of entries.values()) entry?.listeners.delete(apply);
      ready(
        source.replace(
          resourceReferences(),
          (_match, key: string) => entries.get(key)!.url,
        ),
      );
      return false;
    };
    this.bindings.add(apply);
    for (const entry of entries.values()) entry?.listeners.add(apply);
    apply();
  }

  build(node: Node): void {
    if (this.lifetime.signal.aborted) return;
    if (node.nodeType === 1) {
      const element = node as Element;
      for (const attribute of attributes) {
        // href only belongs to inert SVG/image resources, never website links.
        if (
          (attribute === 'href' || attribute === 'xlink:href') &&
          !['use', 'image'].includes(element.localName)
        )
          continue;
        this.bind(
          () => element.getAttribute(attribute) ?? '',
          (value) => element.setAttribute(attribute, value),
          () => element.isConnected,
        );
      }
      if (element.shadowRoot) this.observe(element.shadowRoot);
    } else if (
      node.nodeType === 3 &&
      node.parentElement?.localName === 'style'
    ) {
      this.bind(
        () => node.textContent ?? '',
        (value) => {
          node.textContent = value;
        },
        () => node.isConnected,
      );
    }
    if (node.nodeType === 9) this.observe(node);
  }

  private observe(root: Node): void {
    if (this.observers.has(root) || this.lifetime.signal.aborted) return;
    const visit = (node: Node) => {
      this.build(node);
      for (const child of node.childNodes) visit(child);
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'childList')
          for (const node of record.addedNodes) visit(node);
        else this.build(record.target);
      }
      if (records.some((record) => record.removedNodes.length))
        for (const check of this.bindings) check();
    });
    this.observers.set(root, observer);
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: attributes,
    });
    visit(root);
  }

  styles(): void {
    if (this.lifetime.signal.aborted) return;
    const rules = (list: CSSRuleList) => {
      for (const rule of list) {
        if ('style' in rule) {
          const style = (rule as CSSStyleRule).style;
          for (const name of [...style])
            this.bind(
              () => style.getPropertyValue(name),
              (value) =>
                style.setProperty(name, value, style.getPropertyPriority(name)),
            );
        }
        if (rule.type === 3) {
          const parent = rule.parentStyleSheet;
          const index = parent ? [...parent.cssRules].indexOf(rule) : -1;
          if (parent && index >= 0)
            this.bind(
              () => parent.cssRules[index]?.cssText ?? '',
              (value) => {
                parent.deleteRule(index);
                parent.insertRule(value, index);
              },
            );
        }
        if ('cssRules' in rule) rules((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const node of this.observers.keys()) {
      const root = node as Document | ShadowRoot;
      for (const sheet of [...root.styleSheets, ...root.adoptedStyleSheets]) {
        try {
          rules(sheet.cssRules);
        } catch {
          /* Inaccessible sheets stay inert. */
        }
      }
    }
  }

  dispose(): void {
    this.lifetime.abort();
    for (const observer of this.observers.values()) observer.disconnect();
    this.observers.clear();
    for (const resume of this.queue.splice(0)) resume();
    for (const entry of this.entries.values()) {
      if (entry.url !== unavailable) URL.revokeObjectURL(entry.url);
      entry.listeners.clear();
      entry.detach.length = 0;
    }
    this.entries.clear();
    this.known.clear();
    this.bindings.clear();
  }
}
