import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {"debug" | "info" | "warn" | "error"} LogLevel
 */

/**
 * Structured JSON-lines logger. Every event is written as one JSON object
 * per line to `logFilePath` (for audit trail / machine parsing) and echoed
 * as a concise human-readable line on stdout/stderr for interactive runs.
 *
 * @param {{ logDir: string, runId: string }} options
 */
export function createLogger({ logDir, runId }) {
  fs.mkdirSync(logDir, { recursive: true });
  const logFilePath = path.join(logDir, `${runId}.jsonl`);
  const stream = fs.createWriteStream(logFilePath, { flags: "a" });

  /**
   * @param {LogLevel} level
   * @param {string} event
   * @param {Record<string, unknown>} [fields]
   */
  function write(level, event, fields = {}) {
    const record = { ts: new Date().toISOString(), level, event, runId, ...fields };
    stream.write(`${JSON.stringify(record)}\n`);

    const human = `[${record.ts}] ${level.toUpperCase().padEnd(5)} ${event}`;
    const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    consoleFn(human, Object.keys(fields).length ? fields : "");
  }

  return {
    logFilePath,
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    close: () =>
      new Promise((resolve) => {
        stream.end(resolve);
      }),
  };
}
