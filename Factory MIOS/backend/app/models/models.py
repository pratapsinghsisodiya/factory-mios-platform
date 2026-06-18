"""All SQLAlchemy ORM models for Factory MIOS.

Multi-tenancy: every business table carries tenant_id. The API layer scopes
all queries to the caller's tenant (see app/api/deps.py).
"""
import uuid
from datetime import datetime, timezone
from sqlalchemy import (
    String, Integer, Float, Boolean, DateTime, ForeignKey, Text, JSON, UniqueConstraint, Index
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.core.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Tenant(Base):
    __tablename__ = "tenants"
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    slug: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    industry: Mapped[str | None] = mapped_column(String(120))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (UniqueConstraint("email", name="uq_user_email"),)
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    tenant_id: Mapped[str | None] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"))
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    full_name: Mapped[str | None] = mapped_column(String(255))
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    # platform_admin | tenant_admin | engineer | viewer
    role: Mapped[str] = mapped_column(String(40), default="viewer")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class OnboardingLink(Base):
    """A unique, shareable link to onboard a new client/tenant."""
    __tablename__ = "onboarding_links"
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    token: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    label: Mapped[str | None] = mapped_column(String(255))
    intended_industry: Mapped[str | None] = mapped_column(String(120))
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    is_used: Mapped[bool] = mapped_column(Boolean, default=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    tenant_id: Mapped[str | None] = mapped_column(ForeignKey("tenants.id", ondelete="SET NULL"))


class Client(Base):
    """Customer organization / plant profile captured at onboarding."""
    __tablename__ = "clients"
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    company_name: Mapped[str] = mapped_column(String(255), nullable=False)
    contact_name: Mapped[str | None] = mapped_column(String(255))
    contact_email: Mapped[str | None] = mapped_column(String(255))
    contact_phone: Mapped[str | None] = mapped_column(String(64))
    industry: Mapped[str | None] = mapped_column(String(120))
    address: Mapped[str | None] = mapped_column(Text)
    extra: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Device(Base):
    """A machine / gateway sending telemetry. Holds GPS + connection method."""
    __tablename__ = "devices"
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    client_id: Mapped[str | None] = mapped_column(ForeignKey("clients.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    machine_type: Mapped[str | None] = mapped_column(String(120))
    # connection: mqtt | https | csv
    connection_type: Mapped[str] = mapped_column(String(20), default="mqtt")
    api_key: Mapped[str] = mapped_column(String(64), index=True, default=lambda: uuid.uuid4().hex)
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(20), default="provisioned")  # provisioned|online|offline
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    config: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Telemetry(Base):
    """Time-series parameter readings. Promoted to a TimescaleDB hypertable."""
    __tablename__ = "telemetry"
    __table_args__ = (
        Index("ix_telemetry_dev_param_ts", "device_id", "parameter", "ts"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, primary_key=True)
    tenant_id: Mapped[str] = mapped_column(UUID(as_uuid=False), index=True)
    device_id: Mapped[str] = mapped_column(UUID(as_uuid=False), index=True)
    parameter: Mapped[str] = mapped_column(String(120))
    value: Mapped[float | None] = mapped_column(Float)
    value_text: Mapped[str | None] = mapped_column(String(255))


class MasterData(Base):
    """Reference data, e.g. part catalog with target cycle times."""
    __tablename__ = "master_data"
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    dataset: Mapped[str] = mapped_column(String(120), index=True)  # e.g. "parts"
    key: Mapped[str] = mapped_column(String(255), index=True)       # e.g. part number
    attributes: Mapped[dict] = mapped_column(JSONB, default=dict)   # arbitrary fields
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Shift(Base):
    __tablename__ = "shifts"
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    start_time: Mapped[str] = mapped_column(String(5))  # "06:00"
    end_time: Mapped[str] = mapped_column(String(5))    # "14:00"
    target_production: Mapped[float | None] = mapped_column(Float)
    days: Mapped[dict] = mapped_column(JSONB, default=lambda: {"mon": True, "tue": True, "wed": True,
                                                               "thu": True, "fri": True, "sat": False, "sun": False})
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class KPIDefinition(Base):
    """No-code KPI: a safe expression over parameters / master data / aggregates."""
    __tablename__ = "kpi_definitions"
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    unit: Mapped[str | None] = mapped_column(String(40))
    expression: Mapped[str] = mapped_column(Text)  # e.g. "good_count / total_count * 100"
    # mapping of variable name -> spec: {"source":"telemetry","parameter":"good_count","agg":"last"}
    inputs: Mapped[dict] = mapped_column(JSONB, default=dict)
    description: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Dashboard(Base):
    __tablename__ = "dashboards"
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    template: Mapped[str | None] = mapped_column(String(80))  # oee|downtime|quality|ems|wms|custom
    layout: Mapped[dict] = mapped_column(JSONB, default=dict)  # widget grid
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


# ===================== Asset hierarchy & extended modules =====================
# Tenant → Location → Plant → Department → Line → Machine/Device → Telemetry

class Location(Base):
    __tablename__ = "locations"
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    code: Mapped[str | None] = mapped_column(String(60))
    timezone: Mapped[str] = mapped_column(String(60), default="UTC")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Plant(Base):
    __tablename__ = "plants"
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    location_id: Mapped[str | None] = mapped_column(ForeignKey("locations.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(255))
    code: Mapped[str | None] = mapped_column(String(60))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Department(Base):
    __tablename__ = "departments"
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    plant_id: Mapped[str | None] = mapped_column(ForeignKey("plants.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Line(Base):
    __tablename__ = "lines"
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    plant_id: Mapped[str | None] = mapped_column(ForeignKey("plants.id", ondelete="SET NULL"))
    department_id: Mapped[str | None] = mapped_column(ForeignKey("departments.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(255))
    code: Mapped[str | None] = mapped_column(String(60))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class TelemetryDefinition(Base):
    """Maps a raw incoming parameter to a display/KPI/report-ready definition."""
    __tablename__ = "telemetry_definitions"
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True)
    raw_name: Mapped[str] = mapped_column(String(120))
    display_name: Mapped[str] = mapped_column(String(120))
    data_type: Mapped[str] = mapped_column(String(30), default="numeric")  # numeric|counter|status|text
    unit: Mapped[str | None] = mapped_column(String(40))
    aggregation: Mapped[str] = mapped_column(String(20), default="last")  # last|sum|avg|min|max|delta
    usage: Mapped[dict] = mapped_column(JSONB, default=dict)  # {"oee":true,"ems":false,...}
    ai_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    alarm_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    color_rules: Mapped[dict] = mapped_column(JSONB, default=dict)
    # KPI intent for this parameter: oee|availability|performance|quality|delta|shift|daily|timestamp|raw
    kpi_type: Mapped[str] = mapped_column(String(40), default="raw")
    is_static: Mapped[bool] = mapped_column(Boolean, default=False)
    static_value: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class DowntimeLog(Base):
    __tablename__ = "downtime_logs"
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id", ondelete="SET NULL"), index=True)
    shift_id: Mapped[str | None] = mapped_column(ForeignKey("shifts.id", ondelete="SET NULL"))
    start_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    end_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    duration_min: Mapped[float | None] = mapped_column(Float)
    category: Mapped[str | None] = mapped_column(String(40))  # planned|unplanned
    reason: Mapped[str | None] = mapped_column(String(255))   # from downtime_reasons master
    operator: Mapped[str | None] = mapped_column(String(120))
    remarks: Mapped[str | None] = mapped_column(Text)
    approved_by: Mapped[str | None] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(30), default="open")  # open|closed|approved
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class QualityLog(Base):
    __tablename__ = "quality_logs"
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id", ondelete="SET NULL"), index=True)
    shift_id: Mapped[str | None] = mapped_column(ForeignKey("shifts.id", ondelete="SET NULL"))
    logged_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
    product: Mapped[str | None] = mapped_column(String(120))
    job_id: Mapped[str | None] = mapped_column(String(120))
    batch_id: Mapped[str | None] = mapped_column(String(120))
    serial_no: Mapped[str | None] = mapped_column(String(120))
    good_qty: Mapped[float] = mapped_column(Float, default=0)
    reject_qty: Mapped[float] = mapped_column(Float, default=0)
    rework_qty: Mapped[float] = mapped_column(Float, default=0)
    defect_reason: Mapped[str | None] = mapped_column(String(255))
    operator: Mapped[str | None] = mapped_column(String(120))
    remarks: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class FormInput(Base):
    """Generic custom user-input form submissions (job/serial/checklist/etc.)."""
    __tablename__ = "form_inputs"
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    form_type: Mapped[str] = mapped_column(String(80), index=True)
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id", ondelete="SET NULL"))
    shift_id: Mapped[str | None] = mapped_column(ForeignKey("shifts.id", ondelete="SET NULL"))
    data: Mapped[dict] = mapped_column(JSONB, default=dict)
    logged_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
