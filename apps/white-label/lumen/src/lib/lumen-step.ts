// A `lumen …` tool command (the agent kit's CLI, run through bash) as a plain step a lawyer can read.
// `lumenStep` returns null for anything else; the chat row then shows SHELL_STEP, never the command.

/** The step a lawyer sees for a shell call that is not a `lumen` command: no command text, no paths. */
export const SHELL_STEP = 'Preparing the working files';

/**
 * The command of a shell call's input. The input is an object (`{command}`, Codex's
 * `{cmd}` or an argv array) or, while it streams or from some transcripts, its JSON text.
 */
export function shellCommand(input: unknown): string | null {
  let v = input;
  if (typeof input === 'string') {
    try {
      v = JSON.parse(input);
    } catch {
      // Partial JSON while the call streams: read the command field if it is complete.
      const m = /"(?:command|cmd)"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(input);
      if (!m) return null;
      try {
        return JSON.parse(`"${m[1]}"`) as string;
      } catch {
        return null;
      }
    }
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as { command?: unknown; cmd?: unknown };
  const c = o.command ?? o.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((x) => typeof x === 'string')) return c.join(' ');
  return null;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Split one shell command into words, honouring single and double quotes. */
function words(cmd: string): string[] {
  return [...cmd.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
}

export function lumenStep(command: string): string | null {
  // The agent often names the tool once: `L="python3 …/lumen-kit/bin/lumen"; $L read …`.
  const alias = command.match(/(\w+)=["']?[^"';]*\blumen(?:-kit\/bin\/lumen)?["']?\s*;/)?.[1];
  if (alias) command = command.replace(new RegExp(`\\$\\{?${alias}\\}?(?=\\s|$)`, 'g'), 'lumen').replace(/^[^;]*;/, '');
  // The first `lumen` invocation in the command (it may follow `cd …&&` or sit in a pipeline).
  const part = command.split(/&&|\|\||;|\|/).find((p) => /(^|[\s/])lumen(\s|$)/.test(p));
  if (!part) return null;
  const all = words(part);
  const args = all.slice(all.findIndex((w) => /(^|\/)lumen$/.test(w)) + 1);
  const [cmd, sub] = args;
  switch (cmd) {
    case 'matter':
    case 'docs':
      return "Listing the matter's documents";
    case 'read': {
      const anchor = flag(args, '--anchor');
      const page = flag(args, '--page') ?? anchor?.match(/^p(\d+)/)?.[1];
      return page ? `Reading a document, p. ${page}` : 'Reading a document';
    }
    case 'search': {
      const q = flag(args, '--query') ?? flag(args, '-q');
      return q ? `Searching the vault for "${q}"` : 'Searching the vault';
    }
    case 'cite':
      return 'Checking citations against the source';
    case 'result':
      return sub === 'done' ? 'Finishing up' : 'Saving the results';
    case 'redline':
      return sub === 'verify' ? 'Checking the redline opens' : 'Writing the redline';
    case 'draft':
      return 'Rendering the draft';
    case 'ocr':
      return 'Reading a scanned document';
    case 'index':
      return 'Indexing the vault';
    default:
      return null;
  }
}
