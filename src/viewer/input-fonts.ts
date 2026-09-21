import valueParser from 'postcss-value-parser';
import {
  EventType,
  IncrementalSource,
  type eventWithTime,
  type fontData,
} from '@rrweb/types';

type Font = {
  family: string;
  source: string | Uint8Array<ArrayBuffer>;
  descriptors: FontFaceDescriptors;
};
const families = (value: string): string[] => {
  const groups = [''];
  for (const node of valueParser(value).nodes) {
    if (node.type === 'div' && node.value === ',') groups.push('');
    else
      groups[groups.length - 1] +=
        node.type === 'string' ? node.value : valueParser.stringify(node);
  }
  return groups.map((name) => name.trim().toLowerCase());
};

/** Give the trusted caret its source fonts under private names. Registering the
 * website's original family in the host would also change browser chrome. */
export class InputFonts {
  private faces: FontFace[] = [];
  private activeDocument?: Document;
  private owner?: Document;
  private key = '';
  private family = '';
  private generation = 0;
  private recorded = new WeakMap<Document, Map<string, Font>>();

  event(event: eventWithTime, doc?: Document | null): void {
    if (!doc || event.type !== EventType.IncrementalSnapshot) return;
    if (event.data.source === IncrementalSource.Font) {
      const data = event.data as fontData;
      const font: Font = {
        family: families(data.family)[0]!,
        source: data.buffer
          ? new Uint8Array(JSON.parse(data.fontSource))
          : data.fontSource,
        descriptors: data.descriptors ?? {},
      };
      let fonts = this.recorded.get(doc);
      if (!fonts) this.recorded.set(doc, (fonts = new Map()));
      fonts.set(JSON.stringify([font.family, font.descriptors]), font);
      this.generation++;
    } else if (
      [
        IncrementalSource.StyleSheetRule,
        IncrementalSource.StyleDeclaration,
        IncrementalSource.AdoptedStyleSheet,
      ].includes(event.data.source) ||
      (event.data.source === IncrementalSource.Mutation &&
        event.data.attributes.some((entry) => '_cssText' in entry.attributes))
    ) {
      this.generation++;
    }
  }

  apply(control: HTMLElement, source: Element): void {
    const requested = control.style.fontFamily;
    const key = `${this.generation}:${requested}`;
    const doc = source.ownerDocument;
    if (this.key !== key || this.activeDocument !== doc) {
      this.clear();
      this.key = key;
      this.activeDocument = doc;
      this.owner = control.ownerDocument;
      const wanted = families(requested);
      const descriptions: Font[] = [
        ...(this.recorded.get(doc)?.values() ?? []),
      ];
      const visit = (rules: CSSRuleList) => {
        for (const rule of rules) {
          if (rule.type === 5) {
            const style = (rule as CSSFontFaceRule).style;
            descriptions.push({
              family: families(style.getPropertyValue('font-family'))[0]!,
              source: style.getPropertyValue('src'),
              descriptors: {
                style: style.getPropertyValue('font-style') || 'normal',
                weight: style.getPropertyValue('font-weight') || 'normal',
                stretch: style.getPropertyValue('font-stretch') || 'normal',
                unicodeRange:
                  style.getPropertyValue('unicode-range') || 'U+0-10FFFF',
                featureSettings:
                  style.getPropertyValue('font-feature-settings') || 'normal',
              },
            });
          } else if ('cssRules' in rule)
            visit((rule as CSSGroupingRule).cssRules);
          else if (rule.type === 3 && (rule as CSSImportRule).styleSheet)
            visit((rule as CSSImportRule).styleSheet!.cssRules);
        }
      };
      for (const sheet of doc.styleSheets) {
        try {
          visit(sheet.cssRules);
        } catch {
          /* A still-loading resource has no usable rules yet. */
        }
      }
      const aliases = new Map<string, string>();
      for (const font of descriptions) {
        if (!wanted.includes(font.family)) continue;
        let alias = aliases.get(font.family);
        if (!alias)
          aliases.set(
            font.family,
            (alias = `floe-input-${crypto.randomUUID()}`),
          );
        try {
          const face = new FontFace(alias, font.source, font.descriptors);
          this.faces.push(face);
          this.owner.fonts.add(face);
          void face.load().catch(() => {});
        } catch {
          /* Match the replay's handling of an invalid font face. */
        }
      }
      this.family = [
        ...wanted.flatMap((name) =>
          aliases.has(name) ? [aliases.get(name)!] : [],
        ),
        requested,
      ].join(',');
    }
    control.style.fontFamily = this.family;
  }

  clear(): void {
    for (const face of this.faces) this.owner?.fonts.delete(face);
    this.faces = [];
    this.key = '';
    this.activeDocument = undefined;
    this.owner = undefined;
  }
}
