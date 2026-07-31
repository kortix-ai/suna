#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

export const EXPECTED_PRODUCTION_SUPABASE_PROJECT_REF = 'jbriwassebxdwoieikga';
export const EXPECTED_PRODUCTION_SUPABASE_URL = 'https://supa.kortix.com';
export const EXPECTED_PRODUCTION_BACKEND_URL = 'https://api.kortix.com/v1';

const EXPECTED_NATIVE_URL = `https://${EXPECTED_PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co`;
const ALLOWED_PRODUCTION_URLS = new Set([EXPECTED_PRODUCTION_SUPABASE_URL, EXPECTED_NATIVE_URL]);
const URL_VARIABLES = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'KORTIX_PUBLIC_SUPABASE_URL',
  'SUPABASE_PUBLIC_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVER_URL',
];
const KEY_VARIABLES = [
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'KORTIX_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_ANON_KEY',
];

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for a Vercel production build`);
  }
  return value;
}

function normalizeUrl(value) {
  return value.replace(/\/+$/, '');
}

function decodeJwtPayload(value) {
  const parts = value.split('.');
  if (parts.length !== 3) return null;

  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('production Supabase anon key has an invalid JWT payload');
  }
}

async function assertSupabaseAcceptsKey(url, key, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${url}/auth/v1/settings`, {
      headers: {
        apikey: key,
        'user-agent': 'kortix-production-supabase-release-guard',
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`Supabase validation request failed for ${url}: ${error.message}`);
  }

  if (!response.ok) {
    throw new Error(`Supabase validation failed with HTTP ${response.status} for ${url}`);
  }
}

export async function validateProductionSupabaseEnv(env, { fetchImpl = globalThis.fetch } = {}) {
  if (env.VERCEL_ENV !== 'production') {
    return { skipped: true };
  }

  const publicUrl = normalizeUrl(required(env, 'NEXT_PUBLIC_SUPABASE_URL'));
  const publicKey = required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');

  for (const name of URL_VARIABLES) {
    const rawValue = env[name]?.trim();
    if (!rawValue) continue;
    const value = normalizeUrl(rawValue);
    if (!ALLOWED_PRODUCTION_URLS.has(value)) {
      throw new Error(
        `${name} must be ${EXPECTED_PRODUCTION_SUPABASE_URL} or the native EU project URL`,
      );
    }
  }

  if (!ALLOWED_PRODUCTION_URLS.has(publicUrl)) {
    throw new Error(
      `NEXT_PUBLIC_SUPABASE_URL must be ${EXPECTED_PRODUCTION_SUPABASE_URL} or the native EU project URL`,
    );
  }

  const configuredKeys = KEY_VARIABLES.map((name) => env[name]?.trim()).filter(Boolean);
  if (new Set(configuredKeys).size !== 1) {
    throw new Error('production Supabase anon-key variables must contain one identical value');
  }

  const payload = decodeJwtPayload(publicKey);
  if (payload) {
    if (payload.ref !== EXPECTED_PRODUCTION_SUPABASE_PROJECT_REF) {
      throw new Error(
        `anon key project ref ${payload.ref ?? 'missing'} does not match required production ref ${EXPECTED_PRODUCTION_SUPABASE_PROJECT_REF}`,
      );
    }
    if (payload.role !== 'anon') {
      throw new Error(
        `Supabase public key role must be anon, received ${payload.role ?? 'missing'}`,
      );
    }
  }

  const validationUrls = [...new Set([publicUrl, EXPECTED_NATIVE_URL])];
  for (const url of validationUrls) {
    await assertSupabaseAcceptsKey(url, publicKey, fetchImpl);
  }

  return {
    skipped: false,
    projectRef: payload?.ref ?? EXPECTED_PRODUCTION_SUPABASE_PROJECT_REF,
    supabaseUrl: publicUrl,
  };
}

export function parseRuntimeConfigScript(source) {
  const startMarker = 'window.__KORTIX_RUNTIME_CONFIG=';
  const endMarker = ';window.__RUNTIME_ENV=';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start === -1 || end === -1) {
    throw new Error('runtime config response does not contain the expected bootstrap script');
  }

  try {
    return JSON.parse(source.slice(start + startMarker.length, end));
  } catch {
    throw new Error('runtime config response contains invalid JSON');
  }
}

export async function validateDeployedProductionSupabase(
  runtimeUrl,
  { expectedVersion, fetchImpl = globalThis.fetch } = {},
) {
  const response = await fetchImpl(runtimeUrl, {
    headers: {
      'cache-control': 'no-cache',
      'user-agent': 'kortix-production-supabase-release-guard',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`runtime config returned HTTP ${response.status}`);
  }

  const config = parseRuntimeConfigScript(await response.text());
  if (expectedVersion && config.VERSION !== expectedVersion) {
    throw new Error(
      `runtime config version ${config.VERSION ?? 'missing'} does not match release ${expectedVersion}`,
    );
  }
  if (config.BACKEND_URL !== EXPECTED_PRODUCTION_BACKEND_URL) {
    throw new Error(
      `runtime config backend ${config.BACKEND_URL ?? 'missing'} does not match ${EXPECTED_PRODUCTION_BACKEND_URL}`,
    );
  }

  return validateProductionSupabaseEnv(
    {
      VERCEL_ENV: 'production',
      NEXT_PUBLIC_SUPABASE_URL: config.SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: config.SUPABASE_ANON_KEY,
    },
    { fetchImpl },
  );
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function validateDeployedWithRetry(runtimeUrl, expectedVersion) {
  const attempts = Number(readArgument('--attempts') ?? 30);
  const intervalMs = Number(readArgument('--interval-ms') ?? 20_000);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await validateDeployedProductionSupabase(runtimeUrl, {
        expectedVersion,
      });
      console.log(
        `Production frontend guard passed for ${result.projectRef} at ${result.supabaseUrl}.`,
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.log(
          `Production frontend guard attempt ${attempt}/${attempts} is not ready: ${error.message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
  }

  throw lastError;
}

async function main() {
  const runtimeUrl = readArgument('--runtime-url');
  if (runtimeUrl) {
    await validateDeployedWithRetry(runtimeUrl, readArgument('--expected-version'));
    return;
  }

  const result = await validateProductionSupabaseEnv(process.env);
  if (result.skipped) {
    console.log('Production Supabase release guard skipped outside Vercel production.');
    return;
  }

  console.log(
    `Production Supabase release guard passed for ${result.projectRef} at ${result.supabaseUrl}.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Production Supabase release guard failed: ${error.message}`);
    process.exitCode = 1;
  });
}
