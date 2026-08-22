import { Hono } from 'hono';
import { handleNativeOAuth2Callback } from './oauth2-store';

export const nativeOAuth2CallbackApp = new Hono();

nativeOAuth2CallbackApp.get('/callback', async (c) => {
  const result = await handleNativeOAuth2Callback(c.req.url);
  if (result.location) return c.redirect(result.location, 302);
  return c.text(result.body ?? 'OAuth2 authorization failed', result.status as 400);
});
