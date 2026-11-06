#!/usr/bin/env bun
/**
 * Codemod 2 of the Workspaces unification (design: .agents/skills/learnings/work/workspaces/design.md §1.3, §3).
 *
 * Renames Drizzle PROPERTIES, never columns: the SQL stays byte-identical.
 *
 *   1. `captureWorkspaces` (the Kortix Capture tenant table) → `captureTenants`.
 *      A Capture tenant is not a Kortix workspace.
 *   2. `workspaceId` on the 6 chat tables (`chat_installs`, `chat_channel_bindings`,
 *      `chat_threads`, `chat_pending_auth_messages`, `chat_thread_participants`,
 *      `chat_user_identities`) → `platformTeamId`. There `workspace_id` is the
 *      Slack/Teams team id.
 *   3. Only with `--project-id`: `projectId` → `workspaceId` on every table and
 *      view in `@kortix/db` whose column `project_id` is a column of the
 *      definition. Column names stay `project_id`.
 *
 * Stage 3 is gated. Measured on 2026-11-05 (113 declarations): 2,517 renamed
 * references and 471 inferred-type fixes in 608 files, then 1,551 tsc errors
 * left. 1,222 are insert/update overloads (mechanical). The rest (TS2741,
 * TS2344, TS2345: ~315) are hand-written domain types that mirror a row
 * (`GitBackedProject`, `ArtifactScope`, `Pick<…, 'projectId'>`). Renaming those
 * cascades into every caller: the bulk rename that sank #5480. Run stage 3
 * one module at a time, in Release 3 with the column rename (design.md §5).
 *
 * Every reference moves with its declaration through the TypeScript language
 * service (`findRenameLocations`, prefix/suffix text on: a shorthand
 * `{ projectId }` becomes `{ workspaceId: projectId }`, so local names stay).
 * A row read through Drizzle's inferred types is not always linked to the
 * declaration, so a second pass fixes the compiler errors the rename leaves:
 * TS2551/TS2339 ("Property 'projectId' does not exist … Did you mean
 * 'workspaceId'?") on a member access or a destructuring, and TS2353/TS2561
 * on an object-literal key. Each fix renames that one occurrence, and the
 * pass repeats until no such error remains.
 *
 * Re-runnable and idempotent: after a `dev` merge, run it again instead of
 * resolving conflicts by hand. A second run finds no target and writes nothing.
 *
 *   bun scripts/codemods/workspace-drizzle-properties.ts [--check] [--project-id]
 *
 * `--check` writes nothing and exits 1 when a file would change.
 * Proof that the SQL is unchanged: KORTIX_SQL_TRACE before/after (AGENTS.md "SQL trace").
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import type * as TS from 'typescript';

const REPO = resolve(import.meta.dir, '../..');
const ts: typeof TS = createRequire(join(REPO, 'apps/api/package.json'))('typescript');
const SCHEMA_FILES = ['packages/db/src/schema/kortix.ts', 'packages/db/src/schema/public.ts'].map((p) => join(REPO, p));
const ROOT_DIRS = ['apps/api/src', 'apps/api/scripts', 'packages/db/src', 'packages/db/scripts'].map((p) => join(REPO, p));
const CHAT_TABLES = new Set([
  'chatInstalls',
  'chatChannelBindings',
  'chatThreads',
  'chatPendingAuthMessages',
  'chatThreadParticipants',
  'chatUserIdentities',
]);
const CHECK = process.argv.includes('--check');
const PROJECT_ID = process.argv.includes('--project-id');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function compilerOptions(): TS.CompilerOptions {
  const configPath = join(REPO, 'apps/api/tsconfig.json');
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    },
  });
  if (!parsed) throw new Error('cannot read apps/api/tsconfig.json');
  return { ...parsed.options, noEmit: true };
}

/** An in-memory language service over the files this codemod may rewrite. */
function createService(files: string[]) {
  const texts = new Map<string, string>();
  const versions = new Map<string, number>();
  for (const f of files) {
    texts.set(f, readFileSync(f, 'utf8'));
    versions.set(f, 0);
  }
  const options = compilerOptions();
  const host: TS.LanguageServiceHost = {
    getScriptFileNames: () => files,
    getScriptVersion: (f) => String(versions.get(f) ?? 0),
    getScriptSnapshot: (f) => {
      const text = texts.get(f) ?? (ts.sys.fileExists(f) ? ts.sys.readFile(f) : undefined);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => join(REPO, 'apps/api'),
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (f) => texts.has(f) || ts.sys.fileExists(f),
    readFile: (f) => texts.get(f) ?? ts.sys.readFile(f),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const changed = new Set<string>();
  return {
    service,
    text: (f: string) => texts.get(f) ?? '',
    owns: (f: string) => texts.has(f),
    write(f: string, text: string) {
      if (texts.get(f) === text) return;
      texts.set(f, text);
      versions.set(f, (versions.get(f) ?? 0) + 1);
      changed.add(f);
    },
    changed,
  };
}

interface Edit {
  file: string;
  start: number;
  end: number;
  text: string;
}

/** Apply edits per file, last first. Two edits on one span must agree. */
function applyEdits(svc: ReturnType<typeof createService>, edits: Edit[]) {
  const byFile = new Map<string, Map<number, Edit>>();
  for (const e of edits) {
    if (!svc.owns(e.file)) continue;
    const m = byFile.get(e.file) ?? new Map<number, Edit>();
    const prev = m.get(e.start);
    if (prev && (prev.end !== e.end || prev.text !== e.text)) {
      throw new Error(`conflicting edits at ${relative(REPO, e.file)}:${e.start}`);
    }
    m.set(e.start, e);
    byFile.set(e.file, m);
  }
  for (const [file, m] of byFile) {
    let text = svc.text(file);
    for (const e of [...m.values()].sort((a, b) => b.start - a.start)) {
      text = text.slice(0, e.start) + e.text + text.slice(e.end);
    }
    svc.write(file, text);
  }
}

/** `<name>: <col>('project_id' …)` style properties of each table/view columns object. */
interface Target {
  file: string;
  pos: number;
  newName: string;
  label: string;
}

function columnName(init: TS.Expression): string | null {
  // uuid('project_id').notNull().references(...) — find the innermost call's first string arg.
  let e: TS.Expression = init;
  while (true) {
    if (ts.isCallExpression(e)) {
      if (ts.isPropertyAccessExpression(e.expression)) {
        e = e.expression.expression;
        continue;
      }
      const arg = e.arguments[0];
      return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
    }
    if (ts.isPropertyAccessExpression(e)) {
      e = e.expression;
      continue;
    }
    return null;
  }
}

function findTargets(svc: ReturnType<typeof createService>): Target[] {
  const program = svc.service.getProgram();
  if (!program) throw new Error('no program');
  const targets: Target[] = [];
  for (const file of SCHEMA_FILES) {
    const sf = program.getSourceFile(file);
    if (!sf) throw new Error(`schema file not in program: ${file}`);
    for (const stmt of sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const tableName = decl.name.text;
        if (tableName === 'captureWorkspaces') {
          targets.push({ file, pos: decl.name.getStart(sf), newName: 'captureTenants', label: 'captureWorkspaces' });
        }
        // The columns object: the 2nd argument of `.table('name', {...})` /
        // `pgTable('name', {...})` / `.view('name', {...})`.
        let call: TS.Expression = decl.initializer;
        while (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) &&
          !['table', 'view'].includes(call.expression.name.text)) {
          call = call.expression.expression;
        }
        if (!ts.isCallExpression(call)) continue;
        const callee = call.expression;
        const calleeName = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
        if (!['table', 'view', 'pgTable', 'pgView'].includes(calleeName)) continue;
        const cols = call.arguments[1];
        if (!cols || !ts.isObjectLiteralExpression(cols)) continue;
        const props = new Map<string, TS.PropertyAssignment>();
        for (const p of cols.properties) {
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) props.set(p.name.text, p);
        }
        const chat = CHAT_TABLES.has(tableName);
        const ws = props.get('workspaceId');
        if (chat && ws) {
          targets.push({ file, pos: ws.name.getStart(sf), newName: 'platformTeamId', label: `${tableName}.workspaceId` });
        }
        const pid = props.get('projectId');
        if (PROJECT_ID && pid && columnName(pid.initializer) === 'project_id') {
          if (ws && !chat) throw new Error(`${tableName} has both projectId and workspaceId`);
          targets.push({ file, pos: pid.name.getStart(sf), newName: 'workspaceId', label: `${tableName}.projectId` });
        }
      }
    }
  }
  return targets;
}

function renameAll(svc: ReturnType<typeof createService>, targets: Target[]) {
  const edits: Edit[] = [];
  for (const t of targets) {
    // A table symbol renames everywhere (imports and the @kortix/db re-export
    // included); a property keeps local names through prefix/suffix text.
    const keepLocals = t.label !== 'captureWorkspaces';
    const locs = svc.service.findRenameLocations(t.file, t.pos, false, false, { providePrefixAndSuffixTextForRename: keepLocals });
    if (!locs) throw new Error(`no rename locations for ${t.label}`);
    for (const l of locs) {
      edits.push({
        file: l.fileName,
        start: l.textSpan.start,
        end: l.textSpan.start + l.textSpan.length,
        text: `${l.prefixText ?? ''}${t.newName}${l.suffixText ?? ''}`,
      });
    }
  }
  applyEdits(svc, edits);
  return edits.length;
}

/** Old property name → new name, for the stages that ran. */
const RENAMES: Record<string, string> = { workspaceId: 'platformTeamId', captureWorkspaces: 'captureTenants' };
if (PROJECT_ID) RENAMES.projectId = 'workspaceId';

function nodeAt(sf: TS.SourceFile, pos: number): TS.Node | undefined {
  let found: TS.Node | undefined;
  const visit = (n: TS.Node) => {
    if (pos >= n.getStart(sf) && pos < n.getEnd()) {
      found = n;
      ts.forEachChild(n, visit);
    }
  };
  visit(sf);
  return found;
}

function typeHas(checker: TS.TypeChecker, type: TS.Type | undefined, name: string): boolean {
  if (!type) return false;
  const parts = type.isUnion() ? type.types : [type];
  return parts.some((t) => {
    const elem = checker.isArrayType(t) ? checker.getTypeArguments(t as TS.TypeReference)[0] : t;
    return Boolean(elem && checker.getPropertyOfType(elem, name));
  });
}

/** `old` → `new` keys in the object literals of one call's arguments whose contextual type has `new`, not `old`. */
function literalKeyEdits(checker: TS.TypeChecker, sf: TS.SourceFile, file: string, root: TS.Node): Edit[] {
  const edits: Edit[] = [];
  // `db.insert(table).values(…)` / `db.update(table).set(…)`: the table's own
  // columns decide when the failed overload leaves no contextual type.
  let tableType: TS.Type | undefined;
  for (let c: TS.Node | undefined = root; c; c = ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression) ? c.expression.expression : undefined) {
    if (ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression) &&
      ['insert', 'update'].includes(c.expression.name.text) && c.arguments[0]) {
      tableType = checker.getTypeAtLocation(c.arguments[0]);
      break;
    }
  }
  const visit = (n: TS.Node) => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isObjectLiteralExpression(n)) {
      const contextual = checker.getContextualType(n);
      const ctx = contextual && Object.values(RENAMES).some((r) => typeHas(checker, contextual, r)) ? contextual : tableType;
      for (const p of n.properties) {
        const nameNode = ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) ? p.name : undefined;
        if (!nameNode || !ts.isIdentifier(nameNode)) continue;
        const next = RENAMES[nameNode.text];
        if (!next || !typeHas(checker, ctx, next) || typeHas(checker, ctx, nameNode.text)) continue;
        edits.push({
          file,
          start: nameNode.getStart(sf),
          end: nameNode.getEnd(),
          text: ts.isShorthandPropertyAssignment(p) ? `${next}: ${nameNode.text}` : next,
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return edits;
}

/** Fix the compiler errors left where Drizzle's inferred types hide the link to the declaration. */
function fixRemaining(svc: ReturnType<typeof createService>, files: string[]): number {
  let total = 0;
  const names = [...Object.keys(RENAMES), ...Object.values(RENAMES)];
  for (let round = 0; round < 20; round++) {
    const edits: Edit[] = [];
    const program = svc.service.getProgram();
    if (!program) throw new Error('no program');
    const checker = program.getTypeChecker();
    for (const file of files) {
      const sf = program.getSourceFile(file);
      if (!sf) continue;
      for (const d of svc.service.getSemanticDiagnostics(file)) {
        if (d.start === undefined) continue;
        const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
        if (!names.some((n) => msg.includes(`'${n}'`))) continue;
        const node = nodeAt(sf, d.start);
        if (!node) continue;
        if ([2769, 2345, 2322, 2353, 2561, 2741].includes(d.code)) {
          // An insert/update overload or an object literal: rename its keys by contextual type.
          let root: TS.Node = node;
          while (root.parent && !ts.isSourceFile(root.parent) &&
            !(ts.isCallExpression(root) && ts.isPropertyAccessExpression(root.expression) && ['values', 'set'].includes(root.expression.name.text)) &&
            !ts.isExpressionStatement(root.parent) && !ts.isVariableDeclaration(root.parent) && !ts.isReturnStatement(root.parent)) {
            root = root.parent;
          }
          edits.push(...literalKeyEdits(checker, sf, file, root));
          continue;
        }
        if (![2551, 2339].includes(d.code) || !ts.isIdentifier(node) || !RENAMES[node.text]) continue;
        const next = RENAMES[node.text];
        if (!msg.includes(next)) continue;
        const parent = node.parent;
        if (ts.isShorthandPropertyAssignment(parent) || (ts.isBindingElement(parent) && !parent.propertyName && parent.name === node)) {
          // { old } shorthand (literal or destructuring): keep the local name.
          edits.push({ file, start: node.getStart(sf), end: node.getEnd(), text: `${next}: ${node.text}` });
        } else {
          edits.push({ file, start: node.getStart(sf), end: node.getEnd(), text: next });
        }
      }
    }
    if (edits.length === 0) return total;
    applyEdits(svc, edits);
    total += edits.length;
  }
  throw new Error('fixRemaining did not converge in 20 rounds');
}

const files = ROOT_DIRS.flatMap((d) => walk(d));
const svc = createService(files);
const targets = findTargets(svc);
const renamed = targets.length ? renameAll(svc, targets) : 0;
const fixed = targets.length ? fixRemaining(svc, files) : 0;
const changed = [...svc.changed];
console.log(
  `[workspace-drizzle-properties] ${targets.length} declarations, ${renamed} renamed references, ` +
    `${fixed} inferred-type fixes, ${changed.length} files`,
);
if (CHECK) process.exit(changed.length ? 1 : 0);
for (const f of changed) writeFileSync(f, svc.text(f));
