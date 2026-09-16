/** One diagnostic finding. */
export interface ManifestIssue {
  /** Dot-path to the offending value, e.g. `triggers[1].cron`. */
  path: string;
  /** Human-readable message. */
  message: string;
  /** `error` blocks push/merge; `warning` is advisory. */
  severity: 'error' | 'warning';
  /** Optional 1-indexed line within the original TOML text. */
  line?: number;
  /** Optional 1-indexed column. */
  column?: number;
}
