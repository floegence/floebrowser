/** References are inert on the wire. Only the trusted viewer resolves the
 * host-issued same-origin URL; a scriptless replay never performs HTTP. */
export function resourceReference(url: string): string {
  return `floebrowser-resource:${encodeURIComponent(url).replace(/[!'()*~]/gu, (character) => `%${character.charCodeAt(0).toString(16)}`)}~`;
}

export const resourceReferences = () =>
  /floebrowser-resource:([A-Za-z0-9%._-]+)~/gu;

/** A captured source response, scoped by the host's opaque resource URL. */
export type ResourceAvailable = {
  reference: string;
  type: string;
  revision: number;
};
