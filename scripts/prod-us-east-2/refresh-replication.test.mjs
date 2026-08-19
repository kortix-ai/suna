import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync(
  new URL("./refresh-replication.sh", import.meta.url),
  "utf8",
);

test("captures cumulative error counters before refreshing the subscription", () => {
  const baseline = script.indexOf(
    "read -r baseline_apply_errors baseline_sync_errors",
  );
  const refresh = script.indexOf("ALTER SUBSCRIPTION %I REFRESH PUBLICATION");

  assert.ok(baseline >= 0);
  assert.ok(refresh > baseline);
});

test("rejects only replication errors added by the current refresh", () => {
  assert.match(script, /"\$apply_errors" -gt "\$baseline_apply_errors"/);
  assert.match(script, /"\$sync_errors" -gt "\$baseline_sync_errors"/);
  assert.doesNotMatch(script, /"\$sync_errors" != "0"/);
});

test("requires an enabled target subscription before changing the publication", () => {
  const missingSubscription = script.indexOf(
    "The enabled target subscription is missing.",
  );
  const sourcePublicationChange = script.indexOf(
    'psql "$SOURCE_DATABASE_URL"',
    missingSubscription,
  );

  assert.ok(missingSubscription >= 0);
  assert.ok(sourcePublicationChange > missingSubscription);
});
