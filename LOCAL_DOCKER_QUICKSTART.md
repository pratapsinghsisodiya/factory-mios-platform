# Local Docker quickstart - no local PostgreSQL needed

You do **not** need PostgreSQL or TimescaleDB installed on your PC.

Docker Compose starts everything required:

```text
gateway     -> Nginx reverse proxy on your selected localhost port
app         -> Factory-MIOS Node.js app
pgbouncer   -> database connection pool
db          -> TimescaleDB/PostgreSQL database
```

## Windows easiest path

1. Install and start **Docker Desktop**.
2. Open Command Prompt.
3. Go to the copied app folder:

```bat
cd "C:\Users\singh\OneDrive\Documents\Claude\Projects\oee dashboard\oee-dashboard-app\saas-docker-app"
```

4. Run:

```bat
setup-local-docker.bat
```

The script asks for:

- dashboard port, default `8080`
- internal app port, default `3000`
- database host port, default `5432`
- Adminer port, default `8081`
- Node-RED port, default `1880`
- database name/user/password
- JWT secret
- optional ThingsBoard token
- optional AI API keys

If you leave database password or JWT secret blank, the script auto-generates secure values.

5. Open:

```text
http://localhost:8080
```

If you selected a different dashboard port, use that port.

## PowerShell path

```powershell
cd "C:\Users\singh\OneDrive\Documents\Claude\Projects\oee dashboard\oee-dashboard-app\saas-docker-app"
powershell -ExecutionPolicy Bypass -File .\setup-local-docker.ps1
```

## Linux/macOS/VPS path

```bash
cd /path/to/oee-dashboard-app/saas-docker-app
./setup-local-docker.sh
```

## What the setup script creates

The script writes `.env` with your answers, then runs:

```bash
docker compose up -d --build
```

It also tries to apply TimescaleDB policies after the app starts:

```bash
deploy/db/policies/001-timescale-telemetry-policies.sql
```

## Useful commands

Check services:

```bash
docker compose ps
```

Watch app logs:

```bash
docker compose logs -f app
```

Stop services:

```bash
docker compose down
```

Delete database and config volumes for a fresh reset:

```bash
docker compose down -v
```

Start optional Adminer DB UI:

```bash
docker compose --profile tools up -d
```

Open:

```text
http://localhost:8081
```

Start optional Node-RED:

```bash
docker compose --profile iot up -d
```

Open:

```text
http://localhost:1880
```

## Login note

For local testing, when the script asks:

```text
Enable demo admin users for local testing? (true/false)
```

choose:

```text
true
```

For real production SaaS, use:

```text
false
```

and replace the JSON-based user bootstrap with database-backed user onboarding.

## If port 5432 is already used

If Docker says PostgreSQL port is already used, rerun setup and choose another database host port, for example:

```text
15432
```

The app container still connects internally through PgBouncer, so changing the host port is only for your PC access.
