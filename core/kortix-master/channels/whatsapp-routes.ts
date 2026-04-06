/**
 * WhatsApp HTTP routes for the Kortix channels server.
 *
 * Endpoints:
 *   POST /whatsapp/qr          — Generate QR code for login
 *   POST /whatsapp/wait         — Wait for QR scan & connection
 *   GET  /whatsapp/status       — Get connection status
 *   POST /whatsapp/logout       — Disconnect and clear credentials
 *   POST /whatsapp/send         — Send a message
 */

import type { Hono } from 'hono';
import type { Context } from 'hono';
import { getWhatsAppService } from './whatsapp-service.js';

export function registerWhatsAppRoutes(app: Hono): void {
  const wa = getWhatsAppService();

  // Generate QR code
  app.post('/whatsapp/qr', async (c: Context) => {
    try {
      const body = await c.req.json().catch(() => ({})) as { force?: boolean };
      const result = await wa.startQrLogin(body.force === true);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : 'QR generation failed' }, 500);
    }
  });

  // Wait for connection after QR scan
  app.post('/whatsapp/wait', async (c: Context) => {
    try {
      const body = await c.req.json().catch(() => ({})) as { timeoutMs?: number };
      const result = await wa.waitForConnection(body.timeoutMs || 120_000);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : 'Wait failed' }, 500);
    }
  });

  // Get status
  app.get('/whatsapp/status', async (c: Context) => {
    const status = wa.getStatus();
    return c.json({ ok: true, ...status });
  });

  // Logout
  app.post('/whatsapp/logout', async (c: Context) => {
    try {
      const result = await wa.logout();
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : 'Logout failed' }, 500);
    }
  });

  // Send message
  app.post('/whatsapp/send', async (c: Context) => {
    try {
      const body = await c.req.json() as { to: string; text: string };
      if (!body.to || !body.text) return c.json({ ok: false, error: 'to and text are required' }, 400);
      await wa.sendText(body.to, body.text);
      return c.json({ ok: true, platform: 'whatsapp' });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : 'Send failed' }, 500);
    }
  });
}
