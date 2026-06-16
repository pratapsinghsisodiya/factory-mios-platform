# Roadmap (from foundation to full vision)

**Now (in this foundation)**
Onboarding links, tenant/user/client/device models, MQTT+HTTPS+CSV ingestion,
TimescaleDB telemetry, no-code KPI engine, master-data import/mapping, shift model,
template-driven dashboards with a starter widget catalog, AI assistant (Anthropic +
rule-based fallback), Dockerized one-command run.

**Next**
- Drag-and-drop dashboard builder with resize/persisted layouts.
- Expand the widget catalog toward the "thousands of widgets" goal via JSON widget packs
  per industry/machine type (catalog is already data-driven).
- Scheduled KPI materialization (Redis queue / Celery) + continuous aggregates in Timescale.
- Real-time push to the UI via WebSockets/MQTT-over-WS.
- JSON→Excel report exports (OEE, downtime, quality, performance) on a schedule.
- Alerting/notifications, anomaly detection, downtime-reason capture UI.
- Billing/plans, SSO/SAML, full audit trail, per-widget data bindings to KPIs.
- Train/extend the assistant with retrieval over the tenant's data and runbooks.
