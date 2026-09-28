import { optStr } from "./env-schema-helpers";
export const observabilitySchema = {
  BETTERSTACK_API_LOG_TOKEN: optStr, // Logtail source token for structured logs
  BETTERSTACK_API_LOG_HOST: optStr, // Logtail ingesting host (e.g. s1234.us-east-9.betterstackdata.com)
  BETTERSTACK_API_SENTRY_DSN: optStr, // Sentry DSN for error tracking (Better Stack compatible)
  CORS_ALLOWED_ORIGINS: optStr,
  KORTIX_MASTER_URL: optStr,
  OPENCODE_URL: optStr,
  KORTIX_DATA_DIR: optStr,
};
