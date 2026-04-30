/**
 * CanvasMessage — shared type for canvas SSE events.
 *
 * Storage: canvas events are stored in an in-memory store keyed by session_id.
 * The SSE discriminator is `type: "canvas"`.
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

export interface CanvasPrSummaryMessage {
  type: 'canvas';
  kind: 'pr_summary';
  id: string;
  data: CanvasPrSummaryData;
}

export interface CanvasFileArtifactMessage {
  type: 'canvas';
  kind: 'file_artifact';
  id: string;
  data: CanvasFileArtifactData;
}

/** Discriminated union — callers must narrow to `kind` before reading `data`. */
export type CanvasMessage =
  | CanvasTableMessage
  | CanvasDocMessage
  | CanvasChartMessage
  | CanvasSecurityPatchMessage
  | CanvasPrSummaryMessage
  | CanvasFileArtifactMessage;

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
  status?: 'open' | 'patched' | 'failed';
}

export interface CanvasPrSummaryData {
  pr_url: string;
  pr_number: number;
  branch: string;
  diff_additions: number;
  diff_deletions: number;
  ci_status: 'pending' | 'pass' | 'fail' | null;
}

// Supported MIME types for file artifacts
export type FileArtifactMimeType =
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  | 'text/csv'
  | 'image/png'
  | 'image/jpeg';

export const FILE_ARTIFACT_ALLOWED_MIMES: ReadonlySet<string> = new Set<FileArtifactMimeType>([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'image/png',
  'image/jpeg',
]);

export interface CanvasFileArtifactData {
  /** Basename of the file, e.g. "report.pdf" */
  filename: string;
  /** Absolute path in sandbox, e.g. "/workspace/report.pdf" */
  sandbox_path: string;
  /** Sandbox ID — frontend uses this to route the download via the sandbox proxy */
  sandbox_id: string;
  mime_type: FileArtifactMimeType;
  size_bytes: number;
  description?: string;
}
