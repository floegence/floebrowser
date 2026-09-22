import { randomBytes } from 'node:crypto';
import {
  resourceReference,
  type ResourceAvailable,
} from '../shared/resources.js';
import type { SourceTransport } from './source.js';
import type { NoticeCode } from '../shared/protocol.js';
import parseCSS from 'postcss-safe-parser';
import selectorParser from 'postcss-selector-parser';
import valueParser from 'postcss-value-parser';
import {
  CANVAS_ATTRIBUTE,
  STYLESHEET_LINK_ATTRIBUTE,
  styleAttributes,
  interactionAttributes,
} from '../shared/style.js';

export const SOURCE_LINK_ATTRIBUTE = 'data-floebrowser-link';
const projectedSelectors = selectorParser((selectors) => {
  const tags: selectorParser.Tag[] = [];
  selectors.walkTags((tag) => {
    tags.push(tag);
  });
  for (const tag of tags) {
    if (tag.namespace) continue;
    const name = tag.value.toLowerCase();
    const selector =
      name === 'link'
        ? `:is(link,style:where([${STYLESHEET_LINK_ATTRIBUTE}]))`
        : name === 'style'
          ? `style:not(:where([${STYLESHEET_LINK_ATTRIBUTE}]))`
          : name === 'canvas'
            ? `:is(canvas,img:where([${CANVAS_ATTRIBUTE}]))`
            : name === 'img'
              ? `img:not(:where([${CANVAS_ATTRIBUTE}]))`
              : undefined;
    if (selector)
      tag.replaceWith(...selectorParser().astSync(selector).nodes[0]!.nodes);
  }
  selectors.walkAttributes((attribute) => {
    const name =
      attribute.namespace && attribute.namespace !== '*'
        ? `${attribute.namespace}:${attribute.attribute}`
        : attribute.attribute;
    const projected = Object.hasOwn(styleAttributes, name.toLowerCase())
      ? styleAttributes[name.toLowerCase()]
      : undefined;
    if (projected) {
      attribute.attribute = projected;
      attribute.namespace = '';
    }
  });
  selectors.walkPseudos((pseudo) => {
    const interaction = pseudo.value.slice(1).toLowerCase();
    if (Object.hasOwn(interactionAttributes, interaction)) {
      pseudo.replaceWith(
        selectorParser.attribute({
          attribute:
            interactionAttributes[
              interaction as keyof typeof interactionAttributes
            ],
          value: undefined,
          raws: {},
        }),
      );
      return;
    }
    if (
      [':link', ':any-link', ':-webkit-any-link'].includes(
        pseudo.value.toLowerCase(),
      )
    )
      pseudo.replaceWith(
        selectorParser.attribute({
          attribute: SOURCE_LINK_ATTRIBUTE,
          value: undefined,
          raws: {},
        }),
      );
  });
});

type Resource = {
  id: string;
  url: string;
  body?: Buffer;
  type?: string;
  revision: number;
  waiters: Set<() => void>;
};
type ResponseMetadata = { url: string; kind: string; type: string };
const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

function resourceKind(kind: string, mimeType: string): string | undefined {
  if (['Stylesheet', 'Image', 'Font'].includes(kind)) return kind;
  // Chromium classifies external SVG symbol documents used by <use> as Other.
  if (kind === 'Other' && mimeType.toLowerCase() === 'image/svg+xml')
    return 'Image';
  return undefined;
}

function unescapeCSS(value: string): string {
  return value.replace(
    /\\(?:([0-9a-f]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|(.))/gi,
    (_match, hex, newline, character) => {
      if (hex) {
        const code = Number.parseInt(hex, 16);
        return !code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
          ? '\ufffd'
          : String.fromCodePoint(code);
      }
      return newline ? '' : character;
    },
  );
}
function quoteCSS(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\a ');
}

/** Only serves responses observed in the source browser. Never fetches a URL. */
export class ResourceStore {
  private byURL = new Map<string, Resource>();
  private byID = new Map<string, Resource>();
  private bytes = 0;
  private closed = false;
  private requests = new Map<string, ResponseMetadata>();
  private inFlight = 0;
  private nextSession = 0;
  private disposers = new Map<SourceTransport, () => void>();

  constructor(
    private cdp: SourceTransport,
    private notice: (code: NoticeCode) => void = () => {},
    private resourceURL: (id: string) => string = (id) => `/_floe/assets/${id}`,
    private available: (resource: ResourceAvailable) => void = () => {},
  ) {}

  async start(cdp = this.cdp): Promise<void> {
    if (this.closed || this.disposers.has(cdp)) return;
    const prefix = `${++this.nextSession}:`;
    let disposed = false;
    let generation = 0;
    let recovery: Promise<void> | undefined;
    let recoveryRequested = false;
    const recover = () => {
      recoveryRequested = true;
      if (recovery || disposed || this.closed) return;
      recovery = (async () => {
        while (recoveryRequested && !disposed && !this.closed) {
          recoveryRequested = false;
          const current = generation;
          await this.captureLoaded(
            cdp,
            () => disposed || current !== generation,
          );
        }
      })()
        .catch(() => {})
        .finally(() => {
          recovery = undefined;
          if (recoveryRequested) recover();
        });
    };
    const navigated = () => {
      generation++;
    };
    const received = (event: any) => {
      const kind = resourceKind(event.type, event.response.mimeType);
      if (
        this.closed ||
        !kind ||
        event.response.status < 200 ||
        event.response.status >= 300 ||
        this.requests.size >= 2048
      )
        return;
      this.reference(event.response.url, event.response.url);
      this.requests.set(prefix + event.requestId, {
        url: event.response.url,
        kind,
        type: event.response.mimeType.toLowerCase(),
      });
    };
    const finished = (event: any) => {
      const response = this.requests.get(prefix + event.requestId);
      this.requests.delete(prefix + event.requestId);
      if (
        !response ||
        this.closed ||
        event.encodedDataLength > MAX_RESOURCE_BYTES ||
        this.inFlight >= 64
      )
        return;
      this.inFlight++;
      void this.capture(event.requestId, response, cdp)
        .catch(() => {})
        .finally(() => {
          this.inFlight--;
        });
    };
    const failed = (event: any) => {
      this.requests.delete(prefix + event.requestId);
    };
    cdp.on('Network.responseReceived', received);
    cdp.on('Network.loadingFinished', finished);
    cdp.on('Network.loadingFailed', failed);
    cdp.on('Page.frameNavigated', navigated);
    cdp.on('Page.frameStoppedLoading', recover);
    const dispose = () => {
      disposed = true;
      cdp.off('Network.responseReceived', received);
      cdp.off('Network.loadingFinished', finished);
      cdp.off('Network.loadingFailed', failed);
      cdp.off('Page.frameNavigated', navigated);
      cdp.off('Page.frameStoppedLoading', recover);
      cdp.off('close', dispose);
      for (const id of this.requests.keys())
        if (id.startsWith(prefix)) this.requests.delete(id);
      this.disposers.delete(cdp);
    };
    this.disposers.set(cdp, dispose);
    cdp.on('close', dispose);
    try {
      await cdp.send('Network.enable', {
        maxTotalBufferSize: MAX_TOTAL_BYTES,
        maxResourceBufferSize: MAX_RESOURCE_BYTES,
      });
      await cdp.send('Page.enable');
      // Popups can finish cached requests before the host attaches. Read the
      // inspected document's loaded resources as well as future network events.
      // Keep this work outside the input path; resource reads await their bodies.
      recover();
    } catch (error) {
      dispose();
      throw error;
    }
  }

  private async captureLoaded(
    cdp: SourceTransport,
    obsolete: () => boolean,
  ): Promise<void> {
    const { frameTree } = await cdp.send('Page.getResourceTree');
    const frames = [frameTree];
    while (frames.length && !this.closed && !obsolete()) {
      const tree = frames.shift()!;
      frames.push(...(tree.childFrames ?? []));
      for (const entry of tree.resources) {
        if (this.closed || obsolete()) return;
        const kind = resourceKind(entry.type, entry.mimeType);
        if (
          !kind ||
          entry.failed ||
          entry.canceled ||
          (entry.contentSize ?? 0) > MAX_RESOURCE_BYTES
        )
          continue;
        try {
          this.reference(entry.url, entry.url);
          const url = new URL(entry.url);
          url.hash = '';
          const resource = this.byURL.get(url.href);
          if (!resource || resource.body) continue;
          const body = await cdp.send('Page.getResourceContent', {
            frameId: tree.frame.id,
            url: entry.url,
          });
          // A newer network response, navigation or detachment wins over this
          // asynchronous read of the document cache.
          if (this.closed || obsolete()) return;
          if (!resource.body)
            this.store(
              resource,
              {
                url: entry.url,
                kind,
                type: entry.mimeType.toLowerCase(),
              },
              Buffer.from(body.content, body.base64Encoded ? 'base64' : 'utf8'),
            );
        } catch {
          // Evicted or still-loading bodies remain unavailable. A document load
          // event revisits resources missed while the observer was attaching.
        }
      }
    }
  }

  reference(value: string, base: string): string {
    if (value.startsWith('#')) return value;
    if (
      /^data:(?:image\/(?:png|jpeg|gif|webp|svg\+xml)|font\/[a-z0-9.+-]+)[;,]/i.test(
        value,
      ) &&
      value.length <= MAX_RESOURCE_BYTES
    )
      return value;
    let url: URL;
    try {
      url = new URL(value, base);
    } catch {
      return '/_floe/unavailable';
    }
    if (
      !['http:', 'https:', 'blob:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return '/_floe/unavailable';
    const fragment = url.hash;
    url.hash = '';
    let resource = this.byURL.get(url.href);
    if (!resource) {
      if (this.closed) return '/_floe/unavailable';
      if (this.byURL.size >= 2048)
        this.evict(this.byURL.values().next().value!);
      resource = {
        id: randomBytes(18).toString('base64url'),
        url: url.href,
        revision: 0,
        waiters: new Set(),
      };
      this.byURL.set(url.href, resource);
      this.byID.set(resource.id, resource);
    }
    this.byURL.delete(resource.url);
    this.byURL.set(resource.url, resource);
    return `${resourceReference(this.resourceURL(resource.id))}${fragment}`;
  }

  value(css: string, base: string): string {
    const parsed = valueParser(css);
    parsed.walk((node) => {
      if (
        node.type === 'function' &&
        ['image-set', '-webkit-image-set'].includes(node.value.toLowerCase())
      ) {
        for (const candidate of node.nodes)
          if (candidate.type === 'string') {
            candidate.quote = '"';
            candidate.value = quoteCSS(
              this.reference(unescapeCSS(candidate.value), base),
            );
          }
      }
      if (node.type === 'function' && node.value.toLowerCase() === 'url') {
        const raw = valueParser
          .stringify(node.nodes)
          .trim()
          .replace(/^(['"])([\s\S]*)\1$/, '$2');
        node.nodes = [
          {
            type: 'string',
            quote: '"',
            value: quoteCSS(this.reference(unescapeCSS(raw), base)),
            sourceIndex: 0,
            sourceEndIndex: 0,
          },
        ];
        return false;
      }
    });
    return parsed.toString();
  }

  css(css: string, base: string): string {
    // Websites may contain invalid declarations that Chromium ignores. Preserve
    // the surrounding stylesheet while still rewriting its resource references.
    const root = parseCSS(css, { map: { prev: false } });
    root.walkRules((rule) => {
      try {
        // A data attribute has the same specificity as the original pseudo-class
        // and preserves link styling without a client-side navigation target.
        rule.selector = projectedSelectors.processSync(rule.selector);
      } catch {
        // An invalid selector must not discard unrelated rules in the sheet.
      }
    });
    root.walkDecls((declaration) => {
      declaration.value = this.value(declaration.value, base);
    });
    root.walkAtRules((rule) => {
      rule.params = this.value(rule.params, base);
      if (rule.name.toLowerCase() === 'import') {
        const parsed = valueParser(rule.params);
        const first = parsed.nodes.find(
          (node) => node.type !== 'space' && node.type !== 'comment',
        );
        if (first?.type === 'string') {
          first.quote = '"';
          first.value = quoteCSS(
            this.reference(unescapeCSS(first.value), base),
          );
        }
        rule.params = parsed.toString();
      }
    });
    return root.toString();
  }

  private async capture(
    requestID: string,
    response: ResponseMetadata,
    cdp: SourceTransport,
  ): Promise<void> {
    const url = new URL(response.url);
    url.hash = '';
    const resource = this.byURL.get(url.href);
    if (!resource) return;
    // Chromium owns a bounded response buffer; a missing body is never refetched.
    const body = await cdp.send('Network.getResponseBody', {
      requestId: requestID,
    });
    const data = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8');
    this.store(resource, response, data);
  }

  private store(
    resource: Resource,
    response: ResponseMetadata,
    data: Buffer,
  ): void {
    if (this.closed) return;
    if (data.length > MAX_RESOURCE_BYTES) {
      this.notice('resource_limit');
      return;
    }
    while (
      this.bytes - (resource.body?.length ?? 0) + data.length >
      MAX_TOTAL_BYTES
    ) {
      const oldest = Array.from(this.byURL.values()).find(
        (item) => item !== resource && item.body,
      );
      if (!oldest) return;
      this.evict(oldest);
    }
    if (this.byID.get(resource.id) !== resource) return;
    const { type, kind } = response;
    if (
      kind === 'Image' &&
      !/^image\/(png|jpeg|gif|webp|avif|svg\+xml|x-icon|vnd.microsoft.icon)$/.test(
        type,
      )
    )
      return;
    this.bytes -= resource.body?.length ?? 0;
    resource.body = data;
    resource.type =
      kind === 'Stylesheet'
        ? 'text/css'
        : kind === 'Font'
          ? type.startsWith('font/')
            ? type
            : 'application/octet-stream'
          : type;
    this.bytes += data.length;
    resource.revision++;
    this.available(this.descriptor(resource));
    for (const resolve of resource.waiters) resolve();
    resource.waiters.clear();
  }

  private descriptor(resource: Resource): ResourceAvailable {
    return {
      reference: resourceReference(this.resourceURL(resource.id)),
      type: resource.type!,
      revision: resource.revision,
    };
  }

  availableResources(): ResourceAvailable[] {
    return [...this.byID.values()]
      .filter((resource) => resource.body && resource.type)
      .map((resource) => this.descriptor(resource));
  }

  private evict(resource: Resource): void {
    this.bytes -= resource.body?.length ?? 0;
    this.byID.delete(resource.id);
    this.byURL.delete(resource.url);
    for (const resolve of resource.waiters) resolve();
    resource.waiters.clear();
  }

  async read(id: string): Promise<{ body: Buffer; type: string } | undefined> {
    const resource = this.byID.get(id);
    if (!resource || this.closed) return;
    this.byURL.delete(resource.url);
    this.byURL.set(resource.url, resource);
    if (!resource.body) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          resource.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, 8000);
        resource.waiters.add(done);
      });
    }
    if (!resource.body || !resource.type || this.closed) return;
    return {
      body:
        resource.type === 'text/css'
          ? Buffer.from(this.css(resource.body.toString('utf8'), resource.url))
          : resource.body,
      type: resource.type,
    };
  }

  stop(transport: SourceTransport): void {
    this.disposers.get(transport)?.();
  }

  close(): void {
    this.closed = true;
    for (const dispose of this.disposers.values()) dispose();
    this.requests.clear();
    for (const resource of this.byURL.values())
      for (const resolve of resource.waiters) resolve();
    this.byURL.clear();
    this.byID.clear();
    this.bytes = 0;
  }
}
