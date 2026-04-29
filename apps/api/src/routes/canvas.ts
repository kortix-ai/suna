/**
 * Canvas event routes.
 *
 * Mounted at /v1/canvas/*
 *
 * Routes:
 *   POST /v1/canvas/:sessionId          — store a canvas event (called by kortix-master git hook)
 *   GET  /v1/canvas/:sessionId          — list all canvas events for a session
 *   DELETE /v1/canvas/:sessionId        — clear canvas events for a session
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { storeCanvasEvent, getCanvasEvents, clearCanvasEvents } from '../canvas/store';
import type { CanvasMessage } from '../canvas/types';

export const canvasApp = new Hono<AppEnv>();

// ─── POST /v1/canvas/:sessionId ───────────────────────────────────────────────
// Internal endpoint: called by kortix-master when a canvas event is ready.
// Auth is handled at the route level (combinedAuth); internal callers use
// INTERNAL_SERVICE_KEY bearer token.

canvasApp.post('/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');

  let message: CanvasMessage;
  try {
    message = await c.req.json<CanvasMessage>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!message || message.type !== 'canvas' || !message.kind || !message.id) {
    return c.json({ error: 'Invalid canvas message: missing type, kind, or id' }, 400);
  }

  storeCanvasEvent(sessionId, message);

  return c.json({ ok: true, stored: true }, 201);
});

// ─── GET /v1/canvas/:sessionId ────────────────────────────────────────────────

canvasApp.get('/:sessionId', (c) => {
  const sessionId = c.req.param('sessionId');
  const events = getCanvasEvents(sessionId);
  return c.json({ events });
});

// ─── DELETE /v1/canvas/:sessionId ────────────────────────────────────────────

canvasApp.delete('/:sessionId', (c) => {
  const sessionId = c.req.param('sessionId');
  clearCanvasEvents(sessionId);
  return c.json({ ok: true });
});
