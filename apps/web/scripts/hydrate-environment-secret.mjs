import { pathToFileURL } from 'node:url';

const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function renderEnvironmentExports(raw, environment = process.env) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('KORTIX_ENV_JSON must contain a JSON object');
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('KORTIX_ENV_JSON must contain a JSON object');
  }

  const exports = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!ENVIRONMENT_KEY.test(key)) {
      throw new Error(`KORTIX_ENV_JSON key ${JSON.stringify(key)} is not a valid environment name`);
    }
    if (typeof value !== 'string') {
      throw new Error(`KORTIX_ENV_JSON key ${JSON.stringify(key)} must be a string`);
    }
    if (environment[key] === undefined) {
      exports.push(`export ${key}=${shellQuote(value)}`);
    }
  }
  return exports.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raw = process.env.KORTIX_ENV_JSON;
  if (raw) process.stdout.write(renderEnvironmentExports(raw));
}
