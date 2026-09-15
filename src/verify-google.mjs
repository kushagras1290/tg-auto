#!/usr/bin/env node
/**
 * Verifies the Google Indexing API service account is correctly configured:
 * mints an access token, then makes one read-only metadata call. Publishes
 * nothing, so it's safe to run before the service account has even been
 * added to Search Console — it's meant to answer "is it wired up yet?".
 *
 * Usage: node src/verify-google.mjs [url]
 *   (defaults to https://www.truegritin.com/)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createGoogleIndexingClient } from "./lib/google-indexing.mjs";
import { ConfigurationError, IndexingAutomationError } from "./lib/errors.mjs";

const PROJECT_ROOT = path.dirname(fileURLToPath(new URL(".", import.meta.url)));

function loadDotEnv(dotEnvPath) {
  if (!fs.existsSync(dotEnvPath)) return;
  for (const line of fs.readFileSync(dotEnvPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function main() {
  loadDotEnv(path.join(PROJECT_ROOT, ".env"));

  const testUrl = process.argv[2] ?? "https://www.truegritin.com/";
  const keyPathEnv = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  if (!keyPathEnv) {
    throw new ConfigurationError("GOOGLE_SERVICE_ACCOUNT_KEY_PATH is not set in .env");
  }
  const keyPath = path.resolve(PROJECT_ROOT, keyPathEnv);

  console.log(`Testing against: ${testUrl}`);
  console.log(`Service account key: ${keyPath}\n`);

  const client = createGoogleIndexingClient({ keyPath });

  console.log("1. Minting OAuth access token via JWT-bearer flow...");
  const { status, body } = await client.getMetadata(testUrl);
  console.log("   Token minted successfully.\n");

  console.log(`2. GET urlNotifications/metadata -> HTTP ${status}`);
  console.log(JSON.stringify(body, null, 2));
  console.log("");

  if (status === 200) {
    console.log("PASS: service account is authorized. Safe to run index:google for real.");
  } else if (status === 403) {
    console.log(
      "FAIL (403): service account is not yet an Owner on this property in Search Console.\n" +
        "Settings > Users and permissions > Add user > paste the client_email above > role Owner.",
    );
    process.exitCode = 1;
  } else if (status === 404) {
    console.log(
      "PASS (404): auth succeeded — 404 just means this URL has no notification history yet, " +
        "which is expected before the first publish call. The service account IS authorized.",
    );
  } else {
    console.log(`UNEXPECTED status ${status} — see body above.`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof IndexingAutomationError) {
    console.error(`\n${error.name}: ${error.message}`);
    if (error.body) console.error(JSON.stringify(error.body, null, 2));
    process.exitCode = 1;
  } else {
    throw error;
  }
}
