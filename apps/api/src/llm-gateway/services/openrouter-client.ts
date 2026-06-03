interface OpenRouterRequestOpts {
  baseUrl: string;
  apiKey: string;
  appName?: string;
  appReferer?: string;
}

export async function callOpenRouter(
  body: Record<string, unknown>,
  opts: OpenRouterRequestOpts,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${opts.apiKey}`,
  };
  if (opts.appName) headers['x-title'] = opts.appName;
  if (opts.appReferer) headers['http-referer'] = opts.appReferer;

  return fetch(`${opts.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

export async function listOpenRouterModels(opts: OpenRouterRequestOpts): Promise<Response> {
  return fetch(`${opts.baseUrl}/models`, {
    method: 'GET',
    headers: { authorization: `Bearer ${opts.apiKey}` },
  });
}
