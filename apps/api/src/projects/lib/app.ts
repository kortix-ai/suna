import { makeOpenApiApp } from '../../openapi';
import { type AppEnv } from '../../types';
import {
  OkResponseSchema as ContractOkResponseSchema,
  ProjectSchema as ContractProjectSchema,
  ProjectSessionSchema as ContractProjectSessionSchema,
  SecretSchema as ContractSecretSchema,
  SessionCreateAcceptedSchema as ContractSessionCreateAcceptedSchema,
  SessionStartResultSchema as ContractSessionStartResultSchema,
  TriggerSchema as ContractTriggerSchema,
} from '@kortix/api-contract';
import { z } from '@hono/zod-openapi';
import { Hono } from 'hono';

export const projectsApp = makeOpenApiApp<AppEnv>();

export const projectWebhooksApp = new Hono<AppEnv>();

// ─── Reusable OpenAPI schemas (these power the docs, not runtime response
// validation). Core project-domain surfaces come from @kortix/api-contract —
// the shared wire contract — while large/dynamic shapes are still modeled
// loosely with a permissive fallback. ───

export const ProjectSchema = ContractProjectSchema.openapi('Project');

export const SessionSchema = ContractProjectSessionSchema.openapi('Session');

export const SessionStartResultSchema = ContractSessionStartResultSchema.openapi('SessionStartResult');

export const SessionCreateAcceptedSchema = ContractSessionCreateAcceptedSchema.openapi('SessionCreateAccepted');

export const OkSchema = ContractOkResponseSchema.openapi('Ok');

export const ChangeRequestSchema = z.object({}).passthrough().openapi('ChangeRequest');

export const SecretSchema = ContractSecretSchema.openapi('Secret');

export const TriggerSchema = ContractTriggerSchema.openapi('Trigger');

export const AppSchema = z.object({}).passthrough().openapi('App');

export const SnapshotSchema = z.object({}).passthrough().openapi('Snapshot');

export const SandboxTemplateSchema = z.object({}).passthrough().openapi('SandboxTemplate');

export const AccessMemberSchema = z.object({}).passthrough().openapi('AccessMember');

export const GroupGrantSchema = z.object({}).passthrough().openapi('GroupGrant');

export const CommitSchema = z.object({}).passthrough().openapi('Commit');

export const AnyObject = z.record(z.string(), z.any());
