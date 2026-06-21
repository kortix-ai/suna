#!/usr/bin/env bun
import { resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { Verifier, type VerifierOptions } from "@pact-foundation/pact";

const PROVIDER_BASE_URL = (process.env.PROVIDER_BASE_URL ?? "http://localhost:8008").replace(/\/+$/, "");
const PROVIDER_VERSION = process.env.PROVIDER_VERSION ?? "dev";
const PACTS_DIR = resolve(import.meta.dir, "pacts");
const BROKER_URL = process.env.PACT_BROKER_BASE_URL;
const BROKER_TOKEN = process.env.PACT_BROKER_TOKEN;

function localPactFiles(): string[] {
  if (!existsSync(PACTS_DIR)) return [];
  return readdirSync(PACTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => resolve(PACTS_DIR, f));
}

async function main(): Promise<void> {
  const base: VerifierOptions = {
    provider: "kortix-api",
    providerBaseUrl: PROVIDER_BASE_URL,
    providerVersion: PROVIDER_VERSION,
    logLevel: "info",
    stateHandlers: {
      "the api is healthy": async () => "api is healthy",
    },
  };

  let options: VerifierOptions;
  if (BROKER_URL) {
    options = {
      ...base,
      pactBrokerUrl: BROKER_URL,
      pactBrokerToken: BROKER_TOKEN,
      publishVerificationResult: process.env.PACT_PUBLISH_VERIFICATION === "true",
      consumerVersionSelectors: [{ latest: true }],
    };
    console.log(`verifying against broker ${BROKER_URL} → provider ${PROVIDER_BASE_URL}`);
  } else {
    const pactFiles = localPactFiles();
    if (pactFiles.length === 0) {
      console.error(
        `no pact files in ${PACTS_DIR}. Run the consumer test first:\n` +
          `  bun test contract/health.consumer.pact.test.ts`,
      );
      process.exit(1);
    }
    options = { ...base, pactUrls: pactFiles };
    console.log(`verifying ${pactFiles.length} local pact(s) → provider ${PROVIDER_BASE_URL}`);
  }

  await new Verifier(options).verifyProvider();
  console.log("provider verification passed");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
