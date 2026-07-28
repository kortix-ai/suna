#!/usr/bin/env node

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(64);
}

let parsed;
try {
  parsed = new URL(databaseUrl);
} catch {
  console.error("DATABASE_URL must be a valid URL");
  process.exit(64);
}

if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
  console.error("DATABASE_URL must use the postgres or postgresql protocol");
  process.exit(64);
}

parsed.searchParams.set("uselibpqcompat", "true");
process.stdout.write(parsed.toString());
