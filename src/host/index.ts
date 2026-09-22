export { launchSourceBrowser } from './browser.js';
export {
  BrowserProjection,
  type AttachOptions,
  type Controller,
  type Observation,
  type ObservationOptions,
} from './engine.js';
export {
  createProjectionServer,
  type ProjectionServerOptions,
} from './server.js';
export {
  BrowserSession,
  type SessionConnection,
  type SessionViewOptions,
} from './session.js';
export {
  PROTOCOL_VERSION,
  type Action,
  type BrowserState,
  type DialogState,
  type FileChooserState,
  type UploadFile,
  type DownloadState,
  type DownloadFile,
  type ClientMessage,
  type ServerMessage,
  type ProjectionConnection,
  type DisconnectReason,
  type TabState,
} from '../shared/protocol.js';

export {
  NativeMediaBridge,
  type SourceMediaBridge,
  type MediaScope,
  type MediaSubscription,
} from './media-bridge.js';
export { MediaSender, type MediaSenderLimits } from './media-carrier.js';

export {
  CDPSourcePage,
  type CDPSourceOptions,
  type SourceContext,
} from './cdp-source.js';
export {
  PlaywrightSourceBrowser,
  type PlaywrightSourceOptions,
} from './playwright-source.js';
export type {
  SourcePage,
  SourceDialog,
  SourceFileChooser,
  SourceDownload,
  SourceDownloadState,
  SourceFrame,
  SourceElement,
  SourceTransport,
  SourceViewport,
} from './source.js';
export { type UploadLimits } from './uploads.js';

export {
  StandaloneSourceDirectory,
  type SourceDirectory,
  type SourceTab,
  type DirectoryChange,
} from './directory.js';

export { ResponseDownloads } from './response-downloads.js';

export { closeCDPPage } from './close-page.js';
