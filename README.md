# TG Auto — indexing automation

Submits every truegritin.com storefront URL to search-engine indexing APIs.
Standalone project — does not touch the `true grit` repo.

## What's here

- `data/urls.csv` — 527 URLs pulled from truegritin.com's live sitemaps
  (`type,url`: products, categories, blog, recipes, farms, discussions, pages).
  Re-export it any time the catalog changes (see "Refreshing the URL list").
- `src/submit-indexing.mjs` — CLI that submits those URLs to:
  - **Google Indexing API** — the only channel Google exposes for
    programmatic (re)indexing requests.
  - **IndexNow** — one call fans out to Bing, Yandex, Seznam.cz and Naver.
    Google does not participate in IndexNow.
- `state/*-ledger.json` — per-engine submission history, keyed by URL. Reruns
  skip anything submitted successfully in the last 7 days unless `--force`.
- `logs/*.jsonl` — one JSON line per event for every run (audit trail).

## Setup

```
cp .env.example .env
```

### Google Indexing API

1. In Google Cloud Console, create/select a project and enable the
   **Web Search Indexing API**.
2. Create a **service account**, then create a JSON key for it and download
   it to `secrets/google-service-account.json` (gitignored).
3. In **Search Console** → the `truegritin.com` property → Settings → Users
   and permissions → Add user → paste the service account's `client_email`
   → role **Owner**. Without this the API returns 403 on every call.
4. Set `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` in `.env` (defaults to
   `./secrets/google-service-account.json`, matching step 2).

Google enforces a default quota of **200 publish calls/day per property**.
`GOOGLE_DAILY_QUOTA` defaults to 180 to leave headroom; the script tracks
same-day successes in the ledger and stops cleanly when the quota is hit,
resuming automatically on the next day's run.

Note: Google's docs describe this API as being for `JobPosting` and
`BroadcastEvent` pages specifically. It accepts calls for any URL, but
Google does not guarantee it affects crawl priority for other content
types — treat it as a "here's a URL, whenever you get to it" signal, not a
guaranteed fast-track.

### IndexNow (Bing / Yandex / Seznam.cz / Naver)

1. Generate a key: `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`
2. Put it in `.env` as `INDEXNOW_KEY`.
3. Host a file containing **only that key** at
   `https://www.truegritin.com/<key>.txt`. This has to live in the
   `true grit` storefront (it's a same-host requirement of the protocol) —
   add a static route there yourself, following the existing
   `apps/storefront/app/routes/robots.txt.ts` pattern, e.g.:

   ```ts
   // apps/storefront/app/routes/[key].txt.ts
   export async function loader() {
     return new Response("<key>", { headers: { "content-type": "text/plain" } });
   }
   ```

   and register it in `routes.ts`, then deploy. This script won't submit
   anything to IndexNow until that file is live and returns 200.

## Running it

```
npm run index:dry          # validate config + print what would be submitted, no network calls
npm run index:google       # Google only
npm run index:indexnow     # IndexNow only
npm run index:all          # both
```

Useful flags on the raw CLI (`node src/submit-indexing.mjs ...`):

- `--types=products,farms` — restrict to specific sitemap categories
- `--limit=20` — cap how many URLs this run touches
- `--force` — resubmit URLs even if the ledger says they succeeded recently

## Refreshing the URL list

`data/urls.csv` is a point-in-time export. To regenerate it:

```
for s in products categories pages blog recipes farms discussions; do
  curl -sL "https://www.truegritin.com/sitemaps/$s.xml" -o "/tmp/sitemap-$s.xml"
done
```

then re-flatten each `<loc>` into `type,url` rows. (Ask Claude to redo this —
it did it the first time by fetching the live sitemaps directly.)

## Pruning before a bulk run

The sitemap already excludes non-indexable routes (cart, checkout, account,
search, payment, auth) — that filtering happens server-side in
`catalogue.server.ts`. What it does *not* filter is low-value content within
an included type (thin blog posts, near-duplicate recipes, etc.). Review
`data/urls.csv` and delete rows you don't want submitted before running
`index:google` — Google's 200/day quota is precious, so spend it on pages
worth indexing.
