/** The schema version this build renders. A fence names its version in its language tag. */
export const GENUI_SCHEMA_VERSION = 1 as const;

/** One validated, render-ready component instance. Child slots hold `GenuiNode[]`. */
export interface GenuiNode {
  /** Stable React key: the statement name, else the slot path. Unique within one block. */
  id: string;
  /** Component name from the catalog, e.g. `BarChart`. */
  type: string;
  props: Record<string, unknown>;
  /** The model has not finished writing this statement yet. */
  partial: boolean;
}

export type GenuiIssueCode =
  | 'schema'
  | 'unknown-component'
  | 'wrong-child'
  | 'url'
  | 'depth'
  | 'version'
  | 'no-root'
  /** The stream ended inside this statement (turn aborted or failed). */
  | 'cut-off'
  /** Query, Mutation, or $state: not supported before Phase 4; never executed. */
  | 'unsupported-statement'
  /** The block expands to more than `GENUI_MAX_NODES` nodes (reference fan-out); the rest is dropped. */
  | 'too-many-nodes';

export interface GenuiIssue {
  code: GenuiIssueCode;
  component?: string;
  statementId?: string;
  message: string;
}

export interface GenuiParseResult {
  /** Root `Stack`, or null when nothing renderable exists yet. */
  root: GenuiNode | null;
  /** Statement names referenced but not written yet. */
  pending: string[];
  /** Everything dropped or repaired, for telemetry and debugging. Never shown to users. */
  issues: GenuiIssue[];
  streaming: boolean;
}

export type GenuiSegment =
  | { kind: 'markdown'; text: string }
  | { kind: 'genui'; code: string; version: number; closed: boolean };
