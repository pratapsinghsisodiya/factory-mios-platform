"""Facto Bot — answers natural-language questions from tenant data.

Deterministic intent engine: it parses the question, runs scoped DB queries,
and returns a numeric answer + structured data. If ANTHROPIC_API_KEY is set it
is used only to phrase a friendlier summary around the real numbers — never to
invent data. All queries are tenant-scoped.
"""
import re
from datetime import datetime, timezone, timedelta
from sqlalchemy import func
from sqlalchemy.orm import Session
from app.models.models import Telemetry, QualityLog, DowntimeLog, Device, MasterData


def _window_days(q: str) -> int:
    ql = q.lower()
    if "today" in ql:
        return 1
    if "yesterday" in ql:
        return 2
    m = re.search(r"last\s+(\d+)\s*day", ql)
    if m:
        return int(m.group(1))
    if "week" in ql:
        return 7
    if "month" in ql:
        return 30
    return 1


def _since(days: int) -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=days)


def _latest_sum(db, tid, param, since):
    """Sum of each device's latest value for a counter parameter."""
    subq = (db.query(Telemetry.device_id, func.max(Telemetry.ts).label("mx"))
            .filter(Telemetry.tenant_id == tid, Telemetry.parameter == param, Telemetry.ts >= since)
            .group_by(Telemetry.device_id).subquery())
    rows = (db.query(Telemetry.value).join(
        subq, (Telemetry.device_id == subq.c.device_id) & (Telemetry.ts == subq.c.mx))
        .filter(Telemetry.parameter == param, Telemetry.tenant_id == tid).all())
    return sum(float(r[0]) for r in rows if r[0] is not None)


def _avg(db, tid, param, since):
    v = db.query(func.avg(Telemetry.value)).filter(
        Telemetry.tenant_id == tid, Telemetry.parameter == param, Telemetry.ts >= since).scalar()
    return float(v) if v is not None else None


def answer(db: Session, tid: str, question: str) -> dict:
    q = question.lower()
    days = _window_days(q)
    since = _since(days)
    span = "today" if days == 1 else (f"last {days} days")

    # --- OEE ---
    if "oee" in q:
        avail = _avg(db, tid, "running", since)
        good = _latest_sum(db, tid, "good_count", since)
        total = _latest_sum(db, tid, "total_count", since)
        avg_ct = _avg(db, tid, "cycle_time", since)
        target_ct = 30.0
        availability = (avail or 0) * 100
        quality = (good / total * 100) if total else 0
        performance = min(target_ct / avg_ct, 1.0) * 100 if avg_ct else 0
        oee = availability / 100 * performance / 100 * quality / 100 * 100
        return {"answer": f"OEE for {span} is {oee:.1f}% "
                          f"(Availability {availability:.1f}%, Performance {performance:.1f}%, Quality {quality:.1f}%).",
                "data": {"oee": round(oee, 1), "availability": round(availability, 1),
                         "performance": round(performance, 1), "quality": round(quality, 1)}}

    # --- Total production ---
    if ("total production" in q or "total produced" in q or
            ("production" in q and "total" in q) or "how much produced" in q):
        total = _latest_sum(db, tid, "total_count", since)
        return {"answer": f"Total production {span} is {int(total)} units.",
                "data": {"total_production": int(total)}}

    # --- Rejection ---
    if "rejection" in q or "reject" in q:
        qlog = db.query(func.sum(QualityLog.reject_qty)).filter(
            QualityLog.tenant_id == tid, QualityLog.logged_at >= since).scalar()
        rej = float(qlog) if qlog else _latest_sum(db, tid, "reject_count", since)
        return {"answer": f"Total rejection {span} is {int(rej)} units.",
                "data": {"rejection": int(rej)}}

    # --- Good parts ---
    if "good part" in q or "good count" in q or "good qty" in q:
        good = _latest_sum(db, tid, "good_count", since)
        return {"answer": f"Good part count {span} is {int(good)} units.",
                "data": {"good_parts": int(good)}}

    # --- Top downtime reason ---
    if "downtime" in q and ("top" in q or "highest" in q or "most" in q or "reason" in q):
        rows = (db.query(DowntimeLog.reason, func.sum(DowntimeLog.duration_min))
                .filter(DowntimeLog.tenant_id == tid, DowntimeLog.start_time >= since,
                        DowntimeLog.reason.isnot(None))
                .group_by(DowntimeLog.reason).order_by(func.sum(DowntimeLog.duration_min).desc()).limit(5).all())
        if not rows:
            return {"answer": f"No downtime has been logged in the {span}.", "data": {"top_reasons": []}}
        top = rows[0]
        listing = ", ".join(f"{r[0]} ({float(r[1] or 0):.0f} min)" for r in rows)
        return {"answer": f"The biggest downtime reason {span} is '{top[0]}' ({float(top[1] or 0):.0f} min). "
                          f"Top reasons: {listing}.",
                "data": {"top_reasons": [{"reason": r[0], "minutes": float(r[1] or 0)} for r in rows]}}

    # --- Average cycle time ---
    if "cycle time" in q:
        avg_ct = _avg(db, tid, "cycle_time", since)
        if avg_ct is None:
            return {"answer": "No cycle-time data available for that window.", "data": {}}
        return {"answer": f"Average cycle time {span} is {avg_ct:.2f} sec.",
                "data": {"avg_cycle_time": round(avg_ct, 2)}}

    # --- Energy ---
    if "energy" in q:
        avg_e = _avg(db, tid, "energy_kw", since)
        total = _latest_sum(db, tid, "total_count", since)
        per_part = (avg_e * 24 / total) if (avg_e and total) else None
        msg = f"Average power draw {span} is {avg_e:.2f} kW." if avg_e else "No energy data for that window."
        if per_part:
            msg += f" Approx energy per part: {per_part:.3f} kWh."
        return {"answer": msg, "data": {"avg_kw": round(avg_e, 2) if avg_e else None}}

    # --- Devices / machines ---
    if "machine" in q or "device" in q:
        n = db.query(func.count(Device.id)).filter(Device.tenant_id == tid).scalar()
        online = db.query(func.count(Device.id)).filter(Device.tenant_id == tid, Device.status == "online").scalar()
        return {"answer": f"You have {int(n or 0)} machines configured, {int(online or 0)} currently online.",
                "data": {"machines": int(n or 0), "online": int(online or 0)}}

    return {"answer": "I can answer questions about OEE, total production, rejection, good parts, "
                      "top downtime reasons, average cycle time, energy, and machine status. "
                      "Try: 'What is today's OEE?' or 'Show top downtime reasons this week.'",
            "data": {}}
