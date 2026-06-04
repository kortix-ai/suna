/**
 * kortix-simple-memory — opencode plugin
 *
 * Injects `.kortix/memory/MEMORY.md` (the project-brain index) into the
 * front of the system prompt as a `<kortix-memory>` block on every LLM
 * call. Sub-files in `.kortix/memory/` are NOT auto-loaded — the agent
 * reads them on demand with the built-in `read` tool.
 *
 * Why front of `output.system[]`: it sits in the cached prefix of the
 * prompt, so as long as MEMORY.md doesn't change mid-session the
 * provider's prefix cache keeps hitting.
 *
 * For the rubric on what belongs in project memory and how to update
 * it, load the `kortix-memory` skill.
 */

import type { Plugin } from "@opencode-ai/plugin";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

type Options = {
  /** Path relative to project root. Default: ".kortix/memory" */
  dir?: string;
  /** Index filename inside `dir`. Default: "MEMORY.md" */
  index?: string;
  /** Soft cap on the injected block to keep the prompt cache tight. */
  maxChars?: number;
};

export const KortixSimpleMemory: Plugin = async (ctx, opts: Options = {}) => {
  const memDir   = opts.dir   ?? ".kortix/memory";
  const indexRel = opts.index ?? "MEMORY.md";
  const maxChars = opts.maxChars ?? 8192;

  async function readBlock(): Promise<string | null> {
    const root = ctx.directory;
    const indexPath = join(root, memDir, indexRel);

    let body: string;
    try {
      body = await readFile(indexPath, "utf8");
    } catch {
      return null; // memory not initialized — no-op
    }

    // List sibling files so the agent knows what's available to `read`.
    let listing: string[] = [];
    try {
      const entries = await readdir(join(root, memDir));
      for (const name of entries) {
        if (name === indexRel || name.startsWith(".")) continue;
        const full = join(root, memDir, name);
        const s = await stat(full);
        if (s.isFile()) listing.push(name);
      }
      listing.sort();
    } catch { /* empty dir is fine */ }

    const filesLine = listing.length
      ? `Files in ${memDir}/ available via \`read\` / \`bash\`: ${listing.join(", ")}`
      : "";

    let block =
      `<kortix-memory source="${memDir}/${indexRel}">\n` +
      `[Project brain — durable, team-shared knowledge about this project.\n` +
      ` The index below names sub-files in ${memDir}/. Open them with the\n` +
      ` \`memory\` tool (command "view") when the index points at one that's\n` +
      ` relevant to the current task.\n\n` +
      ` MEMORY PROTOCOL:\n` +
      ` - ALWAYS \`view\` ${memDir} (memory tool) before starting a task, to\n` +
      `   recover earlier context and progress.\n` +
      ` - As you make progress or learn something durable, record it in memory\n` +
      `   with the \`memory\` tool. ASSUME INTERRUPTION: your context window may\n` +
      `   reset at any moment, so anything not written to ${memDir} is lost.\n` +
      ` - Use the \`memory\` tool (not the generic read/edit/write tools) for\n` +
      `   everything under ${memDir}. Keep it coherent and organized: edit\n` +
      `   existing files, rename or delete stale ones, and don't create new\n` +
      `   files unless a topic deserves its own page. Keep ${indexRel} in sync.\n` +
      ` - Load the \`kortix-memory\` skill for the rubric on what to remember.]\n\n` +
      body.trim() +
      (filesLine ? `\n\n${filesLine}` : "") +
      `\n</kortix-memory>`;

    if (block.length > maxChars) {
      block = block.slice(0, maxChars - 32) + "\n[...truncated]\n</kortix-memory>";
    }
    return block;
  }

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      const block = await readBlock();
      if (!block) return;
      output.system.unshift(block);
    },
  };
};

export default KortixSimpleMemory;
