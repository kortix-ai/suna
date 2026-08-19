/**
 * /v1/skills — the kortix-managed system skills, served over HTTP.
 *
 * The point: an OpenCode agent holding only the `kortix` binary and a token can
 * discover and read everything it needs to drive Kortix. No repo checkout, no
 * baked sandbox image. `kortix skills` /
 * `kortix skills get <name>` are thin wrappers over these two routes.
 *
 * SHAPE — list + fetch, not one overloaded endpoint, because an agent pays tokens
 * for whatever it reads:
 *   GET /v1/skills                       ~7 KB — every skill's name + frontmatter
 *                                        description (the "load this when…"
 *                                        trigger). No bodies.
 *   GET /v1/skills/{name}                the complete SKILL.md text, plus the
 *                                        paths of its reference files.
 *   GET /v1/skills/{name}?full=1         …with every reference file inlined. Opt-in:
 *                                        kortix-system's full tree is ~230 KB.
 *   GET /v1/skills/{name}/file?path=…    one reference file on its own.
 *
 * Frontmatter is parsed server-side (see catalog.ts) precisely so the list is
 * decision-grade without downloading a single body.
 *
 * AUTH — `combinedAuth`, the same gate the rest of the CLI surface uses. These are
 * operating instructions for Kortix, not secrets, but they are not public either:
 * they enumerate internal endpoints, token families, and connector plumbing, so
 * they stay behind a token rather than becoming an anonymous crawl target. Using
 * combinedAuth (rather than supabaseAuth) is what makes the two callers that
 * matter work with no new auth scheme: the CLI holding a `kortix_pat_`, and an
 * in-sandbox agent holding the platform-injected `KORTIX_CLI_TOKEN` session PAT.
 * Content is identical for every caller —
 * this is authentication, not authorization; no account scoping applies.
 */

import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';
import { getManagedSkill, getManagedSkillFile, listManagedSkills } from './catalog';

export const skillsApp = makeOpenApiApp<AppEnv>();

const SkillSummarySchema = z
  .object({
    name: z.string(),
    description: z.string(),
    referenceCount: z.number().int(),
    bytes: z.number().int(),
  })
  .openapi('ManagedSkillSummary');

const SkillReferenceSchema = z
  .object({
    path: z.string(),
    bytes: z.number().int(),
    content: z.string().optional(),
  })
  .openapi('ManagedSkillReference');

const SkillDetailSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    body: z.string(),
    references: z.array(SkillReferenceSchema),
  })
  .openapi('ManagedSkill');

const SkillNameParams = z.object({ name: z.string() });

skillsApp.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['skills'],
    summary: 'GET /skills — list the Kortix system skills',
    description:
      'Name + description for every kortix-managed system skill. Bodies are not ' +
      'included; fetch one with GET /v1/skills/{name}.',
    ...auth,
    responses: {
      200: json(
        z.object({ skills: z.array(SkillSummarySchema), count: z.number().int() }),
        'Kortix system skills',
      ),
      ...errors(401),
    },
  }),
  (c) => {
    const skills = listManagedSkills();
    return c.json({ skills, count: skills.length });
  },
);

skillsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{name}/file',
    tags: ['skills'],
    summary: "GET /skills/:name/file?path=… — one of a skill's reference files",
    ...auth,
    request: {
      params: SkillNameParams,
      query: z.object({ path: z.string() }),
    },
    responses: {
      200: json(
        z.object({ name: z.string(), path: z.string(), content: z.string() }),
        'Reference file content',
      ),
      ...errors(400, 401, 404),
    },
  }),
  (c) => {
    const name = c.req.param('name');
    const path = c.req.query('path');
    if (!path) return c.json({ error: true, message: 'path is required', status: 400 }, 400);
    const file = getManagedSkillFile(name, path);
    if (!file) {
      return c.json(
        { error: true, message: `No file "${path}" in Kortix skill "${name}"`, status: 404 },
        404,
      );
    }
    return c.json({ name, path: file.path, content: file.content });
  },
);

skillsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{name}',
    tags: ['skills'],
    summary: 'GET /skills/:name — the full SKILL.md body',
    description:
      'The complete markdown the agent is meant to follow. `?full=1` also inlines ' +
      'every reference file (large — kortix-system is ~230 KB with references).',
    ...auth,
    request: {
      params: SkillNameParams,
      query: z.object({ full: z.string().optional() }),
    },
    responses: {
      200: json(SkillDetailSchema, 'Skill body'),
      ...errors(401, 404),
    },
  }),
  (c) => {
    const name = c.req.param('name');
    const skill = getManagedSkill(name);
    if (!skill) {
      return c.json(
        { error: true, message: `No Kortix system skill named "${name}"`, status: 404 },
        404,
      );
    }
    const full = c.req.query('full');
    const inline = full === '1' || full === 'true';
    return c.json({
      name: skill.name,
      description: skill.description,
      body: skill.body,
      references: skill.references.map((f) => ({
        path: f.path,
        bytes: f.content.length,
        ...(inline ? { content: f.content } : {}),
      })),
    });
  },
);
