from datetime import datetime
from typing import Any
from pydantic import BaseModel, EmailStr, Field


# ---- Auth ----
class Token(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: str
    email: EmailStr
    full_name: str | None = None
    role: str
    tenant_id: str | None = None

    class Config:
        from_attributes = True


# ---- Onboarding ----
class OnboardingLinkCreate(BaseModel):
    label: str | None = None
    intended_industry: str | None = None
    expires_in_days: int | None = 14


class OnboardingLinkOut(BaseModel):
    id: str
    token: str
    label: str | None
    intended_industry: str | None
    is_used: bool
    expires_at: datetime | None
    url_path: str | None = None

    class Config:
        from_attributes = True


class OnboardingSubmit(BaseModel):
    company_name: str
    contact_name: str
    contact_email: EmailStr
    contact_phone: str | None = None
    industry: str | None = None
    address: str | None = None
    admin_password: str = Field(min_length=8)
    extra: dict[str, Any] = {}


# ---- Devices ----
class DeviceCreate(BaseModel):
    name: str
    machine_type: str | None = None
    connection_type: str = "mqtt"
    client_id: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    config: dict[str, Any] = {}


class DeviceOut(BaseModel):
    id: str
    name: str
    machine_type: str | None
    connection_type: str
    api_key: str
    latitude: float | None
    longitude: float | None
    status: str
    last_seen: datetime | None

    class Config:
        from_attributes = True


# ---- Ingestion ----
class TelemetryPoint(BaseModel):
    parameter: str
    value: float | None = None
    value_text: str | None = None
    ts: datetime | None = None


class IngestBatch(BaseModel):
    points: list[TelemetryPoint]


# ---- Master data ----
class MasterRow(BaseModel):
    dataset: str
    key: str
    attributes: dict[str, Any] = {}


# ---- Shifts ----
class ShiftIn(BaseModel):
    name: str
    start_time: str
    end_time: str
    target_production: float | None = None
    days: dict[str, bool] | None = None


# ---- KPI ----
class KPIIn(BaseModel):
    name: str
    unit: str | None = None
    expression: str
    inputs: dict[str, Any] = {}
    description: str | None = None


class KPIResult(BaseModel):
    name: str
    value: float | None
    unit: str | None = None
    inputs_resolved: dict[str, Any] = {}
    error: str | None = None


# ---- Dashboards ----
class DashboardIn(BaseModel):
    name: str
    template: str | None = "custom"
    layout: dict[str, Any] = {}
