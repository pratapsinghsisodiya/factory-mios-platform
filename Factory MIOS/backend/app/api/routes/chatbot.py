"""AI assistant. Uses Anthropic if ANTHROPIC_API_KEY is set; otherwise a
rule-based fallback so the platform works fully offline."""
from fastapi import APIRouter
from pydantic import BaseModel
from app.api.deps import CurrentUser, DbDep, tenant_scope
from app.core.config import settings
from app.models.models import Device, KPIDefinition, Dashboard
from app.services.catalog import catalog

router = APIRouter(prefix="/assistant", tags=["assistant"])


class ChatIn(BaseModel):
    message: str


def _context(db, tid) -> str:
    devices = db.query(Device).filter(Device.tenant_id == tid).count()
    kpis = db.query(KPIDefinition).filter(KPIDefinition.tenant_id == tid).count()
    dashes = db.query(Dashboard).filter(Dashboard.tenant_id == tid).count()
    c = catalog()["counts"]
    return (f"Tenant has {devices} devices, {kpis} KPIs, {dashes} dashboards. "
            f"Catalog: {c['widget_types']} widget types, {c['industries']} industries, "
            f"{c['templates']} dashboard templates.")


def _rule_based(msg: str, ctx: str) -> str:
    m = msg.lower()
    if "oee" in m:
        return ("OEE = Availability × Performance × Quality. Create three telemetry KPIs "
                "and multiply them, or start from the built-in 'OEE Overview' dashboard template. " + ctx)
    if "connect" in m or "device" in m or "mqtt" in m:
        return ("To connect a machine: add a Device, pick MQTT/HTTPS/CSV, then publish to "
                f"topic '{settings.MQTT_TOPIC_PREFIX}/<device_api_key>' or POST to /api/v1/ingest/http "
                "with the X-API-Key header. " + ctx)
    if "kpi" in m or "formula" in m:
        return ("Build a KPI by writing an expression like 'good/total*100' and mapping each "
                "variable to a telemetry parameter, master-data field, or constant. " + ctx)
    return ("I'm the Factory MIOS assistant. Ask me about onboarding, connecting devices, "
            "building KPIs, or designing dashboards. " + ctx)


@router.post("")
def chat(body: ChatIn, db: DbDep, user: CurrentUser):
    tid = tenant_scope(user)
    ctx = _context(db, tid)
    if settings.ANTHROPIC_API_KEY:
        try:
            import httpx
            r = httpx.post(
                "https://api.anthropic.com/v1/messages",
                headers={"x-api-key": settings.ANTHROPIC_API_KEY,
                         "anthropic-version": "2023-06-01", "content-type": "application/json"},
                json={"model": "claude-sonnet-4-6", "max_tokens": 600,
                      "system": "You are the Factory MIOS in-app assistant for a manufacturing "
                                "intelligence platform. Be concise and practical. Context: " + ctx,
                      "messages": [{"role": "user", "content": body.message}]},
                timeout=30,
            )
            r.raise_for_status()
            return {"reply": r.json()["content"][0]["text"], "engine": "anthropic"}
        except Exception:  # noqa: BLE001 - fall back gracefully
            pass
    return {"reply": _rule_based(body.message, ctx), "engine": "rule-based"}
