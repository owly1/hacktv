# Local configuration

Copy `.env.example` to `.env`; never commit populated credentials. The backend
loads the file with Node's `--env-file`. The browser never receives cloud keys.

| Setting | Purpose |
|---|---|
| `INGEST_TOKEN` | Receiver authentication; give only this token to the bridge |
| `DASHBOARD_TOKEN` | Dashboard API access; must differ from the ingest token |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Optional Gemini access and account-enabled model |
| `GEMINI_FALLBACK_MODELS` | Ordered fallback model names |
| `DATABASE_URL` | Optional PostgreSQL/TigerData connection string |
| `PG_CA_FILE` | Optional service CA; keep certificate verification enabled |
| `ALLOWED_ORIGINS` | Exact allowed browser origins |
| `HOST`, `PORT` | Normally `127.0.0.1:8787` |
| `SITE_NAME`, `SITE_LAT`, `SITE_LON` | Configured scenario site, not a GPS fix |
| `SEARCH_SECTOR` | Optional `south,west,north,east` person-search bounds |
| `CAMERA_HFOV_DEG`, `COVERAGE_CELL_M` | Coverage geometry settings |
| `DATA_DIR` | Optional runtime-data location |

Generate two different tokens locally, for example by running this twice:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

With `DATABASE_URL` configured, run `npm run db:init` to apply and verify the
schema. Without it, storage is explicitly memory-only. Gemini remains unavailable
until its key and model work. A configured indicator is not round-trip proof.

The bundled Leaflet frontend uses backend-proxied OSM/Esri tiles without a
configured map key; first-time tiles require Internet access. Provider attribution
remains visible. No OpenAI or Anthropic key is used by this application.

Mac Pi settings live in ignored `.pi.local`. SSH private keys and verified
host records remain local; never put credentials or raw settings dumps in logs.
