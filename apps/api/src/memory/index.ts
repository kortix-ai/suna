/**
 * Memory pages (`project_channels`): the one module that owns every memory
 * rule. Routes (`projects/routes/project-memory.ts`) and the turn hook
 * (`sandbox-proxy/forward/turn-start.ts`) import from here only.
 */
import type { MemoryLayer } from '@kortix/api-contract';
import { layerCounts, type LayerRef, type Viewer, viewerWrites } from './layers';
import { layerOf } from './serialize';
// Loading the import module registers the `memory-import` job handler (shared/job-queue.ts).
import './import';

export { exportLayer } from './export';
export { resolveLayerKey, type LayerRef, type Viewer } from './layers';
export { MemoryError } from './limits';
export { addNote } from './notes';
export { createPage, deletePage, getPage, listPages, restorePage, updatePage } from './pages';
export { remember } from './remember';
export { isMemoryTurnRoute, memoryTurnLayers, withMemoryLayers } from './turn-context';
export { layerChanges, pageHistory, undoVersion } from './versions';

/** A layer with its counts, as the viewer sees it. */
export async function layerView(ref: LayerRef, viewer: Viewer): Promise<MemoryLayer> {
  return layerOf(ref, await layerCounts(ref.layerId), viewerWrites(ref, viewer));
}
