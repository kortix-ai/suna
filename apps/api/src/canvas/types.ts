/**
 * CanvasMessage — shared type for canvas SSE events.
 *
 * Storage choice: canvas events are stored in their own `canvas_messages` table
 * (separate from the messages table) keyed by session_id. This avoids polluting
 * the messages table with non-LLM content and lets canvas consumers query
 * independently. The `type` discriminator on the SSE event is "canvas".
 */

// ─── Kind discriminators ─────────────────────────────────────────────────────

export interface CanvasTableMessage {
  type: 'canvas';
  kind: 'table';
  id: string;
  data: CanvasTableData;
}

export interface CanvasDocMessage {
  type: 'canvas';
  kind: 'doc';
  id: string;
  data: CanvasDocData;
}

export interface CanvasChartMessage {
  type: 'canvas';
  kind: 'chart';
  id: string;
  data: CanvasChartData;
}

export interface CanvasSecurityPatchMessage {
  type: 'canvas';
  kind: 'security_patch';
  id: string;
  data: CanvasSecurityPatchData;
}

/** Discriminated union — callers must narrow to `kind` before reading `data`. */
export type CanvasMessage =
  | CanvasTableMessage
  | CanvasDocMessage
  | CanvasChartMessage
  | CanvasSecurityPatchMessage;

// ─── Data payloads ───────────────────────────────────────────────────────────

export interface CanvasTableData {
  columns: string[];
  rows: unknown[][];
  title?: string;
}

export interface CanvasDocData {
  markdown: string;
  title?: string;
}

export interface CanvasChartData {
  chartType: 'bar' | 'line' | 'pie';
  labels: string[];
  datasets: Array<{ label: string; values: number[] }>;
  title?: string;
}

export interface CanvasSecurityPatchData {
  cve: string;
  package: string;
  severity: 'high' | 'critical';
  fixedIn: string;
  currentVersion: string;
  /** Updated by the patch endpoint after apply. */
  status?: 'open' | 'patched' | 'failed';
}
