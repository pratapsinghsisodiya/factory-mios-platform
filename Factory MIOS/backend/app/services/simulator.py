"""Fake telemetry streamer for demos.

Generates realistic OEE-style telemetry for every device in the database on a
loop, writing straight to the telemetry hypertable so dashboards/KPIs show live
data without real machines. Run:

    python -m app.services.simulator            # all tenants/devices
    SIM_INTERVAL=2 python -m app.services.simulator

It is also wired as an optional docker-compose service (profile: demo):
    docker compose --profile demo up simulator
"""
import os
import math
import random
import time
import logging
from datetime import datetime, timezone
from app.core.database import SessionLocal
import random as _rnd
from app.models.models import Device, Telemetry, DowntimeLog, QualityLog, MasterData

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("simulator")

INTERVAL = float(os.getenv("SIM_INTERVAL", "5"))

# Per-device running state so counters accumulate realistically.
_state: dict[str, dict] = {}


def _device_state(dev_id: str) -> dict:
    if dev_id not in _state:
        _state[dev_id] = {
            "total_count": random.randint(0, 50),
            "good_count": 0,
            "downtime_min": 0.0,
            "phase": random.random() * math.pi,
        }
        _state[dev_id]["good_count"] = int(_state[dev_id]["total_count"] * 0.95)
    return _state[dev_id]


def _tick(dev: Device) -> list[Telemetry]:
    s = _device_state(dev.id)
    running = random.random() > 0.12          # ~88% availability
    produced = random.randint(1, 4) if running else 0
    good = sum(1 for _ in range(produced) if random.random() > 0.04)  # ~96% quality
    s["total_count"] += produced
    s["good_count"] += good
    if not running:
        s["downtime_min"] += INTERVAL / 60.0
    s["phase"] += 0.15

    cycle_time = 28 + 6 * math.sin(s["phase"]) + random.uniform(-1.5, 1.5)  # target ~30s
    temperature = 62 + 8 * math.sin(s["phase"] / 2) + random.uniform(-2, 2)
    rpm = 0 if not running else 1500 + int(120 * math.sin(s["phase"])) + random.randint(-40, 40)
    energy_kw = 0.5 if not running else 11 + 3 * math.sin(s["phase"]) + random.uniform(-0.6, 0.6)

    now = datetime.now(timezone.utc)
    readings = {
        "total_count": s["total_count"], "good_count": s["good_count"],
        "reject_count": s["total_count"] - s["good_count"],
        "cycle_time": round(cycle_time, 2), "temperature": round(temperature, 2),
        "rpm": rpm, "energy_kw": round(energy_kw, 2),
        "running": 1 if running else 0, "downtime_min": round(s["downtime_min"], 2),
    }
    return [Telemetry(tenant_id=dev.tenant_id, device_id=dev.id, parameter=k,
                      value=float(v), ts=now) for k, v in readings.items()]



def _maybe_logs(db, dev):
    """Occasionally emit a downtime and a quality log so demo pages have data."""
    now = datetime.now(timezone.utc)
    if _rnd.random() < 0.15:
        reasons = [r.key for r in db.query(MasterData).filter(
            MasterData.tenant_id == dev.tenant_id, MasterData.dataset == "downtime_reasons").all()] or ["Breakdown"]
        dur = round(_rnd.uniform(2, 25), 1)
        db.add(DowntimeLog(tenant_id=dev.tenant_id, device_id=dev.id,
            start_time=now - timedelta(minutes=dur), end_time=now, duration_min=dur,
            category=_rnd.choice(["planned", "unplanned"]), reason=_rnd.choice(reasons),
            operator="auto-sim", status="closed"))
    if _rnd.random() < 0.2:
        defects = [d.key for d in db.query(MasterData).filter(
            MasterData.tenant_id == dev.tenant_id, MasterData.dataset == "quality_defects").all()] or ["Surface defect"]
        good = _rnd.randint(20, 60)
        rej = _rnd.randint(0, 5)
        db.add(QualityLog(tenant_id=dev.tenant_id, device_id=dev.id, logged_at=now,
            product="P-100", good_qty=good, reject_qty=rej, rework_qty=_rnd.randint(0, 2),
            defect_reason=_rnd.choice(defects) if rej else None, operator="auto-sim"))


def run_once(db) -> int:
    devices = db.query(Device).all()
    rows: list[Telemetry] = []
    for dev in devices:
        rows.extend(_tick(dev))
        _maybe_logs(db, dev)
        dev.status = "online"
        dev.last_seen = datetime.now(timezone.utc)
    db.add_all(rows)
    db.commit()
    return len(rows)


def main():
    log.info("Telemetry simulator started (interval=%ss). Ctrl-C to stop.", INTERVAL)
    while True:
        db = SessionLocal()
        try:
            n = run_once(db)
            log.info("wrote %d telemetry points", n)
        except Exception as e:  # noqa: BLE001
            log.error("simulator error: %s", e)
        finally:
            db.close()
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
