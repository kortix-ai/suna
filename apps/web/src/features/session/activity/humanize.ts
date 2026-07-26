/**
 * Human labels for agent activity.
 *
 * The transcript used to print a tool call's raw arguments — `$ cd /workspace
 * && SCRIPT=/workspace/.kortix/opencode/skills/presentations/…` — twelve times
 * in a row. That is a log, not a chat. Everything here turns one tool call into
 * the short phrase a non-technical reader would use for it, so the default
 * transcript reads as work rather than as a terminal.
 *
 * The raw command is never lost: it is what the expanded row still shows.
 */

/** Strip the noise a model puts in front of the verb it actually ran:
 *  `cd /workspace &&`, `VAR=x`, `sudo`, a leading `(`. */
function stripCommandPrefixes(command: string): string {
  let rest = command.trim();
  // Take the first segment of a chain — the rest is usually plumbing.
  const chainSplit = rest.split(/\s*(?:&&|\|\||;|\|)\s*/);
  for (const segment of chainSplit) {
    const candidate = segment.trim();
    if (!candidate) continue;
    // `cd somewhere` on its own is never the interesting half of a chain.
    if (/^cd\s/.test(candidate) && chainSplit.length > 1) continue;
    // `FOO=bar` env prefixes, `sudo`, `exec`, a stray open paren.
    const cleaned = candidate
      .replace(/^\(\s*/, '')
      .replace(/^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '')
      .replace(/^(?:sudo|exec|time|nohup)\s+/, '')
      .trim();
    if (!cleaned) continue;
    // A bare `SCRIPT=/path/to/thing` link in a chain is setup, not the verb —
    // the interesting segment is the one that USES it.
    if (chainSplit.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(cleaned)) continue;
    return cleaned;
  }
  return rest;
}

interface ShellRule {
  test: RegExp;
  label: string;
}

/** Ordered — first match wins, so put the specific patterns above the general
 *  ones (`bun test` before `bun`, `npm run` before `npm`). */
const SHELL_RULES: ShellRule[] = [
  // Dependencies
  { test: /^(?:npm|pnpm|yarn|bun)\s+(?:install|add|i)\b/, label: 'Installed dependencies' },
  { test: /^pip3?\s+install\b/, label: 'Installed dependencies' },
  { test: /^(?:brew|apt-get|apt|yum)\s+install\b/, label: 'Installed dependencies' },

  // Tests
  { test: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/, label: 'Ran tests' },
  { test: /^(?:pytest|jest|vitest|playwright)\b/, label: 'Ran tests' },

  // Build / scripts
  { test: /^(?:npm|pnpm|yarn|bun)\s+run\b/, label: 'Ran a build step' },
  { test: /^(?:python3?|node|bun|deno|tsx|ts-node|ruby|php)\s/, label: 'Ran a script' },
  { test: /^(?:bash|sh|zsh)\s/, label: 'Ran a script' },
  { test: /^\.?\/\S+\.(?:sh|py|js|ts)\b/, label: 'Ran a script' },

  // Reading / looking around
  { test: /^(?:ls|tree|du|df|stat|pwd)\b/, label: 'Looked at files' },
  { test: /^find\b/, label: 'Looked for files' },
  { test: /^(?:cat|head|tail|less|more|bat)\b/, label: 'Read a file' },
  { test: /^(?:grep|rg|ag|ack)\b/, label: 'Searched the files' },
  { test: /^(?:which|command\s+-v|type|whereis)\b/, label: 'Checked the setup' },

  // Writing / moving
  { test: /^mkdir\b/, label: 'Created a folder' },
  { test: /^(?:touch)\b/, label: 'Created a file' },
  { test: /^(?:rm|rmdir|unlink)\b/, label: 'Deleted files' },
  { test: /^mv\b/, label: 'Moved files' },
  { test: /^(?:cp|rsync)\b/, label: 'Copied files' },
  { test: /^(?:chmod|chown)\b/, label: 'Changed file permissions' },
  { test: /^(?:zip|unzip|tar|gzip|gunzip)\b/, label: 'Packed up files' },
  { test: /^echo\b/, label: 'Wrote some text' },

  // Network
  { test: /^(?:curl|wget|http)\b/, label: 'Fetched from the web' },

  // Media / conversion
  {
    test: /^(?:pdftoppm|pdftotext|convert|magick|ffmpeg|libreoffice|soffice|qpdf)\b/,
    label: 'Converted a file',
  },

  // Version control
  { test: /^git\s+(?:commit|add|push|pull|checkout|branch|merge|status|diff|log|clone)\b/, label: '' },
];

/** `git <sub>` reads better as "Git commit" than as a generic bucket. */
function gitLabel(command: string): string | null {
  const match = /^git\s+([a-z-]+)/.exec(command);
  if (!match) return null;
  const sub = match[1];
  const known: Record<string, string> = {
    commit: 'Saved the changes',
    add: 'Staged the changes',
    push: 'Pushed the changes',
    pull: 'Pulled the latest changes',
    clone: 'Downloaded a repository',
    checkout: 'Switched branches',
    branch: 'Worked with branches',
    merge: 'Merged branches',
    status: 'Checked what changed',
    diff: 'Checked what changed',
    log: 'Checked the history',
  };
  return known[sub] ?? 'Used Git';
}

/**
 * A shell command as a short human phrase. Never returns an empty string —
 * "Ran a command" is the floor.
 */
export function humanizeShellCommand(command: string | undefined): string {
  const raw = (command ?? '').trim();
  if (!raw) return 'Ran a command';
  const stripped = stripCommandPrefixes(raw);

  const git = gitLabel(stripped);
  if (git) return git;

  for (const rule of SHELL_RULES) {
    if (rule.label && rule.test.test(stripped)) return rule.label;
  }
  return 'Ran a command';
}

/**
 * The label for one shell step. The model's own `description` argument wins
 * when it wrote one — it knows why it ran the command, and no pattern match
 * can recover that intent. Falls back to the command shape.
 */
export function humanizeShellStep({
  description,
  command,
}: {
  description?: string;
  command?: string;
}): string {
  const desc = (description ?? '').trim();
  // Descriptions arrive as fragments ("Build slide 1") — good as-is. Reject
  // the ones that are just the command echoed back, which read as noise.
  if (desc && desc.length <= 80 && desc !== (command ?? '').trim()) return desc;
  return humanizeShellCommand(command);
}

// ============================================================================
// Group labels
// ============================================================================

export interface ActivityCounts {
  shell: number;
  read: number;
  write: number;
  edit: number;
  search: number;
  web: number;
  other: number;
}

export function emptyActivityCounts(): ActivityCounts {
  return { shell: 0, read: 0, write: 0, edit: 0, search: 0, web: 0, other: 0 };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The one-line summary for a folded run of work.
 *
 * Single-kind runs keep their specific verb ("Ran 12 commands") because that
 * verb is the information. Mixed runs get a count instead of a
 * lowest-common-denominator verb — "Did 14 things" tells a reader nothing that
 * "14 steps" doesn't, and reads worse.
 */
export function activityGroupLabel(counts: ActivityCounts, running: boolean): string {
  const kinds = (Object.keys(counts) as Array<keyof ActivityCounts>).filter((k) => counts[k] > 0);
  const total = kinds.reduce((sum, k) => sum + counts[k], 0);
  if (total === 0) return running ? 'Working…' : 'No activity';

  if (kinds.length === 1) {
    const kind = kinds[0];
    const n = counts[kind];
    switch (kind) {
      case 'shell':
        return running ? `Running ${plural(n, 'command', 'commands')}` : `Ran ${plural(n, 'command', 'commands')}`;
      case 'read':
        return running ? `Reading ${plural(n, 'file', 'files')}` : `Read ${plural(n, 'file', 'files')}`;
      case 'write':
        return running ? `Writing ${plural(n, 'file', 'files')}` : `Wrote ${plural(n, 'file', 'files')}`;
      case 'edit':
        return running ? `Editing ${plural(n, 'file', 'files')}` : `Edited ${plural(n, 'file', 'files')}`;
      case 'search':
        return running ? 'Searching the files' : `Searched the files ${plural(n, 'time', 'times')}`;
      case 'web':
        return running ? 'Searching the web' : `Searched the web ${plural(n, 'time', 'times')}`;
      default:
        return running ? 'Working…' : `${plural(total, 'step', 'steps')}`;
    }
  }

  return running ? 'Working…' : plural(total, 'step', 'steps');
}
