import { makeOpenApiApp } from '../../openapi';
import { type AppEnv } from '../../types';
import { z } from '@hono/zod-openapi';
import { Hono } from 'hono';

export const projectsApp = makeOpenApiApp<AppEnv>();

export const projectWebhooksApp = new Hono<AppEnv>();

// ─── Reusable OpenAPI schemas (permissive — these power the docs, not runtime
// response validation). Many handlers return large/dynamic shapes, so common
// surfaces are modeled loosely and a permissive fallback is used elsewhere. ───

export const ProjectSchema = z.object({}).passthrough().openapi('Project');

export const SessionSchema = z.object({}).passthrough().openapi('Session');

export const ChangeRequestSchema = z.object({}).passthrough().openapi('ChangeRequest');

export const SecretSchema = z.object({}).passthrough().openapi('Secret');

export const TriggerSchema = z.object({}).passthrough().openapi('Trigger');

export const AppSchema = z.object({}).passthrough().openapi('App');

export const SnapshotSchema = z.object({}).passthrough().openapi('Snapshot');

export const SandboxTemplateSchema = z.object({}).passthrough().openapi('SandboxTemplate');

export const AccessMemberSchema = z.object({}).passthrough().openapi('AccessMember');

export const GroupGrantSchema = z.object({}).passthrough().openapi('GroupGrant');

export const CommitSchema = z.object({}).passthrough().openapi('Commit');

export const AnyObject = z.record(z.string(), z.any());
