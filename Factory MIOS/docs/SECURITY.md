# Security notes

This is a foundation. Before production, address the following.

**Implemented**
- Passwords hashed with bcrypt (passlib); never stored in plaintext.
- JWT access/refresh tokens, signed with `SECRET_KEY` (set a 64-char random hex).
- Role-based authorization + per-tenant query scoping on every business endpoint.
- Device ingestion authenticated by per-device API keys.
- Safe formula evaluation (`simpleeval`, no builtins/attribute access).
- CORS restricted to configured origins. Secrets read from env, `.env` git-ignored.

**Do before production**
- Generate strong `SECRET_KEY` and DB/admin passwords; rotate the demo accounts.
- Terminate TLS (HTTPS) at a reverse proxy (Caddy/Traefik/Nginx) in front of frontend+API.
- MQTT: disable `allow_anonymous`, add per-tenant credentials/ACLs, enable TLS (8883).
- Add rate limiting and request size limits (uploads), plus audit logging.
- Move DB credentials to a secrets manager; enable Postgres TLS and least-privilege roles.
- Add refresh-token rotation/revocation and account lockout on repeated failures.
- Run `docker compose` behind a firewall; don't expose the DB port publicly.
- Add automated tests + dependency scanning (e.g. pip-audit, npm audit) to CI.
