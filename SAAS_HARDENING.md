# SaaS hardening checklist

The Docker foundation makes the app easier to deploy, but the platform still needs security hardening before it is offered as SaaS.

## Required before SaaS launch

1. **Remove default credentials**
   - Stop auto-creating `admin / 123` and `superadmin / super@123` in production.
   - Remove credential hints from the login page.
   - Move user bootstrap to an explicit one-time setup command.

2. **Enforce server-side authorization**
   - Add middleware such as `requireSuperadmin`, `requireTenantAdmin`, and `requirePlantAccess`.
   - Protect all destructive/write endpoints, including device provisioning, plant deletion, alerts, dashboards, reports, and Node-RED flow pushes.

3. **Enforce tenant isolation**
   - Every SaaS query must scope by `req.user.tenant_id` unless the user is `superadmin`.
   - Never trust `tenant_id`, `plant_id`, or `machine_id` request parameters without checking access.

4. **Move users to the database**
   - Replace `config/users.json` with a database-backed users table.
   - Store users by tenant and add unique constraints such as `(tenant_id, username)`.

5. **Harden secrets**
   - Require `JWT_SECRET` in production.
   - Remove hardcoded DB, ThingsBoard, SMTP, and MQTT secrets.
   - Rotate any secret that has appeared in logs, commits, screenshots, or chat.

6. **Restrict AI SQL**
   - Use a read-only database role.
   - Add an allowlist of readable tables/columns.
   - Add query timeouts and row limits.

7. **Add tests**
   - Auth and role checks.
   - Tenant isolation checks.
   - Destructive endpoint denial checks.
   - Report generation smoke tests.

## Recommended platform additions

- Billing/subscription integration.
- Per-tenant usage limits.
- Audit log review UI.
- Rate limiting.
- Security headers.
- Backup/restore runbooks.
- Monitoring and alerting for app, DB, and queues.
