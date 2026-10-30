/**
 * pi's image resize worker, an extra `bun build --compile` entrypoint (scripts/build.sh). In a
 * compiled binary pi starts it by this exact path (pi-coding-agent `resizeImage`), so the file must
 * stay at `src/utils/image-resize-worker.ts`. Without it pi resizes on the daemon's event loop
 * (about 0.9 s for a 6000x4000 PNG). A worker is its own module graph: it installs the photon wasm
 * redirect (`pi/images.ts`) itself, before pi's worker loads photon.
 */
import '@/harness/pi/images'
// ponytail: pi does not export its worker; the relative path is the module its `resizeImage` starts outside a binary.
import '../../node_modules/@earendil-works/pi-coding-agent/dist/utils/image-resize-worker.js'
