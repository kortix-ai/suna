/**
 * @kortix/ui/apps — Live App frames, the frame pool and the App view model.
 */
export {
  AppPreview,
  AppPreviewOverlay,
  PREVIEW_SPINNER_DELAY_MS,
  PREVIEW_TILE_ASPECT,
  PREVIEW_VIEWPORT_HEIGHT,
  PREVIEW_VIEWPORT_WIDTH,
  framePlacement,
  previewScale,
  scheduleSlowPreview,
} from './app-preview';
export {
  ensureFrame,
  frameKey,
  framesKeepAlive,
  pruneFrames,
  reloadFrame,
} from './app-preview-pool';
export {
  ANONYMOUS_MODES,
  DEPLOYMENT_COPY,
  appCan,
  appCommand,
  appHost,
  appStatus,
  appTabLabel,
  cardPreviewApp,
  childApps,
  deployNotice,
  gridApps,
  localizedAppCopy,
} from './app-shared';
export { isKortixAppUrl } from './kortix-app-url';
