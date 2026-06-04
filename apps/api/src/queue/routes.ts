/**
 * Message queue API routes.
 *
 * Mounted at /v1/queue/* — provides CRUD operations for the
 * persistent message queue. The frontend syncs every mutation
 * here so queued messages survive page reloads.
 *
 * Routes:
 *   GET    /v1/queue/sessions/:sessionId   — list queued messages for a session
 *   GET    /v1/queue/all                   — list all queued messages (all sessions)
 *   POST   /v1/queue/sessions/:sessionId   — enqueue a new message
 *   DELETE /v1/queue/messages/:messageId   — remove a specific message
 *   POST   /v1/queue/messages/:messageId/move-up    — move message up in queue
 *   POST   /v1/queue/messages/:messageId/move-down  — move message down in queue
 *   DELETE /v1/queue/sessions/:sessionId   — clear all messages for a session
 *   GET    /v1/queue/status                — drainer status
 */

import { createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../types';
import * as storage from './storage';
import { isDrainerRunning } from './drainer';
import { makeOpenApiApp, json, errors, auth, ErrorSchema } from '../openapi';

export const queueApp = makeOpenApiApp<AppEnv>();

// ─── List messages for a session ─────────────────────────────────────────────

queueApp.openapi(
  createRoute({
    method: 'get',
    path: '/sessions/{sessionId}',
    tags: ['queue'],
    summary: 'List queued messages for a session',
    ...auth,
    request: { params: z.object({ sessionId: z.string() }) },
    responses: {
      200: json(z.object({ messages: z.array(z.any()) }), 'Queued messages for the session'),
      ...errors(401),
    },
  }),
  async (c: any) => {
    const sessionId = c.req.param('sessionId');
    const messages = storage.getSessionQueue(sessionId);
    return c.json({ messages });
  },
);

// ─── List all queued messages ────────────────────────────────────────────────

queueApp.openapi(
  createRoute({
    method: 'get',
    path: '/all',
    tags: ['queue'],
    summary: 'List all queued messages (all sessions)',
    ...auth,
    responses: {
      200: json(z.object({ messages: z.any() }), 'All queued messages'),
      ...errors(401),
    },
  }),
  async (c: any) => {
    const messages = storage.getAllQueues();
    return c.json({ messages });
  },
);

// ─── Enqueue a new message ───────────────────────────────────────────────────

queueApp.openapi(
  createRoute({
    method: 'post',
    path: '/sessions/{sessionId}',
    tags: ['queue'],
    summary: 'Enqueue a new message for a session',
    ...auth,
    request: {
      params: z.object({ sessionId: z.string() }),
      body: { content: { 'application/json': { schema: z.object({ text: z.string(), id: z.string().optional() }) } } },
    },
    responses: {
      201: json(z.object({ message: z.any() }), 'The enqueued message'),
      400: json(ErrorSchema, 'Bad request'),
      ...errors(401),
    },
  }),
  async (c: any) => {
    const sessionId = c.req.param('sessionId');
    const body = await c.req.json();

    if (!body?.text || typeof body.text !== 'string') {
      return c.json({ error: 'Missing or invalid "text" field' }, 400);
    }

    const msg = storage.enqueue(sessionId, body.text.trim(), body.id);
    return c.json({ message: msg }, 201);
  },
);

// ─── Remove a specific message ───────────────────────────────────────────────

queueApp.openapi(
  createRoute({
    method: 'delete',
    path: '/messages/{messageId}',
    tags: ['queue'],
    summary: 'Remove a specific queued message',
    ...auth,
    request: {
      params: z.object({ messageId: z.string() }),
      query: z.object({ sessionId: z.string().optional() }),
    },
    responses: {
      200: json(z.object({ ok: z.boolean() }), 'Removal result'),
      404: json(ErrorSchema, 'Not found'),
      ...errors(401),
    },
  }),
  async (c: any) => {
    const messageId = c.req.param('messageId');
    const sessionId = c.req.query('sessionId');
    const removed = storage.remove(messageId, sessionId || undefined);
    if (!removed) {
      return c.json({ error: 'Message not found' }, 404);
    }
    return c.json({ ok: true });
  },
);

// ─── Move message up ─────────────────────────────────────────────────────────

queueApp.openapi(
  createRoute({
    method: 'post',
    path: '/messages/{messageId}/move-up',
    tags: ['queue'],
    summary: 'Move a queued message up in the queue',
    ...auth,
    request: {
      params: z.object({ messageId: z.string() }),
      body: { content: { 'application/json': { schema: z.object({ sessionId: z.string() }) } } },
    },
    responses: {
      200: json(z.object({ ok: z.boolean() }), 'Move result'),
      400: json(ErrorSchema, 'Bad request'),
      ...errors(401),
    },
  }),
  async (c: any) => {
    const messageId = c.req.param('messageId');
    const body = await c.req.json();
    if (!body?.sessionId) {
      return c.json({ error: 'Missing sessionId' }, 400);
    }
    const moved = storage.moveUp(messageId, body.sessionId);
    if (!moved) {
      return c.json({ error: 'Cannot move up (already first or not found)' }, 400);
    }
    return c.json({ ok: true });
  },
);

// ─── Move message down ──────────────────────────────────────────────────────

queueApp.openapi(
  createRoute({
    method: 'post',
    path: '/messages/{messageId}/move-down',
    tags: ['queue'],
    summary: 'Move a queued message down in the queue',
    ...auth,
    request: {
      params: z.object({ messageId: z.string() }),
      body: { content: { 'application/json': { schema: z.object({ sessionId: z.string() }) } } },
    },
    responses: {
      200: json(z.object({ ok: z.boolean() }), 'Move result'),
      400: json(ErrorSchema, 'Bad request'),
      ...errors(401),
    },
  }),
  async (c: any) => {
    const messageId = c.req.param('messageId');
    const body = await c.req.json();
    if (!body?.sessionId) {
      return c.json({ error: 'Missing sessionId' }, 400);
    }
    const moved = storage.moveDown(messageId, body.sessionId);
    if (!moved) {
      return c.json({ error: 'Cannot move down (already last or not found)' }, 400);
    }
    return c.json({ ok: true });
  },
);

// ─── Clear all messages for a session ────────────────────────────────────────

queueApp.openapi(
  createRoute({
    method: 'delete',
    path: '/sessions/{sessionId}',
    tags: ['queue'],
    summary: 'Clear all queued messages for a session',
    ...auth,
    request: { params: z.object({ sessionId: z.string() }) },
    responses: {
      200: json(z.object({ ok: z.boolean() }), 'Clear result'),
      ...errors(401),
    },
  }),
  async (c: any) => {
    const sessionId = c.req.param('sessionId');
    storage.clearSession(sessionId);
    return c.json({ ok: true });
  },
);

// ─── Drainer status ──────────────────────────────────────────────────────────

queueApp.openapi(
  createRoute({
    method: 'get',
    path: '/status',
    tags: ['queue'],
    summary: 'Get the queue drainer status',
    ...auth,
    responses: {
      200: json(z.object({ drainerRunning: z.boolean() }), 'Drainer status'),
      ...errors(401),
    },
  }),
  async (c: any) => {
    return c.json({
      drainerRunning: isDrainerRunning(),
    });
  },
);
