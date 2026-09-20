import { randomBytes } from 'node:crypto';
import type { CDPSession } from 'playwright';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';

type Resource = {
  id: string;
  url: string;
  body?: Buffer;
  type?: string;
  waiters: Set<() => void>;
};
const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** Only serves responses observed in the source browser. Never fetches a URL. */
export class ResourceStore {
  private byURL = new Map<string, Resource>();
  private byID = new Map<string, Resource>();
  private bytes = 0;
  private closed = false;
  private requests = new Map<
    string,
    { url: string; kind: string; type: string }
  >();
  private inFlight = 0;
  private disposers: Array<() => void> = [];

  constructor(
    private cdp: CDPSession,
    private notice: (message: string) => void = () => {},
    private resourceURL: (id: string) => string = (id) => `/_floe/assets/${id}`,
  ) {}

  async start(frameID: string): Promise<void> {
    const received = (event: any) => {
      if (
        this.closed ||
        event.frameId !== frameID ||
        !['Stylesheet', 'Image', 'Font'].includes(event.type) ||
        event.response.status < 200 ||
        event.response.status >= 300 ||
        this.requests.size >= 2048
      )
        return;
      this.reference(event.response.url, event.response.url);
      this.requests.set(event.requestId, {
        url: event.response.url,
        kind: event.type,
        type: event.response.mimeType.toLowerCase(),
      });
    };
    const finished = (event: any) => {
      const response = this.requests.get(event.requestId);
      this.requests.delete(event.requestId);
      if (
        !response ||
        this.closed ||
        event.encodedDataLength > MAX_RESOURCE_BYTES ||
        this.inFlight >= 64
      )
        return;
      this.inFlight++;
      void this.capture(event.requestId, response)
        .catch(() => {})
        .finally(() => {
          this.inFlight--;
        });
    };
    const failed = (event: any) => {
      this.requests.delete(event.requestId);
    };
    this.cdp.on('Network.responseReceived', received);
    this.cdp.on('Network.loadingFinished', finished);
    this.cdp.on('Network.loadingFailed', failed);
    this.disposers.push(
      () => this.cdp.off('Network.responseReceived', received),
      () => this.cdp.off('Network.loadingFinished', finished),
      () => this.cdp.off('Network.loadingFailed', failed),
    );
    await this.cdp.send('Network.enable', {
      maxTotalBufferSize: MAX_TOTAL_BYTES,
      maxResourceBufferSize: MAX_RESOURCE_BYTES,
    });
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
        waiters: new Set(),
      };
      this.byURL.set(url.href, resource);
      this.byID.set(resource.id, resource);
    }
    this.byURL.delete(resource.url);
    this.byURL.set(resource.url, resource);
    return `${this.resourceURL(resource.id)}${fragment}`;
  }

  value(css: string, base: string): string {
    const parsed = valueParser(css);
    parsed.walk((node) => {
      if (node.type === 'function' && node.value.toLowerCase() === 'url') {
        const raw = valueParser
          .stringify(node.nodes)
          .trim()
          .replace(/^(['"])([\s\S]*)\1$/, '$2');
        node.nodes = [
          {
            type: 'string',
            quote: '"',
            value: this.reference(raw, base),
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
    try {
      const root = postcss.parse(css, { map: { prev: false } });
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
          if (first?.type === 'string')
            first.value = this.reference(first.value, base);
          rule.params = parsed.toString();
        }
      });
      return root.toString();
    } catch {
      return '';
    }
  }

  private async capture(
    requestID: string,
    response: { url: string; kind: string; type: string },
  ): Promise<void> {
    const url = new URL(response.url);
    url.hash = '';
    const resource = this.byURL.get(url.href);
    if (!resource) return;
    // Chromium owns a bounded response buffer; a missing body is never refetched.
    const body = await this.cdp.send('Network.getResponseBody', {
      requestId: requestID,
    });
    const data = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8');
    if (this.closed) return;
    if (data.length > MAX_RESOURCE_BYTES) {
      this.notice('A page resource exceeds the projection memory limit.');
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
    for (const resolve of resource.waiters) resolve();
    resource.waiters.clear();
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

  close(): void {
    this.closed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.requests.clear();
    for (const resource of this.byURL.values())
      for (const resolve of resource.waiters) resolve();
    this.byURL.clear();
    this.byID.clear();
    this.bytes = 0;
  }
}
