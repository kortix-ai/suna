import {
  parseArtifactAnnotationFrameMessage,
  parseArtifactAnnotationHostMessage,
  type ArtifactAnnotationFrameMessage,
  type ArtifactAnnotationHostMessage,
} from '@kortix/shared/artifact-annotations';

export function connectArtifactAnnotationFrame(
  frame: HTMLIFrameElement,
  slot: HTMLElement,
  callbacks: {
    onMessage: (message: ArtifactAnnotationFrameMessage) => void;
    onLoad: () => void;
  },
  host: Window = window,
) {
  let disposed = false;
  const ownsFrame = () => !disposed && slot.isConnected && slot.contains(frame);
  const post = (message: ArtifactAnnotationHostMessage) => {
    if (!ownsFrame()) return false;
    const parsed = parseArtifactAnnotationHostMessage(message);
    if (!parsed || !frame.contentWindow) return false;
    frame.contentWindow.postMessage(parsed, '*');
    return true;
  };
  const receive = (event: MessageEvent) => {
    if (!ownsFrame() || !frame.contentWindow || event.source !== frame.contentWindow) return;
    const message = parseArtifactAnnotationFrameMessage(event.data);
    if (message) callbacks.onMessage(message);
  };
  const load = () => {
    if (ownsFrame()) callbacks.onLoad();
  };
  let owned = ownsFrame();
  const Observer = (host as Window & typeof globalThis).MutationObserver;
  const observer = Observer
    ? new Observer((records) => {
        const next = ownsFrame();
        if (
          (!next && owned) ||
          (next && (!owned || records.some((record) => Array.from(record.addedNodes).includes(frame))))
        )
          callbacks.onLoad();
        owned = next;
      })
    : null;
  observer?.observe(slot, { childList: true });
  host.addEventListener('message', receive);
  frame.addEventListener('load', load);
  return {
    post,
    dispose() {
      post({ kortix: 'annotate', v: 1, type: 'mode', mode: 'off' });
      disposed = true;
      observer?.disconnect();
      host.removeEventListener('message', receive);
      frame.removeEventListener('load', load);
    },
  };
}
