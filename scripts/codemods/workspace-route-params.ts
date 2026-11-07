#!/usr/bin/env bun
/**
 * Codemod 1 of the Workspaces unification (design: .agents/skills/learnings/work/workspaces/design.md §3, §4).
 *
 * Renames the route parameters `:projectId` and `:accountId` to `:workspaceId`
 * in `apps/api/src`, and rewrites every read of them:
 *
 *   route path literal  '/:projectId/sessions'            → '/:workspaceId/sessions'
 *   OpenAPI path        '/{projectId}/sessions'           → '/{workspaceId}/sessions'
 *   param schema key    params: z.object({ projectId })   → z.object({ workspaceId })
 *   raw read            c.req.param('projectId')          → workspaceIdParam(c)
 *   validated read      const { projectId } = c.req.valid('param')
 *                                                         → const { workspaceId: projectId } = c.req.valid('param')
 *   account read        c.req.param('accountId')          → accountIdParam(c)
 *                       const { accountId, x } = c.req.valid('param')
 *                                                         → const { x } = c.req.valid('param'); const accountId = accountIdParam(c);
 *
 * `workspaceIdParam` / `accountIdParam` live in `apps/api/src/shared/route-params.ts`.
 * `accountIdParam` returns the account the workspace resolver middleware found
 * for the path id (`/v1/workspaces/<workspaceId>/iam` names a project id), so
 * an account handler never reads the raw path value as an account id.
 *
 * Local variable names stay (`projectId`, `accountId`): the design renames at
 * the seams, not every local (#5480 sank on a 2,296-file rename).
 *
 * Re-runnable and idempotent: after a `dev` merge, run it again instead of
 * resolving conflicts by hand. It changes no behavior on its own; tsc and
 * `apps/api/src/__tests__/unit-workspace-route-params.test.ts` catch a miss.
 *
 *   bun scripts/codemods/workspace-route-params.ts [--check] [files...]
 *
 * `--check` writes nothing and exits 1 when a file would change.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import type * as TS from 'typescript';

const REPO = resolve(import.meta.dir, '../..');
// The repo root has no `typescript`; apps/api pins it (the code this rewrites).
const ts: typeof TS = createRequire(join(REPO, 'apps/api/package.json'))('typescript');
const SRC = join(REPO, 'apps/api/src');
const HELPER = join(SRC, 'shared/route-params');

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use', 'options', 'head', 'route']);
const OLD_PARAMS = ['projectId', 'accountId'] as const;
type OldParam = (typeof OLD_PARAMS)[number];
const HELPER_FOR: Record<OldParam, string> = { projectId: 'workspaceIdParam', accountId: 'accountIdParam' };

interface Edit {
  start: number;
  end: number;
  text: string;
}

function isTestFile(path: string): boolean {
  return /(^|\/)__tests__\//.test(path) || /\.test\.ts$/.test(path) || /(^|\/)test-utils?\//.test(path);
}

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === 'node_modules') continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** `'/:projectId/x'` → `'/:workspaceId/x'`; `{projectId}` → `{workspaceId}`. */
export function renamePathText(text: string): string {
  return text
    .replace(/:(projectId|accountId)(?![A-Za-z0-9_])/g, ':workspaceId')
    .replace(/(?<!\$)\{(projectId|accountId)\}/g, '{workspaceId}');
}

function hasOldPathParam(text: string): boolean {
  return /:(projectId|accountId)(?![A-Za-z0-9_])|(?<!\$)\{(projectId|accountId)\}/.test(text);
}

/** `X.req.param` / `X.req.valid` callee → `X`, else null. */
function reqCallReceiver(call: TS.CallExpression, method: 'param' | 'valid'): TS.Expression | null {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== method) return null;
  const req = callee.expression;
  if (!ts.isPropertyAccessExpression(req) || req.name.text !== 'req') return null;
  return req.expression;
}

function stringArg(call: TS.CallExpression, index = 0): string | null {
  const arg = call.arguments[index];
  return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
}

/** `c.req.valid('param')` or `c.req.param()` (no args): the whole param object. */
function paramObjectReceiver(node: TS.Expression): TS.Expression | null {
  if (!ts.isCallExpression(node)) return null;
  const valid = reqCallReceiver(node, 'valid');
  if (valid && stringArg(node) === 'param') return valid;
  const raw = reqCallReceiver(node, 'param');
  if (raw && node.arguments.length === 0) return raw;
  return null;
}

/** Literal-ish nodes whose text is a route path in a route definition. */
function routePathLiterals(sf: TS.SourceFile): TS.Node[] {
  const found = new Set<TS.Node>();
  const isPathish = (n: TS.Node): boolean =>
    ts.isStringLiteralLike(n) || ts.isTemplateExpression(n);
  const visit = (node: TS.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      if (ROUTE_METHODS.has(name) && node.arguments[0] && isPathish(node.arguments[0])) found.add(node.arguments[0]);
      if (name === 'on' && node.arguments[1] && isPathish(node.arguments[1])) found.add(node.arguments[1]);
    }
    // A path literal anywhere else (a route table, `for (const path of ['/{projectId}/a', …])`):
    // any string that starts with `/` and names the param as a path segment.
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /^\/[^\s]*$/.test(node.text)) {
      found.add(node);
    }
    if (ts.isTemplateExpression(node) && /^\/\S*$/.test(node.head.text) && !/\s/.test(node.getText(sf))) {
      found.add(node);
    }
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'path' &&
      isPathish(node.initializer)
    ) {
      found.add(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...found];
}

/** Names of the `z.object(...)` constants this file passes as `params:`. */
function paramSchemaNames(sf: TS.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: TS.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'params') {
      let init: TS.Expression = node.initializer;
      // params: Foo.extend({...}) / Foo.merge(Bar)
      while (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression)) {
        init = init.expression.expression;
      }
      if (ts.isIdentifier(init)) names.add(init.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

function isZObjectCall(node: TS.Node): node is TS.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'z' &&
    node.expression.name.text === 'object'
  );
}

/** Object literals that are a route's param schema shape. */
function paramSchemaObjects(sf: TS.SourceFile, schemaNames: Set<string>): TS.ObjectLiteralExpression[] {
  const out: TS.ObjectLiteralExpression[] = [];
  const shapeOf = (expr: TS.Expression | undefined): void => {
    if (!expr) return;
    // z.object({...}) and z.object({...}).openapi(...) / .strict() chains
    let cur: TS.Expression = expr;
    while (ts.isCallExpression(cur) && !isZObjectCall(cur) && ts.isPropertyAccessExpression(cur.expression)) {
      // Foo.extend({ projectId }) : the extension shape is a param shape too
      if (cur.expression.name.text === 'extend' && cur.arguments[0] && ts.isObjectLiteralExpression(cur.arguments[0])) {
        out.push(cur.arguments[0]);
      }
      cur = cur.expression.expression;
    }
    if (isZObjectCall(cur) && cur.arguments[0] && ts.isObjectLiteralExpression(cur.arguments[0])) out.push(cur.arguments[0]);
  };
  const visit = (node: TS.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'params') shapeOf(node.initializer);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      if (schemaNames.has(name)) shapeOf(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function lineIndent(text: string, pos: number): string {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const m = /^[ \t]*/.exec(text.slice(lineStart));
  return m ? m[0] : '';
}

/** Every identifier any file passes as `params:` (a shared schema such as `ProjectParam` is used elsewhere). */
export function collectParamSchemaNames(files: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('params')) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const n of paramSchemaNames(sf)) names.add(n);
  }
  return names;
}

export function transformSource(path: string, text: string, schemaNames?: Set<string>): string {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits: Edit[] = [];
  const helpersUsed = new Set<string>();
  const nodeText = (n: TS.Node) => text.slice(n.getStart(sf), n.getEnd());

  // 1. Route path literals.
  for (const lit of routePathLiterals(sf)) {
    const raw = nodeText(lit);
    if (hasOldPathParam(raw)) edits.push({ start: lit.getStart(sf), end: lit.getEnd(), text: renamePathText(raw) });
  }

  // 2. Param schema keys.
  for (const obj of paramSchemaObjects(sf, schemaNames ?? paramSchemaNames(sf))) {
    for (const prop of obj.properties) {
      const name = prop.name;
      if (!name || !(ts.isIdentifier(name) || ts.isStringLiteral(name))) continue;
      if (!(OLD_PARAMS as readonly string[]).includes(name.text)) continue;
      if (ts.isShorthandPropertyAssignment(prop)) {
        edits.push({ start: prop.getStart(sf), end: prop.getEnd(), text: `workspaceId: ${name.text}` });
      } else {
        edits.push({ start: name.getStart(sf), end: name.getEnd(), text: 'workspaceId' });
      }
    }
  }

  // 3. Reads.
  const visit = (node: TS.Node): void => {
    // c.req.param('projectId') / c.req.param('accountId')
    if (ts.isCallExpression(node)) {
      const recv = reqCallReceiver(node, 'param');
      const key = recv ? stringArg(node) : null;
      if (recv && key && (OLD_PARAMS as readonly string[]).includes(key)) {
        const helper = HELPER_FOR[key as OldParam];
        helpersUsed.add(helper);
        edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `${helper}(${nodeText(recv)})` });
        return;
      }
    }
    // c.req.valid('param').projectId
    if (ts.isPropertyAccessExpression(node) && (OLD_PARAMS as readonly string[]).includes(node.name.text)) {
      const recv = paramObjectReceiver(node.expression);
      if (recv) {
        if (node.name.text === 'projectId') {
          edits.push({ start: node.name.getStart(sf), end: node.name.getEnd(), text: 'workspaceId' });
        } else {
          helpersUsed.add('accountIdParam');
          edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `accountIdParam(${nodeText(recv)})` });
        }
        return;
      }
    }
    // const { projectId, accountId, x } = c.req.valid('param')
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name)) {
      const recv = paramObjectReceiver(node.initializer);
      if (recv) {
        const pattern = node.name;
        const kept: string[] = [];
        const accountLocals: string[] = [];
        let changed = false;
        for (const el of pattern.elements) {
          const prop = el.propertyName ?? el.name;
          const propName = ts.isIdentifier(prop) || ts.isStringLiteral(prop) ? prop.text : null;
          const local = nodeText(el.name);
          if (propName === 'projectId') {
            kept.push(`workspaceId: ${local}${el.initializer ? ` = ${nodeText(el.initializer)}` : ''}`);
            changed = true;
          } else if (propName === 'accountId') {
            accountLocals.push(local);
            changed = true;
          } else {
            kept.push(nodeText(el));
          }
        }
        if (changed) {
          const stmt = node.parent?.parent; // VariableDeclarationList → VariableStatement
          const decl = node.parent;
          if (!stmt || !ts.isVariableStatement(stmt) || !decl || decl.declarations.length !== 1) {
            throw new Error(`${relative(REPO, path)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: unsupported param destructure`);
          }
          const keyword = decl.flags & ts.NodeFlags.Const ? 'const' : 'let';
          const indent = lineIndent(text, stmt.getStart(sf));
          const lines: string[] = [];
          if (kept.length > 0) lines.push(`${keyword} { ${kept.join(', ')} } = ${nodeText(node.initializer)};`);
          for (const local of accountLocals) {
            helpersUsed.add('accountIdParam');
            lines.push(`${keyword} ${local} = accountIdParam(${nodeText(recv)});`);
          }
          edits.push({ start: stmt.getStart(sf), end: stmt.getEnd(), text: lines.join(`\n${indent}`) });
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (edits.length === 0) return text;

  edits.sort((a, b) => b.start - a.start);
  for (let i = 1; i < edits.length; i++) {
    if (edits[i]!.end > edits[i - 1]!.start) {
      throw new Error(`${relative(REPO, path)}: overlapping edits at ${edits[i]!.start}`);
    }
  }
  let out = text;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  if (helpersUsed.size > 0) out = ensureHelperImport(path, out, helpersUsed);
  return out;
}

function ensureHelperImport(path: string, text: string, helpers: Set<string>): string {
  let spec = relative(dirname(path), HELPER).split('\\').join('/');
  if (!spec.startsWith('.')) spec = `./${spec}`;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text === spec &&
      stmt.importClause?.namedBindings &&
      ts.isNamedImports(stmt.importClause.namedBindings)
    ) {
      const have = new Set(stmt.importClause.namedBindings.elements.map((e) => e.name.text));
      const all = [...new Set([...have, ...helpers])].sort();
      if (all.length === have.size) return text;
      const start = stmt.getStart(sf);
      return `${text.slice(0, start)}import { ${all.join(', ')} } from '${spec}';${text.slice(stmt.getEnd())}`;
    }
  }
  const imports = sf.statements.filter(ts.isImportDeclaration);
  const line = `import { ${[...helpers].sort().join(', ')} } from '${spec}';`;
  if (imports.length === 0) return `${line}\n${text}`;
  const last = imports[imports.length - 1]!;
  return `${text.slice(0, last.getEnd())}\n${line}${text.slice(last.getEnd())}`;
}

/**
 * `packages/shared/src/audit-route-labels.ts` keys every label by the route
 * template (`'GET /v1/projects/:projectId'`), so its keys and alias values move
 * with the routes. Rows written before the rename still name `:projectId`;
 * `auditLabelForRoute` maps those through `legacyRouteTemplate`.
 */
const AUDIT_LABELS = join(REPO, 'packages/shared/src/audit-route-labels.ts');

export function transformAuditLabels(text: string): string {
  return text.replace(/'([A-Z]+ \/[^']*)'/g, (whole, key: string) =>
    hasOldPathParam(key) ? `'${renamePathText(key)}'` : whole,
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const explicit = args.filter((a) => !a.startsWith('--')).map((a) => resolve(a));
  const files = (explicit.length > 0 ? explicit : walk(SRC, [])).filter(
    (f) => !isTestFile(relative(SRC, f)) && resolve(f) !== resolve(`${HELPER}.ts`),
  );
  const schemaNames = collectParamSchemaNames(walk(SRC, []).filter((f) => !isTestFile(relative(SRC, f))));
  let changed = 0;
  for (const file of files) {
    const before = readFileSync(file, 'utf8');
    const after = transformSource(file, before, schemaNames);
    if (after === before) continue;
    changed++;
    if (check) console.log(`would change ${relative(REPO, file)}`);
    else writeFileSync(file, after);
  }
  if (explicit.length === 0) {
    const before = readFileSync(AUDIT_LABELS, 'utf8');
    const after = transformAuditLabels(before);
    if (after !== before) {
      changed++;
      if (check) console.log(`would change ${relative(REPO, AUDIT_LABELS)}`);
      else writeFileSync(AUDIT_LABELS, after);
    }
  }
  console.log(`[workspace-route-params] ${check ? 'would change' : 'changed'} ${changed} of ${files.length + 1} files`);
  process.exit(check && changed > 0 ? 1 : 0);
}
