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
