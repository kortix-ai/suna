const UTILITY_APP_SLUGS = new Set([
  'pipedream_utils',
  'schedule',
  'http',
  'formatting',
  'helper_functions',
  'data_stores',
  'sse',
  'delay',
  'filter',
  'end',
  'throw_error',
  'only_continue',
  'code',
  'rss',
  'pipedream',
  'go',
  'node',
  'python',
  'bash',
]);

const NATIVE_APP_SLUGS = new Set(['slack', 'slack_bot']);

export function isPipedreamOAuthApp<T extends { slug: string; authType: string | null }>(
  app: T,
): app is T & { authType: 'oauth' } {
  if (UTILITY_APP_SLUGS.has(app.slug)) return false;
  if (NATIVE_APP_SLUGS.has(app.slug)) return false;
  return app.authType === 'oauth';
}
