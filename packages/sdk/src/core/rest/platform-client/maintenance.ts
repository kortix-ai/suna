interface MaintenanceRequestOptions {
  backendUrl: string;
  accessToken?: string | null;
  signal?: AbortSignal;
  cache?: RequestCache;
  next?: { revalidate?: number | false; tags?: string[] };
  headers?: HeadersInit;
}

function apiBase(backendUrl: string): string {
  const trimmed = backendUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

async function requestJson<T>(
  path: string,
  options: MaintenanceRequestOptions,
  init?: { method: "PUT"; body: T },
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (init) headers.set("Content-Type", "application/json");
  if (options.accessToken) {
    headers.set("Authorization", `Bearer ${options.accessToken}`);
  }

  const response = await fetch(`${apiBase(options.backendUrl)}${path}`, {
    method: init?.method ?? "GET",
    headers,
    ...(init ? { body: JSON.stringify(init.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.cache ? { cache: options.cache } : {}),
    ...(options.next ? { next: options.next } : {}),
  } as RequestInit);

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && typeof body.error === "string"
        ? body.error
        : response.statusText || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export function getMaintenanceConfig<T>(
  options: MaintenanceRequestOptions,
): Promise<T> {
  return requestJson<T>("/system/maintenance", options);
}

export function setMaintenanceConfig<T>(
  config: T,
  options: MaintenanceRequestOptions,
): Promise<T> {
  return requestJson<T>("/system/maintenance", options, {
    method: "PUT",
    body: config,
  });
}

export function getUserRolesWithToken<T = unknown[]>(
  options: MaintenanceRequestOptions,
): Promise<T> {
  return requestJson<T>("/user-roles", options);
}
