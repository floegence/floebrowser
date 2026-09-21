/** A debugger connection borrowed from the host's single target owner. The host
 * owns attachment, auto-attachment and domain policy shared with other tools. */
export interface SourceTransport {
  send(method: string, parameters?: any): Promise<any>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}
export type SourceViewport = { width: number; height: number };
export type SourceFunction<A, R> = (argument: A) => R | Promise<R>;
export interface SourceDialog {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  url: string;
  message: string;
  defaultPrompt?: string;
  /** One response only; failure is an unknown outcome, never a retry grant. */
  respond(accept: boolean, promptText?: string): Promise<void>;
}
export interface SourceElement {
  evaluate<A, R>(
    fn: (node: Element, argument: A) => R | Promise<R>,
    argument: A,
    options?: { userGesture?: boolean },
  ): Promise<R>;
  ownerFrame(): Promise<SourceFrame | null>;
  dispose(): Promise<void>;
}
export interface SourceFrame {
  readonly id: string;
  readonly transport: SourceTransport;
  readonly contextID: number;
  url(): string;
  isDetached(): boolean;
  parentFrame(): SourceFrame | null;
  frameElement(): Promise<SourceElement>;
  evaluate<A, R>(fn: string | SourceFunction<A, R>, argument?: A): Promise<R>;
  resolve(
    key: string,
    id: number,
  ): Promise<{ element?: SourceElement; frame?: SourceFrame; id?: number }>;
}
export interface SourcePage {
  /** Stable host-owned identity, preserved when a projection is recreated. */
  readonly id: string;
  readonly transport: SourceTransport;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  frames(): SourceFrame[];
  mainFrame(): SourceFrame;
  sessions(): SourceTransport[];
  url(): string;
  title(): Promise<string>;
  viewportSize(): SourceViewport | null;
  setViewportSize(size: SourceViewport): Promise<void>;
  navigate(url: string): Promise<void>;
  traverse(direction: -1 | 1): Promise<void>;
  reload(): Promise<void>;
  /** Cancel pending navigation/loading; must not wait behind that navigation. */
  stop(): Promise<void>;
  bringToFront(): Promise<void>;
  isClosed(): boolean;
  /** Explicit host policy, not disposal of a projection. */
  close(): Promise<void>;
  createPage(): Promise<SourcePage>;
}
