import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {"success" | "failed"} SubmissionStatus
 * @typedef {{ status: SubmissionStatus, submittedAt: string, error?: string }} SubmissionRecord
 * @typedef {Record<string, SubmissionRecord>} EngineLedger
 */

const RESUBMIT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * File-backed submission ledger, one file per engine, keyed by URL. Makes
 * reruns idempotent: a URL that already succeeded within the cooldown window
 * is skipped unless the caller passes `force`.
 *
 * @param {{ stateDir: string, engine: string }} options
 */
export function createStateStore({ stateDir, engine }) {
  fs.mkdirSync(stateDir, { recursive: true });
  const filePath = path.join(stateDir, `${engine}-ledger.json`);

  /** @type {EngineLedger} */
  let ledger = {};
  if (fs.existsSync(filePath)) {
    try {
      ledger = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (cause) {
      throw new Error(`Ledger file ${filePath} is corrupt and cannot be parsed`, { cause });
    }
  }

  function persist() {
    fs.writeFileSync(filePath, JSON.stringify(ledger, null, 2), "utf8");
  }

  return {
    filePath,

    /**
     * @param {string} url
     * @param {boolean} force
     * @returns {boolean} true if this URL should be skipped (already recently submitted)
     */
    shouldSkip(url, force) {
      if (force) return false;
      const record = ledger[url];
      if (!record || record.status !== "success") return false;
      const age = Date.now() - new Date(record.submittedAt).getTime();
      return age < RESUBMIT_COOLDOWN_MS;
    },

    /**
     * @param {string} url
     * @param {SubmissionRecord} record
     */
    record(url, record) {
      ledger[url] = record;
      persist();
    },

    /** Count of URLs recorded as "success" within the last 24h — used for daily quota accounting. */
    countSuccessesSince(sinceMs) {
      return Object.values(ledger).filter(
        (r) => r.status === "success" && new Date(r.submittedAt).getTime() >= sinceMs,
      ).length;
    },
  };
}
