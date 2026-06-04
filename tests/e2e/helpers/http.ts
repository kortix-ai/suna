export function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export async function json<T>(
  response: Response,
  expectedStatus: number | number[] = 200,
): Promise<T> {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const body = await response.text();
  if (!expected.includes(response.status)) {
    throw new Error(
      `Expected ${expected.join('/')} from ${response.url}, got ${response.status}: ${body}`,
    );
  }
  return body ? JSON.parse(body) as T : ({} as T);
}

export async function apiStatus(
  apiBase: string,
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<number> {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: authHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await response.text();
  return response.status;
}

export function createApiStatusClient(apiBase: string) {
  return (
    token: string,
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<number> => apiStatus(apiBase, token, method, path, body);
}

export async function apiJson<T>(
  apiBase: string,
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  expectedStatus: number | number[] = 200,
): Promise<T> {
  return json<T>(
    await fetch(`${apiBase}${path}`, {
      method,
      headers: authHeaders(token),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    expectedStatus,
  );
}

export function createApiJsonClient(apiBase: string) {
  return <T>(
    token: string,
    method: string,
    path: string,
    body?: Record<string, unknown>,
    expectedStatus: number | number[] = 200,
  ): Promise<T> => apiJson<T>(apiBase, token, method, path, body, expectedStatus);
}

export async function apiResult<T>(
  apiBase: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T | null }> {
  let response: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(`${apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  if (!response) throw lastError;

  const text = await response.text();
  let parsed: T | null = null;
  try {
    parsed = text ? (JSON.parse(text) as T) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, json: parsed };
}

export function createApiResultClient(apiBase: string) {
  return <T>(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: T | null }> => apiResult<T>(apiBase, token, method, path, body);
}
