#!/usr/bin/env node
/**
 * Binary patch: enable tool-input streaming in OpenCode's compiled Bun binary.
 *
 * ROOT CAUSE: The processor (processor.ts) has no-op handlers for
 * tool-input-delta and tool-input-end events — they just `break`/`return`.
 * The AI SDK pipeline correctly generates and forwards these events all the
 * way to fullStream, but the processor ignores them.
 *
 * This patch replaces the no-op handlers with code that:
 *   tool-input-delta: accumulates value.delta into part.state.raw, pushes update
 *   tool-input-end:   no-op (tool-call sets input from parsed args anyway)
 *
 * This is a fallback for binaries built without the source-level streaming
 * patch in opencode-config-failsafe-core.patch. Supports two binary layouts:
 *   old-style (<=1.2.x): uses `break`, `await Session.updatePart`, `toolcalls[v.id]=part`
 *   new-style (>=1.3.x): uses `return`, `yield* session.updatePart`, `ctx.toolcalls[v.id]=...`
 *
 * The patcher auto-detects the variable name (value5, value8, value9, etc.)
 * from the surrounding code and builds a tailored replacement.
 *
 * Strategy: find-and-replace with exact same byte length, padded with trailing
 * spaces. The Bun binary stores JS source as plain text. There are typically
 * 2 copies of the processor code — both are patched.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ── Locate all opencode binaries ───────────────────────────────────────────

function findBinaries() {
  const roots = new Set();
  try {
    roots.add(execSync("npm root -g", { encoding: "utf8" }).trim());
  } catch {}
  // Build-time install location (Docker images)
  roots.add("/usr/local/lib/node_modules");

  const pkgNames = [
    "opencode-linux-arm64-musl",
    "opencode-linux-x64-musl",
    "opencode-linux-arm64",
    "opencode-linux-x64",
    "opencode-darwin-arm64",
    "opencode-darwin-x64",
  ];

  const paths = new Set();
  const extra = [process.env.KORTIX_OPENCODE_OUTPUT_BIN, "/usr/local/bin/opencode-kortix"];
  for (const candidate of extra) {
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).size > 1_000_000) {
      paths.add(candidate);
    }
  }
  for (const root of roots) {
    for (const pkg of pkgNames) {
      const p = path.join(root, pkg, "bin", "opencode");
      if (fs.existsSync(p) && fs.statSync(p).size > 1_000_000) paths.add(p);
    }
    for (const pkg of pkgNames) {
      const p = path.join(root, "opencode-ai", "node_modules", pkg, "bin", "opencode");
      if (fs.existsSync(p) && fs.statSync(p).size > 1_000_000) paths.add(p);
    }
  }
  return [...paths];
}

// ── Pattern definitions ────────────────────────────────────────────────────

function oldStyleSearch(v) {
  // Old-style (<=1.2.x): 193 bytes. Includes end of tool-input-start assignment.
  return (
    `toolcalls[${v}.id] = part;\n` +
    `                    break;\n` +
    `                  case "tool-input-delta":\n` +
    `                    break;\n` +
    `                  case "tool-input-end":\n` +
    `                    break;`
  );
}

function oldStyleReplace(v) {
  // Compressed: accumulate delta via await Session.updatePart
  return (
    `toolcalls[${v}.id]=part;break;` +
    `case"tool-input-delta":` +
    `{let p=toolcalls[${v}.id];` +
    `if(p){p.state.raw+=${v}.delta;` +
    `Session.updatePart(p)}break}` +
    `case"tool-input-end":break;`
  );
}

function newStyleSearch(v) {
  // New-style (>=1.3.x): wide pattern including the full updatePart call
  return (
    `ctx.toolcalls[${v}.id] = yield* session.updatePart({\n` +
    `                id: ctx.toolcalls[${v}.id]?.id ?? PartID.ascending(),\n` +
    `                messageID: ctx.assistantMessage.id,\n` +
    `                sessionID: ctx.assistantMessage.sessionID,\n` +
    `                type: "tool",\n` +
    `                tool: ${v}.toolName,\n` +
    `                callID: ${v}.id,\n` +
    `                state: { status: "pending", input: {}, raw: "" },\n` +
    `              } satisfies MessageV2.ToolPart)\n` +
    `              return;\n` +
    `            case "tool-input-delta":\n` +
    `              return;\n` +
    `            case "tool-input-end":\n` +
    `              return;`
  );
}

function newStyleReplace(v) {
  // Compressed updatePart + delta handler via yield*
  return (
    `ctx.toolcalls[${v}.id]=yield*session.updatePart({` +
    `id:ctx.toolcalls[${v}.id]?.id??PartID.ascending(),` +
    `messageID:ctx.assistantMessage.id,` +
    `sessionID:ctx.assistantMessage.sessionID,` +
    `type:"tool",tool:${v}.toolName,callID:${v}.id,` +
    `state:{status:"pending",input:{},raw:""},` +
    `});return;` +
    `case"tool-input-delta":{` +
    `let p=ctx.toolcalls[${v}.id];` +
    `if(p&&p.state.status==="pending"){` +
    `p.state.raw+=${v}.delta;` +
    `yield*session.updatePart(p)}return}` +
    `case"tool-input-end":return;`
  );
}

// ── Sentinel to detect already-patched binaries ────────────────────────────
const PATCH_MARKER = Buffer.from("p.state.raw+=", "utf8");

// ── Main ───────────────────────────────────────────────────────────────────

const binaryPaths = findBinaries();
if (binaryPaths.length === 0) {
  console.log("[patch-streaming] No opencode binaries found — skipping");
  process.exit(0);
}
console.log(`[patch-streaming] Found ${binaryPaths.length} binary(ies)`);

// Detect variable names used in the binary
function detectVars(binary) {
  const str = binary.toString("utf8");
  const vars = new Set();
  const re = /toolcalls\[(value\d*)\./g;
  let m;
  while ((m = re.exec(str)) !== null) vars.add(m[1]);
  return [...vars];
}

for (const binaryPath of binaryPaths) {
  console.log(`[patch-streaming] Processing ${binaryPath}`);
  const binary = fs.readFileSync(binaryPath);

  if (binary.indexOf(PATCH_MARKER) !== -1) {
    console.log("[patch-streaming] Already patched — skipping");
    continue;
  }

  const vars = detectVars(binary);
  console.log(`[patch-streaming] Detected variables: ${vars.join(", ")}`);

  let total = 0;

  for (const v of vars) {
    // Try each pattern style
    const styles = [
      { name: "old-style", search: oldStyleSearch, replace: oldStyleReplace },
      { name: "new-style", search: newStyleSearch, replace: newStyleReplace },
    ];

    for (const style of styles) {
      const searchStr = style.search(v);
      const replaceStr = style.replace(v);
      const searchBuf = Buffer.from(searchStr, "utf8");
      const replaceBuf = Buffer.from(replaceStr, "utf8");

      if (replaceBuf.length > searchBuf.length) {
        // Won't fit — skip silently (expected for non-matching style)
        continue;
      }

      // Pad to exact length
      const padded = Buffer.alloc(searchBuf.length, 0x20);
      replaceBuf.copy(padded);

      let offset = 0;
      while (true) {
        const idx = binary.indexOf(searchBuf, offset);
        if (idx === -1) break;
        padded.copy(binary, idx);
        total++;
        console.log(`[patch-streaming] Patched ${style.name} at offset ${idx} (${v})`);
        offset = idx + searchBuf.length;
      }
    }
  }

  if (total === 0) {
    console.log("[patch-streaming] No binary fallback patterns found — source patch may already cover this version");
    continue;
  }

  fs.writeFileSync(binaryPath, binary);
  console.log(`[patch-streaming] OK — patched ${total} occurrence(s) in ${binaryPath}`);
}
