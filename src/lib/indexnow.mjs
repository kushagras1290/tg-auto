import { IndexNowApiError } from "./errors.mjs";

const ENDPOINT = "https://api.indexnow.org/indexnow";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_URLS_PER_BATCH = 10_000; // IndexNow protocol limit

/**
 * Creates an IndexNow client. IndexNow fans out to every participating
 * search engine (Bing, Yandex, Seznam.cz, Naver, ...) from one call — it
 * does not include Google, which has no public bulk-submission API.
 *
 * Before any submission will be accepted, a plain-text file containing just
 * `key` must be reachable at `https://<host>/<key>.txt`.
 *
 * @param {{ host: string, key: string }} options
 */
export function createIndexNowClient({ host, key }) {
  /**
   * @param {string[]} urls
   * @returns {Promise<{ status: number, batches: number }>}
   */
  async function submitBatch(urls) {
    if (urls.length === 0) {
      return { status: 200, batches: 0 };
    }

    const keyLocation = `https://${host}/${key}.txt`;
    let batches = 0;

    for (let offset = 0; offset < urls.length; offset += MAX_URLS_PER_BATCH) {
      const chunk = urls.slice(offset, offset + MAX_URLS_PER_BATCH);
      let response;
      try {
        response = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({ host, key, keyLocation, urlList: chunk }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (cause) {
        throw new IndexNowApiError(`Network error submitting batch of ${chunk.length} URLs`, { cause });
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new IndexNowApiError(`IndexNow rejected batch with status ${response.status}`, {
          status: response.status,
          body,
        });
      }

      batches += 1;
    }

    return { status: 200, batches };
  }

  return { submitBatch };
}
