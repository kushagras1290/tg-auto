import crypto from "node:crypto";
import fs from "node:fs";

import { ConfigurationError, GoogleApiError, GoogleAuthError } from "./errors.mjs";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PUBLISH_URL = "https://indexing.googleapis.com/v3/urlNotifications:publish";
const METADATA_URL = "https://indexing.googleapis.com/v3/urlNotifications/metadata";
const SCOPE = "https://www.googleapis.com/auth/indexing";
const TOKEN_TTL_SECONDS = 3600;
const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

/**
 * @param {{ client_email: string, private_key: string }} serviceAccount
 * @returns {string} a signed RS256 JWT assertion for the OAuth2 JWT-bearer flow
 */
function signAssertion(serviceAccount) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: serviceAccount.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_TTL_SECONDS,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), serviceAccount.private_key);
  return `${signingInput}.${signature.toString("base64url")}`;
}

/**
 * Loads a Google service account JSON key from disk and validates it has the
 * fields required to sign JWTs.
 *
 * @param {string} keyPath
 */
function loadServiceAccount(keyPath) {
  if (!fs.existsSync(keyPath)) {
    throw new ConfigurationError(
      `GOOGLE_SERVICE_ACCOUNT_KEY_PATH points to ${keyPath}, which does not exist. ` +
        "Download a service account JSON key from Google Cloud Console and place it there.",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  } catch (cause) {
    throw new ConfigurationError(`${keyPath} is not valid JSON`, { cause });
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new ConfigurationError(`${keyPath} is missing client_email or private_key`);
  }
  return parsed;
}

/**
 * Creates a Google Indexing API client backed by a service account.
 *
 * The service account must be granted "Owner" on the target property in
 * Search Console (Settings > Users and permissions) before publish calls
 * will succeed — otherwise the API returns 403 "permission denied".
 *
 * @param {{ keyPath: string }} options
 */
export function createGoogleIndexingClient({ keyPath }) {
  const serviceAccount = loadServiceAccount(keyPath);

  /** @type {{ accessToken: string, expiresAt: number } | null} */
  let cachedToken = null;

  async function getAccessToken() {
    if (cachedToken && cachedToken.expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now()) {
      return cachedToken.accessToken;
    }

    const assertion = signAssertion(serviceAccount);
    let response;
    try {
      response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new GoogleAuthError("Network error while exchanging JWT for an access token", { cause });
    }

    const body = await response.text();
    if (!response.ok) {
      throw new GoogleAuthError(`Token exchange failed with status ${response.status}`, {
        status: response.status,
        body,
      });
    }

    const parsed = JSON.parse(body);
    cachedToken = {
      accessToken: parsed.access_token,
      expiresAt: Date.now() + (parsed.expires_in ?? TOKEN_TTL_SECONDS) * 1000,
    };
    return cachedToken.accessToken;
  }

  /**
   * Publishes a single URL_UPDATED notification.
   *
   * @param {string} url
   * @returns {Promise<{ status: number, body: unknown }>}
   */
  async function publish(url) {
    const accessToken = await getAccessToken();
    let response;
    try {
      response = await fetch(PUBLISH_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url, type: "URL_UPDATED" }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new GoogleApiError(`Network error publishing ${url}`, { url, cause });
    }

    const bodyText = await response.text();
    let body;
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      body = bodyText;
    }

    if (!response.ok) {
      throw new GoogleApiError(`Google Indexing API rejected ${url} with status ${response.status}`, {
        status: response.status,
        url,
        body,
      });
    }

    return { status: response.status, body };
  }

  /**
   * Fetches indexing notification metadata for a URL. Read-only — does not
   * publish anything — so it's a safe way to check that the service account
   * has been granted access before spending publish quota. Google applies
   * the same ownership check to this endpoint as to `publish`, so a 403
   * here means the service account still needs to be added as an Owner in
   * Search Console.
   *
   * @param {string} url
   * @returns {Promise<{ status: number, body: unknown }>}
   */
  async function getMetadata(url) {
    const accessToken = await getAccessToken();
    let response;
    try {
      response = await fetch(`${METADATA_URL}?url=${encodeURIComponent(url)}`, {
        method: "GET",
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new GoogleApiError(`Network error fetching metadata for ${url}`, { url, cause });
    }

    const bodyText = await response.text();
    let body;
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      body = bodyText;
    }

    return { status: response.status, body };
  }

  return { publish, getMetadata };
}
