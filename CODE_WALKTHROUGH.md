# Code walkthrough

This guide explains the copied OEE dashboard in practical terms.

## Startup sequence

1. `server.js` starts.
2. `.env` is loaded if present.
3. Express app and WebSocket server are created.
4. Security middleware runs:
   - security headers via Helmet
   - JSON body size limit
   - API/auth/AI rate limits
5. PostgreSQL pools are created:
   - `db`
   - `dbCNC`
6. Default users are created only if allowed by environment.
7. Tables are ensured/seeded by helper functions.
8. Static files from `public/` are served.
9. REST API routes and WebSocket live stream are available.
10. Server listens on `PORT`.

## Important folders

```text
server.js              Main Express app, routes, DB pools, WebSocket
lib/auth.js            JWT, bcrypt, file-based users
lib/alert-engine.js    Alert rule evaluation and scheduled reports
lib/mailer.js          SMTP email sending
lib/whatsapp.js        WhatsApp integrations
lib/report-generator.js Excel/HTML report building
lib/db-provisioner.js  Creates plant schemas/device tables
lib/free-ai-agent.js   Free/alternate AI chatbot engines
lib/claude-agent.js    Gemini/Claude SQL chatbot engine
lib/cnc-fallback.js    Rule-based chatbot fallback
public/                HTML/CSS/JS UI pages
config/                Runtime JSON config files
sql/                   SQL rebuild/migration scripts
scripts/               Setup/password helper scripts
```

## UI pages

All browser pages are in `public/`.

Examples:

- `login.html` - login page
- `index.html` - main dashboard
- `chat.html` - chatbot UI
- `saas-platform.html` - platform/tenant admin UI
- `alerts.html` - alert rules and notification setup
- `reports.html` - report generation
- `machine-live.html` - machine live data
- `device-setup.html` - plant/device provisioning
- `dashboard-builder.html` and `widgets.html` - dashboard builder

## How frontend talks to backend

Most pages use JavaScript fetch calls to `/api/...` routes.

Shared helpers are in:

```text
public/_shared.js
```

Important helpers:

- `zGetToken()` gets the JWT token
- `zAuthHeader()` adds `Authorization: Bearer ...`
- `zFetch()` wraps `fetch()` with auth and timeout handling

## Authentication today

Current auth is in:

```text
lib/auth.js
config/users.json
```

Flow:

1. User posts username/password to `/api/auth/login`.
2. Password is checked with bcrypt.
3. JWT is generated with role, tenant, and plant info.
4. JWT is returned and also stored as `oee_token` cookie.
5. Protected APIs use `authMiddleware` to verify the token.

Important SaaS warning: user storage is still JSON-file based. For real SaaS, move users to PostgreSQL with tenant IDs and role constraints.

## Database connection today

`server.js` builds DB connection settings with `buildPoolConfig()`.

Supported config styles:

```text
DATABASE_URL=postgresql://...
CNC_DATABASE_URL=postgresql://...
```

or:

```text
PGHOST=db
PGPORT=5432
PGDATABASE=cnc_db
PGUSER=cnc_user
PGPASSWORD=...
```

Two pools are used:

```js
const db = new Pool(POOL_CFG);
const dbCNC = new Pool(POOL_CNC_CFG);
```

Typical usage:

- `db` - SaaS metadata, plant/device provisioning, app tables
- `dbCNC` - CNC telemetry, OEE results, reports

In Docker, `PGHOST=db` points to the TimescaleDB service from `docker-compose.yml`.

## Chatbot internals

The chatbot is served by:

```text
public/chat.html
POST /api/chat
POST /api/cnc/chat
```

Main files:

```text
lib/free-ai-agent.js
lib/claude-agent.js
lib/cnc-fallback.js
```

Flow:

1. User asks a question in `chat.html`.
2. Browser sends it to `/api/chat` or `/api/cnc/chat`.
3. Server tries AI engines if API keys exist:
   - Groq/Gemini/Ollama via `free-ai-agent.js`
   - Gemini/Claude via `claude-agent.js`
4. AI generates a SQL `SELECT` query.
5. Server validates basic dangerous keywords.
6. SQL runs against PostgreSQL.
7. AI or fallback code formats the answer.
8. Browser shows the response.

Security warning: AI SQL needs stronger SaaS controls before production:

- read-only DB user
- table allowlist
- tenant filter enforcement
- query timeout
- max row limit

## Alert system

Files:

```text
lib/alert-engine.js
lib/mailer.js
lib/whatsapp.js
config/alert_rules.json
public/alerts.html
```

Flow:

1. Alert rules are stored in JSON config.
2. `alert-engine.js` checks live/cached data.
3. If a rule triggers, it sends email/WhatsApp based on config.
4. History is stored in config/history JSON.

## Reports

Files:

```text
lib/report-generator.js
lib/mailer.js
public/reports.html
server.js report routes
```

Reports can generate HTML/Excel and send shift reports by email.

## Device provisioning

Files:

```text
lib/db-provisioner.js
public/device-setup.html
POST /api/device/register
```

Provisioning creates:

- tenant/plant schema names
- `device_readings` table
- device config tables
- Node-RED flow JSON

This is powerful and must be admin-protected before SaaS launch.

## What is microservice-ready now

Docker Compose separates infrastructure services:

- `gateway` - Nginx edge proxy
- `app` - Node/Express app
- `db` - TimescaleDB/PostgreSQL
- `nodered` - optional IoT flow service
- `adminer` - optional DB admin tool

The app code is still mostly monolithic inside `server.js`. The next secure SaaS step is splitting high-risk domains into separate Node services.

## Data source connectors

See `DATA_SOURCE_CONNECTORS.md` for JSON, Excel/CSV, MQTT, and external SQL connector setup.

## Tenant onboarding

See `TENANT_ONBOARDING.md` for module selection, page visibility, tag mapping, shift definitions, and EMS/WMS totalizer calculations per tenant.
