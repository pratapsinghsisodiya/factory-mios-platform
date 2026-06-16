from datetime import datetime, timezone
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from app.api.deps import DbDep, CurrentUser, tenant_scope
from app.services.reports import build_report

router = APIRouter(prefix="/reports", tags=["reports"])

VALID = {"oee", "downtime", "quality", "performance"}


@router.get("/{report_type}.xlsx")
def export_report(report_type: str, db: DbDep, user: CurrentUser, window_minutes: int = 1440):
    """Export a JSON-telemetry-derived report as a downloadable Excel workbook."""
    rtype = report_type if report_type in VALID else "oee"
    tid = tenant_scope(user)
    data = build_report(db, tid, rtype, window_minutes)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    fname = f"mios-{rtype}-{stamp}.xlsx"
    return StreamingResponse(
        iter([data]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )
