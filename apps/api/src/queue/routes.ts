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

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import * as storage from './storage';
import { isDrainerRunning } from './drainer';

export const queueApp = new Hono<AppEnv>();

// ─── List messages for a session ─────────────────────────────────────────────

queueApp.get('/sessions/:sessionId', (c) => {
  const sessionId = c.req.param('sessionId');
  const messages = storage.getSessionQueue(sessionId);
  return c.json({ messages });
});

// ─── List all queued messages ────────────────────────────────────────────────

queueApp.get('/all', (c) => {
  const messages = storage.getAllQueues();
  return c.json({ messages });
});

// ─── Enqueue a new message ───────────────────────────────────────────────────

queueApp.post('/sessions/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  const body = await c.req.json<{ text: string; id?: string }>();

  if (!body?.text || typeof body.text !== 'string') {
    return c.json({ error: 'Missing or invalid "text" field' }, 400);
  }

  const msg = storage.enqueue(sessionId, body.text.trim(), body.id);
  return c.json({ message: msg }, 201);
});

// ─── Remove a specific message ───────────────────────────────────────────────

queueApp.delete('/messages/:messageId', (c) => {
  const messageId = c.req.param('messageId');
  const sessionId = c.req.query('sessionId');
  const removed = storage.remove(messageId, sessionId || undefined);
  if (!removed) {
    return c.json({ error: 'Message not found' }, 404);
  }
  return c.json({ ok: true });
});

// ─── Move message up ─────────────────────────────────────────────────────────

queueApp.post('/messages/:messageId/move-up', async (c) => {
  const messageId = c.req.param('messageId');
  const body = await c.req.json<{ sessionId: string }>();
  if (!body?.sessionId) {
    return c.json({ error: 'Missing sessionId' }, 400);
  }
  const moved = storage.moveUp(messageId, body.sessionId);
  if (!moved) {
    return c.json({ error: 'Cannot move up (already first or not found)' }, 400);
  }
  return c.json({ ok: true });
});

// ─── Move message down ──────────────────────────────────────────────────────

queueApp.post('/messages/:messageId/move-down', async (c) => {
  const messageId = c.req.param('messageId');
  const body = await c.req.json<{ sessionId: string }>();
  if (!body?.sessionId) {
    return c.json({ error: 'Missing sessionId' }, 400);
  }
  const moved = storage.moveDown(messageId, body.sessionId);
  if (!moved) {
    return c.json({ error: 'Cannot move down (already last or not found)' }, 400);
  }
  return c.json({ ok: true });
});

// ─── Clear all messages for a session ────────────────────────────────────────

queueApp.delete('/sessions/:sessionId', (c) => {
  const sessionId = c.req.param('sessionId');
  storage.clearSession(sessionId);
  return c.json({ ok: true });
});

// ─── Drainer status ──────────────────────────────────────────────────────────

queueApp.get('/status', (c) => {
  return c.json({
    drainerRunning: isDrainerRunning(),
  });
});
