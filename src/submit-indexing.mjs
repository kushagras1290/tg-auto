#!/usr/bin/env node
/**
 * Submits truegritin.com storefront URLs to search-engine indexing APIs.
 *
 * Usage:
 *   node src/submit-indexing.mjs --engine=google|indexnow|all [options]
 *
 * Options:
 *   --engine=<name>   google | indexnow | all              (required)
 *   --input=<path>    CSV of type,url rows                  (default: data/urls.csv)
 *   --types=<list>    comma-separated type filter, e.g. products,categories
 *   --limit=<n>       cap on URLs submitted this run
 *   --dry-run         validate config and print the plan, submit nothing
 *   --force           ignore the 7-day resubmission cooldown
 *
 * Required environment (see .env.example):
 *   Google : GOOGLE_SERVICE_ACCOUNT_KEY_PATH, GOOGLE_DAILY_QUOTA
 *   IndexNow: INDEXNOW_KEY, SITE_HOST
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createGoogleIndexingClient } from "./lib/google-indexing.mjs";
import { createIndexNowClient } from "./lib/indexnow.mjs";
import { createLogger } from "./lib/logger.mjs";
import { ConfigurationError, GoogleApiError, IndexingAutomationError } from "./lib/errors.mjs";
import { withRetry } from "./lib/retry.mjs";
import { createStateStore } from "./lib/state-store.mjs";
import { readUrlsCsv } from "./lib/urls-csv.mjs";

const PROJECT_ROOT = path.dirname(fileURLToPath(new URL(".", import.meta.url)));
const GOOGLE_REQUEST_INTERVAL_MS = 1000; // stay well under Google's burst limits

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

/** @returns {{ engine: "google" | "indexnow" | "all", input: string, types: string[] | null, limit: number | null, dryRun: boolean, force: boolean }} */
function parseArgs(argv) {
  const args = { engine: null, input: "data/urls.csv", types: null, limit: null, dryRun: false, force: false };
  for (const raw of argv) {
    if (raw === "--dry-run") args.dryRun = true;
    else if (raw === "--force") args.force = true;
    else if (raw.startsWith("--engine=")) args.engine = raw.slice("--engine=".length);
    else if (raw.startsWith("--input=")) args.input = raw.slice("--input=".length);
    else if (raw.startsWith("--types=")) args.types = raw.slice("--types=".length).split(",").map((t) => t.trim());
    else if (raw.startsWith("--limit=")) args.limit = Number.parseInt(raw.slice("--limit=".length), 10);
    else throw new ConfigurationError(`Unrecognized argument: ${raw}`);
  }
  if (!["google", "indexnow", "all"].includes(args.engine)) {
    throw new ConfigurationError('--engine=google|indexnow|all is required');
  }
  if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit <= 0)) {
    throw new ConfigurationError(`--limit must be a positive integer, got "${args.limit}"`);
  }
  return args;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new ConfigurationError(`Missing required environment variable: ${name}. See .env.example.`);
  }
  return value.trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runGoogle({ entries, logger, dryRun, force }) {
  const keyPath = path.resolve(PROJECT_ROOT, requireEnv("GOOGLE_SERVICE_ACCOUNT_KEY_PATH"));
  const dailyQuota = Number.parseInt(process.env.GOOGLE_DAILY_QUOTA ?? "180", 10);
  const stateStore = createStateStore({ stateDir: process.env.STATE_DIR ?? "./state", engine: "google" });

  const alreadySubmittedToday = stateStore.countSuccessesSince(Date.now() - 24 * 60 * 60 * 1000);
  let remainingQuota = dailyQuota - alreadySubmittedToday;
  logger.info("google.quota_check", { dailyQuota, alreadySubmittedToday, remainingQuota });

  if (dryRun) {
    logger.info("google.dry_run", { wouldSubmit: entries.length, remainingQuota });
    return { submitted: 0, failed: 0, skipped: 0 };
  }

  const client = createGoogleIndexingClient({ keyPath });
  let submitted = 0;
  let failed = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (stateStore.shouldSkip(entry.url, force)) {
      skipped += 1;
      logger.debug("google.skip_recent", { url: entry.url });
      continue;
    }
    if (remainingQuota <= 0) {
      logger.warn("google.quota_exhausted", { remainingUrls: entries.length - submitted - failed - skipped });
      break;
    }

    try {
      await withRetry(() => client.publish(entry.url), {
        isRetryable: (error) => error instanceof GoogleApiError && (error.status === 429 || error.status >= 500),
        onRetry: (attempt, error, delayMs) =>
          logger.warn("google.retry", { url: entry.url, attempt, delayMs, status: error.status }),
      });
      stateStore.record(entry.url, { status: "success", submittedAt: new Date().toISOString() });
      submitted += 1;
      remainingQuota -= 1;
      logger.info("google.published", { url: entry.url, remainingQuota });
    } catch (error) {
      stateStore.record(entry.url, {
        status: "failed",
        submittedAt: new Date().toISOString(),
        error: String(error.message ?? error),
      });
      failed += 1;
      logger.error("google.publish_failed", {
        url: entry.url,
        error: String(error.message ?? error),
        status: error.status,
      });
    }

    await sleep(GOOGLE_REQUEST_INTERVAL_MS);
  }

  return { submitted, failed, skipped };
}

async function runIndexNow({ entries, logger, dryRun, force }) {
  const key = requireEnv("INDEXNOW_KEY");
  const host = requireEnv("SITE_HOST");
  const stateStore = createStateStore({ stateDir: process.env.STATE_DIR ?? "./state", engine: "indexnow" });

  const pending = entries.filter((entry) => !stateStore.shouldSkip(entry.url, force));
  const skipped = entries.length - pending.length;

  if (dryRun) {
    logger.info("indexnow.dry_run", { wouldSubmit: pending.length, skipped, keyLocation: `https://${host}/${key}.txt` });
    return { submitted: 0, failed: 0, skipped };
  }

  if (pending.length === 0) {
    logger.info("indexnow.nothing_to_submit", { skipped });
    return { submitted: 0, failed: 0, skipped };
  }

  const client = createIndexNowClient({ host, key });
  const urls = pending.map((entry) => entry.url);

  try {
    const result = await client.submitBatch(urls);
    const submittedAt = new Date().toISOString();
    for (const url of urls) {
      stateStore.record(url, { status: "success", submittedAt });
    }
    logger.info("indexnow.submitted", { count: urls.length, batches: result.batches });
    return { submitted: urls.length, failed: 0, skipped };
  } catch (error) {
    const submittedAt = new Date().toISOString();
    for (const url of urls) {
      stateStore.record(url, { status: "failed", submittedAt, error: String(error.message ?? error) });
    }
    logger.error("indexnow.submit_failed", { count: urls.length, error: String(error.message ?? error) });
    return { submitted: 0, failed: urls.length, skipped };
  }
}

async function main() {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const logger = createLogger({ logDir: process.env.LOG_DIR ?? "./logs", runId });

  try {
    loadDotEnv(path.join(PROJECT_ROOT, ".env"));
    const args = parseArgs(process.argv.slice(2));

    let entries = readUrlsCsv(path.resolve(PROJECT_ROOT, args.input));
    if (args.types) entries = entries.filter((entry) => args.types.includes(entry.type));
    if (args.limit) entries = entries.slice(0, args.limit);

    logger.info("run.start", { engine: args.engine, totalUrls: entries.length, dryRun: args.dryRun, force: args.force });

    const results = {};
    if (args.engine === "google" || args.engine === "all") {
      results.google = await runGoogle({ entries, logger, dryRun: args.dryRun, force: args.force });
    }
    if (args.engine === "indexnow" || args.engine === "all") {
      results.indexnow = await runIndexNow({ entries, logger, dryRun: args.dryRun, force: args.force });
    }

    logger.info("run.complete", results);
    console.log("\nSummary:");
    for (const [engine, result] of Object.entries(results)) {
      console.log(`  ${engine}: submitted=${result.submitted} failed=${result.failed} skipped=${result.skipped}`);
    }
  } catch (error) {
    if (error instanceof IndexingAutomationError) {
      logger.error("run.failed", { name: error.name, message: error.message, status: error.status, body: error.body });
      console.error(`\n${error.name}: ${error.message}`);
      process.exitCode = 1;
    } else {
      logger.error("run.crashed", { message: String(error) });
      throw error;
    }
  } finally {
    await logger.close();
  }
}

await main();
