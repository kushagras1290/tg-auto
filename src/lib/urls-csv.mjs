import fs from "node:fs";

import { InputError } from "./errors.mjs";

/**
 * @typedef {{ type: string, url: string }} UrlEntry
 */

/**
 * Reads the `type,url` CSV produced from truegritin.com's sitemaps.
 *
 * @param {string} csvPath
 * @returns {UrlEntry[]}
 */
export function readUrlsCsv(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new InputError(`URL list not found at ${csvPath}. Run the sitemap export first.`);
  }

  const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new InputError(`URL list at ${csvPath} is empty.`);
  }

  const [header, ...rows] = lines;
  if (header.trim() !== "type,url") {
    throw new InputError(`Expected header "type,url" in ${csvPath}, got "${header}".`);
  }

  return rows.map((row, index) => {
    const commaIndex = row.indexOf(",");
    if (commaIndex === -1) {
      throw new InputError(`Malformed row ${index + 2} in ${csvPath}: "${row}"`);
    }
    const type = row.slice(0, commaIndex).trim();
    const url = row.slice(commaIndex + 1).trim();
    if (!type || !url) {
      throw new InputError(`Malformed row ${index + 2} in ${csvPath}: "${row}"`);
    }
    return { type, url };
  });
}
