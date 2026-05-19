import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { getChannelsBot, getChannelsModeReport, isChannelsConfigured } from './bot';
import { manifestRoutes } from './manifest-routes';

export const channelsApp = new Hono<AppEnv>();

channelsApp.get('/health', (c) => {
  const report = getChannelsModeReport();
  return c.json({
    configured: isChannelsConfigured(),
    platforms: ['slack'],
    mode: report.mode,
    flag: report.flag,
    single_ready: report.singleReady,
    multi_ready: report.multiReady,
    errors: report.errors,
  });
});

channelsApp.post('/slack', async (c) => {
  const bot = getChannelsBot();
  if (!bot) return c.json({ error: 'channels not configured', report: getChannelsModeReport() }, 503);
  return bot.webhooks.slack(c.req.raw);
});

channelsApp.route('/slack', manifestRoutes);
