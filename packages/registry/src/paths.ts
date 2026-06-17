/**
 * Resolve a file `target` (which may use a Kortix alias) to a concrete
 * repo-relative POSIX path in the consuming project.
 */

export interface TargetContext {
  /** The OpenCode config dir, e.g. ".kortix/opencode". */
  configDir: string;
  /** Memory dir, e.g. ".kortix/memory". */
  memoryDir?: string;
}

export function expandTarget(target: string, ctx: TargetContext): string {
  const cd = ctx.configDir.replace(/\/+$/, '');
  const mem = (ctx.memoryDir ?? '.kortix/memory').replace(/\/+$/, '');
  let out: string;

  if (target === '~' || target === '~/') {
    out = '';
  } else if (target.startsWith('~/')) {
    out = target.slice(2);
  } else {
    const alias = target.match(/^@([a-zA-Z]+)\/(.*)$/);
    if (alias) {
      const [, name, rest] = alias;
      switch (name) {
        case 'opencode':
          out = `${cd}/${rest}`;
          break;
        case 'skills':
          out = `${cd}/skills/${rest}`;
          break;
        case 'agents':
          out = `${cd}/agents/${rest}`;
          break;
        case 'commands':
          out = `${cd}/commands/${rest}`;
          break;
        case 'tools':
          out = `${cd}/tools/${rest}`;
          break;
        case 'memory':
          out = `${mem}/${rest}`;
          break;
        default:
          // Unknown alias — leave verbatim (treated as a literal path).
          out = target;
      }
    } else {
      out = target;
    }
  }

  out = out.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  if (out.split('/').includes('..')) {
    throw new Error(`target "${target}" resolves outside the project`);
  }
  return out;
}

// --- target builders (used by `kortix registry build`) ---------------------

export const buildTarget = {
  skill: (name: string, rel: string) => `@skills/${name}/${rel}`,
  agent: (file: string) => `@agents/${file}`,
  command: (file: string) => `@commands/${file}`,
  tool: (file: string) => `@tools/${file}`,
  memory: (file: string) => `@memory/${file}`,
  opencode: (rel: string) => `@opencode/${rel}`,
};
