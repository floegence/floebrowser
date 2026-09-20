import { EventType, IncrementalSource, type eventWithTime } from '@rrweb/types';
import type { ResourceStore } from './resources.js';

type Serialized = Record<string, any>;
const blocked = new Set(['canvas', 'object', 'embed']);
const inert = new Set(['script', 'base', 'meta', 'source', 'track']);
const dropped =
  /^(?:on.*|srcdoc|nonce|integrity|crossorigin|ping|action|formaction|target|download|autofocus|srcset|sizes)$/i;

/** Projects untrusted rrweb data into an inert, source-resource-only document. */
export class DOMProjection {
  private tags = new Map<number, string>();
  private excluded = new Set<number>();
  private bases = new Map<number, string>();
  private children = new Map<number, Set<number>>();
  constructor(
    private resources: Pick<ResourceStore, 'reference' | 'css' | 'value'>,
  ) {}

  isMedia(id: number): boolean {
    return ['video', 'audio'].includes(this.tags.get(id) ?? '');
  }

  private attributes(
    attributes: Serialized,
    tag: string,
    base: string,
  ): Serialized {
    const result: Serialized = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (
        ['video', 'audio'].includes(tag) &&
        (['src', 'autoplay', 'controls', 'preload'].includes(
          key.toLowerCase(),
        ) ||
          key.startsWith('rr_media'))
      ) {
        // The trusted viewer alone attaches the received MediaStream, never a site URL.
        if (!key.startsWith('rr_')) result[key] = null;
        continue;
      }
      if (
        (tag === 'iframe' || tag === 'frame') &&
        ['src', 'rr_src', 'sandbox', 'allow', 'allowfullscreen'].includes(
          key.toLowerCase(),
        )
      ) {
        result[key] = null;
        continue;
      }
      if (dropped.test(key)) {
        result[key] = null;
        continue;
      }
      if (key === 'href' && !['link', 'use', 'image'].includes(tag)) {
        result[key] = null;
        continue;
      }
      if (value === null) {
        result[key] = null;
        continue;
      }
      if (key === 'contenteditable') {
        result[key] = null;
        result['data-floebrowser-editable'] = value;
        continue;
      }
      if (key === '_cssText')
        result[key] = this.resources.css(String(value), base);
      else if (key === 'style' && typeof value === 'string')
        result[key] = this.resources.value(value, base);
      else if (key === 'style' && typeof value === 'object') {
        result[key] = Object.fromEntries(
          Object.entries(value).map(([property, val]) => [
            property,
            Array.isArray(val)
              ? [this.resources.value(String(val[0]), base), val[1]]
              : typeof val === 'string'
                ? this.resources.value(val, base)
                : val,
          ]),
        );
      } else if (
        ['src', 'href', 'xlink:href', 'poster', 'background'].includes(key)
      )
        result[key] = this.resources.reference(String(value), base);
      else result[key] = value;
    }
    if (['video', 'audio'].includes(tag)) {
      result['data-floebrowser-media'] = tag;
      result.preload = 'none';
    }
    if (tag === 'iframe' || tag === 'frame')
      result.sandbox = 'allow-same-origin';
    return result;
  }

  private exclude(node: Serialized): void {
    this.excluded.add(node.id);
    for (const child of node.childNodes ?? []) this.exclude(child);
  }

  private node(
    node: Serialized,
    base: string,
    parentTag = '',
    parentID?: number,
  ): void {
    if (parentID !== undefined) {
      const children = this.children.get(parentID) ?? new Set<number>();
      children.add(node.id);
      this.children.set(parentID, children);
    }
    base = node.floeBase ?? this.bases.get(node.rootId) ?? base;
    this.bases.set(node.id, base);
    delete node.floeBase;
    if (node.type === 2) {
      const original = String(node.tagName).toLowerCase();
      this.tags.set(node.id, original);
      if (
        blocked.has(original) ||
        (original === 'input' && node.attributes?.type === 'file')
      ) {
        const label =
          original === 'input'
            ? 'File upload'
            : original === 'iframe' || original === 'frame'
              ? 'Embedded frame'
              : original[0]!.toUpperCase() + original.slice(1);
        const width = /^[\d.]+px$/.test(node.attributes?.rr_width)
          ? node.attributes.rr_width
          : '100%';
        const height = /^[\d.]+px$/.test(node.attributes?.rr_height)
          ? node.attributes.rr_height
          : '96px';
        this.excluded.add(node.id);
        node.tagName = 'div';
        node.attributes = {
          'data-floebrowser-unsupported': `${label} is not supported in DOM mode`,
          style: `width:${width};height:${height};min-height:32px;box-sizing:border-box`,
        };
        node.childNodes = [];
        node.isSVG = false;
        return;
      }
      if (
        inert.has(original) ||
        (original === 'link' &&
          node.attributes?.rel !== 'stylesheet' &&
          !node.attributes?._cssText)
      ) {
        node.tagName = 'noscript';
        node.attributes = {};
        node.childNodes = [];
        return;
      }
      node.attributes = this.attributes(node.attributes ?? {}, original, base);
      parentTag = original;
    } else if (node.type === 3 && (parentTag === 'style' || node.isStyle)) {
      this.tags.set(node.id, 'style');
      node.textContent = this.resources.css(node.textContent, base);
    }
    for (const child of node.childNodes ?? [])
      this.node(child, base, parentTag, node.id);
  }

  private forget(id: number): void {
    for (const child of this.children.get(id) ?? []) this.forget(child);
    this.children.delete(id);
    this.tags.delete(id);
    this.bases.delete(id);
    this.excluded.delete(id);
  }

  event(input: eventWithTime, base: string): eventWithTime | undefined {
    const event = structuredClone(input) as Serialized;
    if (event.type === EventType.FullSnapshot) {
      this.tags.clear();
      this.excluded.clear();
      this.bases.clear();
      this.children.clear();
      this.node(event.data.node, base);
    } else if (event.type === EventType.IncrementalSnapshot) {
      const data = event.data;
      if (data.source === IncrementalSource.Mutation) {
        if (data.isAttachIframe) {
          data.adds = data.adds.filter((addition: Serialized) => {
            if (
              ['iframe', 'frame'].includes(
                this.tags.get(addition.parentId) ?? '',
              ) &&
              !this.excluded.has(addition.parentId)
            )
              return true;
            this.exclude(addition.node);
            return false;
          });
          if (!data.adds.length) return;
          // A frame document replaces its predecessor. Retaining the old
          // subtree would keep stale media and node identities authorized.
          for (const addition of data.adds) {
            for (const id of this.children.get(addition.parentId) ?? [])
              this.forget(id);
            this.children.delete(addition.parentId);
          }
        }
        data.adds = data.adds.filter((addition: Serialized) => {
          if (
            this.excluded.has(addition.parentId) ||
            this.excluded.has(addition.node.rootId)
          ) {
            this.exclude(addition.node);
            return false;
          }
          return true;
        });
        data.texts = data.texts.filter(
          (entry: Serialized) => !this.excluded.has(entry.id),
        );
        data.removes = data.removes.filter(
          (entry: Serialized) => !this.excluded.has(entry.parentId),
        );
        for (const removal of data.removes) {
          this.children.get(removal.parentId)?.delete(removal.id);
          this.forget(removal.id);
        }
        for (const addition of data.adds)
          this.node(
            addition.node,
            this.bases.get(addition.parentId) ?? base,
            this.tags.get(addition.parentId),
            addition.parentId,
          );
        data.attributes = data.attributes.filter(
          (entry: Serialized) =>
            !this.excluded.has(entry.id) &&
            !blocked.has(this.tags.get(entry.id) ?? '') &&
            !inert.has(this.tags.get(entry.id) ?? ''),
        );
        for (const entry of data.attributes)
          entry.attributes = this.attributes(
            entry.attributes,
            this.tags.get(entry.id) ?? '',
            this.bases.get(entry.id) ?? base,
          );
        for (const text of data.texts)
          if (this.tags.get(text.id) === 'style')
            text.value = this.resources.css(
              text.value,
              this.bases.get(text.id) ?? base,
            );
      } else if (
        data.source === IncrementalSource.StyleSheetRule ||
        data.source === IncrementalSource.AdoptedStyleSheet
      ) {
        base = this.bases.get(data.id) ?? base;
        for (const addition of data.adds ?? [])
          addition.rule = this.resources.css(addition.rule, base);
        for (const sheet of data.styles ?? [])
          for (const rule of sheet.rules ?? [])
            rule.rule = this.resources.css(rule.rule, base);
      } else if (data.source === IncrementalSource.StyleDeclaration) {
        if (data.set)
          data.set.value = this.resources.value(data.set.value, base);
      } else if (data.source === IncrementalSource.Font && !data.buffer)
        data.fontSource = this.resources.value(data.fontSource, base);
      else if (
        [
          IncrementalSource.CanvasMutation,
          IncrementalSource.MediaInteraction,
        ].includes(data.source)
      )
        return;
    } else if (
      ![EventType.Meta, EventType.DomContentLoaded, EventType.Load].includes(
        event.type,
      )
    )
      return;
    return event as eventWithTime;
  }
}
