// One-shot codemod for the fumadocs to Blume migration. Kept in the repo (not
// run in CI) so the conversion is reviewable and repeatable, and so the
// fence-safety rule below has a test that pins it.

const CALLOUT_TYPE_TO_DIRECTIVE = {
  warn: 'warning',
  warning: 'warning',
  info: 'info',
  error: 'danger',
};

// Sentinel a transform emits in place of a deleted line; collapseDropped()
// filters it out. Exported so Tasks 6 and 7 reference the constant rather
// than re-typing the literal, which would silently stop being filtered if
// the two ever drift apart.
export const DROP_MARKER = '__DROP_LINE__';

// Walk lines, tracking whether we are inside a fenced code block. Every
// transform in this module is a no-op while inside one: docs pages carry
// example source with real `import` lines, and rewriting those would corrupt
// the examples.
export function mapOutsideFences(source, mapLine) {
  const lines = source.split('\n');
  let inFence = false;
  const out = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    out.push(inFence ? line : mapLine(line));
  }
  return out.join('\n');
}

// A dropped import leaves the blank line that followed it. Remove both, then
// squeeze any run of three or more newlines the removals opened up.
export function collapseDropped(source) {
  return source
    .split('\n')
    .filter((line) => line !== DROP_MARKER)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '');
}

export function convertCallouts(source) {
  let openDepth = 0;
  const mapped = mapOutsideFences(source, (line) => {
    const drop =
      /^import\s*\{[^}]*\bCallout\b[^}]*\}\s*from\s*'fumadocs-ui\/components\/callout';\s*$/;
    if (drop.test(line)) return DROP_MARKER;

    const open = line.match(
      /^\s*<Callout(?:\s+type="([a-z]+)")?(?:\s+title="([^"]*)")?\s*>\s*$/,
    );
    if (open) {
      openDepth += 1;
      const kind = CALLOUT_TYPE_TO_DIRECTIVE[open[1] ?? ''] ?? 'note';
      return open[2] ? `:::${kind}[${open[2]}]` : `:::${kind}`;
    }
    if (/^\s*<\/Callout>\s*$/.test(line) && openDepth > 0) {
      openDepth -= 1;
      return ':::';
    }
    return line;
  });

  return collapseDropped(mapped);
}

// Cannot use mapOutsideFences: a bare <Step> needs to look ahead to the
// heading line that follows it, and that helper only sees one line at a
// time. Track the fence state directly instead.
export function convertSteps(source) {
  const lines = source.split('\n');
  let inFence = false;
  const out = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    if (
      /^import\s*\{[^}]*\bSteps?\b[^}]*\}\s*from\s*'fumadocs-ui\/components\/steps';\s*$/.test(line)
    ) {
      out.push(DROP_MARKER);
      continue;
    }

    // A bare <Step> takes its title from the first heading that follows,
    // skipping the blank line fumadocs authors put between them.
    if (/^\s*<Step>\s*$/.test(line)) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j += 1;
      const heading = lines[j]?.match(/^###\s+(.*)$/);
      if (heading) {
        out.push(`<Step title="${heading[1].trim()}">`);
        let k = j + 1;
        while (k < lines.length && lines[k].trim() === '') k += 1;
        i = k - 1; // consume the heading and the blank lines around it
        continue;
      }
      out.push(line);
      continue;
    }
    out.push(line);
  }

  return collapseDropped(out.join('\n'));
}

// Phosphor (app) to Lucide (Blume built-in). Blume ships @iconify-json/lucide,
// so icons are name strings, never React elements. Every one of the 25 icons
// the docs use is listed; an unmapped icon must fail loudly rather than
// silently render no icon.
export const PHOSPHOR_TO_LUCIDE = {
  AlarmIcon: 'alarm-clock',
  AtomIcon: 'atom',
  BookOpenIcon: 'book-open',
  BrainIcon: 'brain',
  BrowserIcon: 'app-window',
  ChatsIcon: 'messages-square',
  ClipboardTextIcon: 'clipboard-list',
  CloudIcon: 'cloud',
  CodeIcon: 'code',
  CpuIcon: 'cpu',
  CubeIcon: 'box',
  DesktopIcon: 'monitor',
  FileTextIcon: 'file-text',
  FlagIcon: 'flag',
  GitBranchIcon: 'git-branch',
  GitPullRequestIcon: 'git-pull-request',
  KeyIcon: 'key',
  PathIcon: 'route',
  PlugsConnectedIcon: 'cable',
  RobotIcon: 'bot',
  RocketIcon: 'rocket',
  ScrollIcon: 'scroll',
  ShareNetworkIcon: 'share-2',
  TerminalIcon: 'terminal',
  UsersIcon: 'users',
};

const CARD_IMPORT_CLOSE =
  /^\}\s*from\s*'@\/(?:lib\/icons\/ssr|components\/markdown\/docs-card)';\s*$/;

// Cannot use mapOutsideFences: the docs-card / icons-ssr import can span
// multiple lines (`import {\n  ...\n} from '...';`), and that helper only
// sees one line at a time. Track the fence state directly, the way
// convertSteps does, so a `<Cards>` example, a `<Card icon={<X />}>`, or the
// import itself inside a fenced code block is left byte-for-byte alone.
export function convertCards(source) {
  const lines = source.split('\n');
  let inFence = false;
  const out = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    // Single-line `import { ... } from '@/lib/icons/ssr'` or docs-card.
    if (
      /^import\s*\{[^}]*\}\s*from\s*'@\/(?:lib\/icons\/ssr|components\/markdown\/docs-card)';\s*$/.test(
        line,
      )
    ) {
      out.push(DROP_MARKER);
      continue;
    }

    // Multi-line form: `import {` opens, look ahead for the matching
    // `} from '@/...';` close and drop every line in between. A `{` that
    // opens some other import is left alone — the lookahead only consumes
    // lines when the close line matches one of the two target modules.
    if (/^import\s*\{\s*$/.test(line)) {
      let j = i + 1;
      while (j < lines.length && !CARD_IMPORT_CLOSE.test(lines[j])) j += 1;
      if (j < lines.length) {
        for (let k = i; k <= j; k += 1) out.push(DROP_MARKER);
        i = j;
        continue;
      }
      out.push(line);
      continue;
    }

    out.push(
      line
        .replace(/<Cards>/g, '<CardGroup>')
        .replace(/<\/Cards>/g, '</CardGroup>')
        .replace(/icon=\{<([A-Za-z]+)\s*\/>\}/g, (_match, name) => {
          const lucide = PHOSPHOR_TO_LUCIDE[name];
          if (!lucide) throw new Error(`Unmapped icon: ${name}. Add it to PHOSPHOR_TO_LUCIDE.`);
          return `icon="${lucide}"`;
        }),
    );
  }

  return collapseDropped(out.join('\n'));
}
