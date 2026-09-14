// TYPESCRIPT IN THE CELL.
//
// A project whose repo is TypeScript could not ship a tool: the runtime
// evaluates JavaScript, and `function f(a: string)` is a syntax error to it.
// The answer is not a compiler — none fits in a 1.4 MiB isolate — it is
// ERASURE, the same thing Node does under `--experimental-strip-types`.
//
// These claims are about the two properties that make erasure safe to trust.
// FIRST, POSITIONS NEVER MOVE: every removed character becomes a space and
// every newline survives, so a stack trace still points at the real line and
// column of the real file. SECOND, THE AMBIGUOUS CASES GO THE RIGHT WAY —
// `??` is not a ternary, `{ var: 1 }` is a key and not a declaration, `a < b`
// is a comparison and not a type argument — because each of those, gone wrong,
// silently deletes running code rather than failing loudly.
//
// The last claim is the one that counts: the starter's own TypeScript plugin
// and every file it imports, stripped and parsed.
// EXPECTED_PASSES=50
import { watchClaims } from "../../tools/crash-reporter.mjs";
import { readdirSync, readFileSync, statSync } from "node:fs";
let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const { stripTypes, isTypeScript, TS_EXTENSIONS } = await import("../src/typescript.js");
const { createNodeRuntime, esmToCjs, isEsm } = await import("../src/nodejs.js");

const strip = (src) => { const r = stripTypes(src, "t.ts"); return r.ok ? r.code : `!!REFUSED ${r.error}`; };
// What survives erasure, with the blanking collapsed — the code that runs.
const code = (src) => strip(src).replace(/[ \t]+$/gm, "").replace(/[ \t]+/g, " ").trim();
const parses = (src) => {
  const r = stripTypes(src, "t.ts");
  if (!r.ok) return `refused: ${r.error}`;
  try { new Function(isEsm(r.code) ? esmToCjs(r.code, "/t.js") : r.code); return true; }
  catch (e) { return `${e.message} in: ${r.code.slice(0, 120)}`; }
};

// ── positions never move ──
{
  const src = "const a: number = 1;\nfunction f(x: string): void {}\n// tail\n";
  const r = stripTypes(src, "t.ts");
  check("erasure keeps the file the same length, so every column still points where it did",
    r.ok && r.code.length === src.length, `${r.code?.length} vs ${src.length}`);
  check("and the same lines, so a stack trace's line number is the source's line number",
    r.ok && r.code.split("\n").length === src.split("\n").length, "");
  check("and every removed character is a space, never a deletion",
    r.ok && [...r.code].every((c, i) => c === src[i] || c === " "), "");
  check("a multi-line type is blanked across all of its lines",
    code("let x: {\n a: string\n} = y;\n") === "let x\n\n = y;",
    JSON.stringify(stripTypes("let x: {\n a: string\n} = y;\n", "t.ts").code));
}

// ── what a type annotation is ──
check("a parameter's type comes off", code("function f(a: string, b: number) {}") === "function f(a , b ) {}", code("function f(a: string, b: number) {}"));
check("a variable's type comes off", code("const x: Foo<Bar> = y;") === "const x = y;", code("const x: Foo<Bar> = y;"));
check("a return type comes off", code("function f(): Promise<void> {}") === "function f() {}", code("function f(): Promise<void> {}"));
check("a class field's type and its modifiers come off",
  code("class A { private readonly n: number = 1; }") === "class A { n = 1; }", code("class A { private readonly n: number = 1; }"));
check("a class written without semicolons loses the modifier on EVERY member, not just the first",
  code("class A {\n private a = 1\n private b = 2\n}") === "class A {\n a = 1\n b = 2\n}", code("class A {\n private a = 1\n private b = 2\n}"));
check("an optional parameter loses its `?` as well as its type",
  code("function f(a?: string) {}") === "function f(a ) {}", code("function f(a?: string) {}"));
check("a declaration list annotates every declarator, not only the first",
  code("let a = 1, b: string = '2';") === "let a = 1, b = '2';", code("let a = 1, b: string = '2';"));
check("`typeof`, `keyof` and `readonly` lead a type rather than ending it",
  code("const a: typeof x.y = 1; const b: readonly T[] = []; const c: keyof T = k;")
    === "const a = 1; const b = []; const c = k;", code("const a: typeof x.y = 1; const b: readonly T[] = []; const c: keyof T = k;"));
check("a declaration on its own line is a declaration even with no semicolon above it",
  code("let a: string\nlet b: string\n") === "let a\nlet b", code("let a: string\nlet b: string\n"));

// ── the ambiguities, each of which deletes running code when it goes wrong ──
check("`??` is not a ternary: the annotations after it still come off",
  code("const a = x ?? y; const b: string = z;") === "const a = x ?? y; const b = z;", code("const a = x ?? y; const b: string = z;"));
check("`?.` and `?.[` survive untouched", code("a?.b?.[0]?.()") === "a?.b?.[0]?.()", code("a?.b?.[0]?.()"));
check("a ternary's `:` is not a return type: `f(x) ? a : b` keeps both arms",
  code("const v = t(x) ? new A(1) : new B(2);") === "const v = t(x) ? new A(1) : new B(2);", code("const v = t(x) ? new A(1) : new B(2);"));
check("`x as T` in a ternary stops at the type and leaves the `: null` arm standing",
  code("return c\n ? raw as T\n : null;") === "return c\n ? raw\n : null;", code("return c\n ? raw as T\n : null;"));
check("`{ var: 1 }` is a key, not a declaration", code("push({ var: name, type: t, interface: i });") === "push({ var: name, type: t, interface: i });", code("push({ var: name, type: t, interface: i });"));
check("`} else {` opens a block, so the declarations inside it are still declarations",
  code("if (a) { b(); } else { const c: T = d; }") === "if (a) { b(); } else { const c = d; }", code("if (a) { b(); } else { const c: T = d; }"));
check("`case X: { ... }` is a block too", code("switch (n) { default: { const e: never = n; } }") === "switch (n) { default: { const e = n; } }", code("switch (n) { default: { const e: never = n; } }"));
check("`a < b > c` is arithmetic, not a type argument list", code("if (a < b > c) {}") === "if (a < b > c) {}", code("if (a < b > c) {}"));
check("`f<T>(x)` and `new Map<K, V>()` lose their type arguments",
  code("f<T>(x); new Map<string, number>();") === "f (x); new Map ();", code("f<T>(x); new Map<string, number>();"));
check("a method reached through a dot keeps its name even when the name is a keyword",
  code("await c.delete<{ ok: boolean }>(u); const t = row.type; const i = x.as;")
    === "await c.delete (u); const t = row.type; const i = x.as;", code("await c.delete<{ ok: boolean }>(u); const t = row.type; const i = x.as;"));
check("a non-null `!` comes off and `!==` does not",
  strip("if (a!.b !== c!) d();").replace(/\s+/g, "") === "if(a.b!==c)d();", code("if (a!.b !== c!) d();"));
check("types inside a template's `${}` come off — a template is not one token",
  code("`v ${(x as any).y} ${z}`") === "`v ${(x ).y} ${z}`", code("`v ${(x as any).y} ${z}`"));
check("a type in a string is left alone, because it is a string",
  code("const s = 'const a: number = 1';") === "const s = 'const a: number = 1';", code("const s = 'const a: number = 1';"));
check("a type in a comment is left alone too", strip("// const a: number\nlet b: T;\n") === "// const a: number\nlet b   ;\n", JSON.stringify(strip("// const a: number\nlet b: T;\n")));

// ── the one rewrite erasure has to make ──
{
  // A LINE BREAK BETWEEN `)` AND `=>` IS A SYNTAX ERROR IN JAVASCRIPT, so a
  // multi-line arrow return type cannot simply be blanked: the arrow has to
  // come up to where the type was. Two characters move; the length does not.
  const src = "const f = async (): Promise<{\n a: string\n}> => {\n return x;\n};\n";
  const r = stripTypes(src, "t.ts");
  check("a multi-line arrow return type carries its `=>` up, because a newline before `=>` does not parse",
    r.ok && /\)\s*=>/.test(r.code.split("\n")[0]) && r.code.length === src.length, JSON.stringify(r.code));
  check("and the moved arrow leaves nothing behind on its old line", r.ok && parses(src) === true, parses(src));
}

// ── statements that are types ──
check("an interface is erased whole, `export` included", code("export interface A { b: string }\nx();") === "x();", code("export interface A { b: string }\nx();"));
check("a type alias is erased whole, `export` included", code("export type A = B | C;\nx();") === "x();", code("export type A = B | C;\nx();"));
check("`import type` is erased whole", code("import type { A } from './a';\nx();") === "x();", code("import type { A } from './a';\nx();"));
check("an inline `type` specifier is erased with its binding, not left importing a name that does not exist",
  code("import { type A, b } from './a';") === "import { b } from './a';", code("import { type A, b } from './a';"));
check("an overload signature is erased — a `function f(): T;` with no body is a type, and its stray `;` is not a body",
  code("export function f(a: string): number;\nexport function f(a: unknown): number { return 1; }")
    === "export function f(a ) { return 1; }", code("export function f(a: string): number;\nexport function f(a: unknown): number { return 1; }"));
check("a `this` parameter goes with its comma — it declares the callee's `this`, it is not an argument",
  code("el.on = function (this: Window, e: Event) { return e; };") === "el.on = function ( e ) { return e; };", code("el.on = function (this: Window, e: Event) { return e; };"));
check("an object key at the depth an earlier declaration used is still a key",
  code("{ const a: T = 1; }\nwrite(p, { size: stat(t).size });") === "{ const a = 1; }\nwrite(p, { size: stat(t).size });", code("{ const a: T = 1; }\nwrite(p, { size: stat(t).size });"));
check("`declare` is erased", code("declare const w: any;\nx();") === "x();", code("declare const w: any;\nx();"));
check("but `export function` and `export default` are code and stay",
  code("export default function f() {}\nexport const a = 1;") === "export default function f() {}\nexport const a = 1;", code("export default function f() {}\nexport const a = 1;"));

// ── what erasure cannot do, said by name ──
for (const [src, word] of [["enum E { A }", "enum"], ["namespace N { }", "namespace"], ["class A { constructor(private x: string) {} }", "parameter property"], ["@dec\nclass A {}", "decorator"]]) {
  const r = stripTypes(src, "p.ts");
  check(`a ${word} is refused BY NAME rather than mangled, because it needs code generated`,
    !r.ok && r.error.includes(word.split(" ")[0]) && /needs a compiler/.test(r.error), r.error ?? "accepted!");
}
check("a refusal names the file and the line, so the author can go straight there",
  /^p\.ts:2: /.test(stripTypes("const a = 1;\nenum E { A }", "p.ts").error ?? ""), stripTypes("const a = 1;\nenum E { A }", "p.ts").error);

// ── the runtime loads TypeScript, not only JavaScript ──
check("the .ts extensions are the ones a project actually writes", TS_EXTENSIONS.join(",") === ".ts,.mts,.cts" && isTypeScript("a/b.ts") && !isTypeScript("a/b.js"), TS_EXTENSIONS.join(","));
{
  const rt = createNodeRuntime({ cwd: "/w", fetch: async () => { throw new Error("no network"); } });
  rt.put("/w/dep.ts", "export interface Q { a: string }\nexport const twice = (n: number): number => n * 2;\n");
  rt.put("/w/plug.ts", 'import { twice, type Q } from "./dep.js";\nexport default async ({ cwd }: { cwd?: string }) => ({ tools: { t: { description: "d", parameters: {}, async execute(): Promise<string> { return `ok ${twice(21)}`; } } } });\n');
  const r = await rt.load(new TextDecoder().decode(rt.files.get("/w/plug.ts")), "/w/plug.ts");
  const tools = r.ok ? await r.exports.default({}) : null;
  check("a TypeScript plugin loads and its tool runs", r.ok && (await tools.tools.t.execute({})) === "ok 42", r.error ?? "");
  check("and `from './dep.js'` finds dep.ts, which is what TypeScript means by that specifier", r.ok, r.error ?? "");
}
{
  const rt = createNodeRuntime({ cwd: "/w" });
  rt.put("/w/bad.ts", "enum E { A }\n");
  const r = await rt.load("enum E { A }\n", "/w/bad.ts");
  check("a plugin the eraser refuses fails with the reason, not with a parser's confusion",
    !r.ok && /needs a compiler/.test(r.error), r.error ?? "loaded!");
}

// ── the real corpus ──
{
  // THE STARTER'S OWN TYPESCRIPT PLUGIN AND EVERY FILE IT IMPORTS. This is the
  // claim that decides whether the feature is real: these were written for
  // OpenCode by someone who had a compiler, with no thought for this.
  const root = new URL("../../../packages/starter/templates/base/.kortix/opencode/plugins", import.meta.url).pathname;
  const walk = (d) => readdirSync(d).flatMap((e) => (statSync(`${d}/${e}`).isDirectory() ? walk(`${d}/${e}`) : [`${d}/${e}`])).filter((f) => f.endsWith(".ts"));
  const files = walk(root);
  check("the starter's TypeScript plugin sources are where this claim says they are", files.length >= 10, `${files.length} files under ${root}`);
  const failed = files.map((f) => [f.split("/plugins/")[1], parses(readFileSync(f, "utf8"))]).filter(([, r]) => r !== true);
  check("every one of them strips and parses — the whole real plugin, not a sample",
    failed.length === 0, failed.slice(0, 3).map(([f, r]) => `${f}: ${r}`).join(" | "));
  const lengths = files.map((f) => { const s = readFileSync(f, "utf8"); const r = stripTypes(s, f); return r.ok && r.code.length === s.length && r.code.split("\n").length === s.split("\n").length; });
  check("and none of them moved a single character", lengths.every(Boolean), `${lengths.filter((x) => !x).length} drifted`);
}

console.log(bad ? `\n${bad} FAILED` : "\nall claims hold");
process.exit(bad ? 1 : 0);
