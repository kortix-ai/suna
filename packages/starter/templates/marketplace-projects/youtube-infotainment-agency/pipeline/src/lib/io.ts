import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import type { z } from "zod";

export function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, data: unknown) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

export function readYaml<T = unknown>(path: string): T {
  return YAML.parse(readFileSync(path, "utf8")) as T;
}

export function writeYaml(path: string, data: unknown) {
  ensureDir(dirname(path));
  writeFileSync(path, YAML.stringify(data, { lineWidth: 100 }));
}

export function writeText(path: string, text: string) {
  ensureDir(dirname(path));
  writeFileSync(path, text);
}

/** Parse a file against a zod schema, with an error message that names the file and the field. */
export function load<S extends z.ZodType>(schema: S, path: string): z.infer<S> {
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  const raw = path.endsWith(".yaml") || path.endsWith(".yml") ? readYaml(path) : readJson(path);
  const res = schema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`${path} is invalid:\n${issues}`);
  }
  return res.data;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

export const round = (n: number, places = 3) => Math.round(n * 10 ** places) / 10 ** places;
