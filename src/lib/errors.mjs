/**
 * Custom exception hierarchy for the indexing automation. Every thrown error
 * in this project is one of these, never a bare Error, so callers can branch
 * on `instanceof` and logs always carry a stable `name`.
 */

export class IndexingAutomationError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
  }
}

/** Missing or invalid environment configuration at startup. */
export class ConfigurationError extends IndexingAutomationError {}

/** The CSV/urls input could not be read or parsed. */
export class InputError extends IndexingAutomationError {}

/** Failed to mint or refresh a Google OAuth access token. */
export class GoogleAuthError extends IndexingAutomationError {
  constructor(message, { status, body, cause } = {}) {
    super(message, { cause });
    this.status = status;
    this.body = body;
  }
}

/** The Google Indexing API rejected a publish call. */
export class GoogleApiError extends IndexingAutomationError {
  constructor(message, { status, url, body, cause } = {}) {
    super(message, { cause });
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** The IndexNow endpoint rejected a submission. */
export class IndexNowApiError extends IndexingAutomationError {
  constructor(message, { status, body, cause } = {}) {
    super(message, { cause });
    this.status = status;
    this.body = body;
  }
}

/** The configured daily submission quota has been used up. */
export class QuotaExceededError extends IndexingAutomationError {}
