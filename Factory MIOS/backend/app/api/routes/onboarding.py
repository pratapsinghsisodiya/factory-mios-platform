import secrets
import re
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, HTTPException, status, Depends
from app.api.deps import DbDep, CurrentUser, require_roles
from app.core.security import hash_password
from app.models.models import OnboardingLink, Tenant, Client, User
from app.schemas.schemas import (
    OnboardingLinkCreate, OnboardingLinkOut, OnboardingSubmit, Token,
)
from app.core.security import create_access_token, create_refresh_token

router = APIRouter(prefix="/onboarding", tags=["onboarding"])


def _slugify(name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:100] or "client"
    return f"{base}-{secrets.token_hex(3)}"


@router.post("/links", response_model=OnboardingLinkOut,
             dependencies=[Depends(require_roles("platform_admin", "tenant_admin"))])
def create_link(body: OnboardingLinkCreate, db: DbDep, user: CurrentUser):
    """Generate a unique onboarding link to share with a prospective client."""
    link = OnboardingLink(
        token=secrets.token_urlsafe(24),
        label=body.label,
        intended_industry=body.intended_industry,
        created_by=user.id,
        expires_at=(datetime.now(timezone.utc) + timedelta(days=body.expires_in_days))
        if body.expires_in_days else None,
    )
    db.add(link)
    db.commit()
    db.refresh(link)
    out = OnboardingLinkOut.model_validate(link)
    out.url_path = f"/onboard/{link.token}"
    return out


@router.get("/links", response_model=list[OnboardingLinkOut],
            dependencies=[Depends(require_roles("platform_admin", "tenant_admin"))])
def list_links(db: DbDep, user: CurrentUser):
    links = db.query(OnboardingLink).order_by(OnboardingLink.created_at.desc()).all()
    res = []
    for l in links:
        o = OnboardingLinkOut.model_validate(l)
        o.url_path = f"/onboard/{l.token}"
        res.append(o)
    return res


@router.get("/links/{token}")
def validate_link(token: str, db: DbDep):
    """Public: front-end checks a link is valid before showing the form."""
    link = db.query(OnboardingLink).filter(OnboardingLink.token == token).first()
    if not link:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invalid onboarding link")
    if link.is_used:
        raise HTTPException(status.HTTP_409_CONFLICT, "This link has already been used")
    if link.expires_at and link.expires_at < datetime.now(timezone.utc):
        raise HTTPException(status.HTTP_410_GONE, "This onboarding link has expired")
    return {"valid": True, "label": link.label, "intended_industry": link.intended_industry}


@router.post("/links/{token}/submit", response_model=Token)
def submit(token: str, body: OnboardingSubmit, db: DbDep):
    """Public: a client fills the registration form. Creates tenant + admin user."""
    link = db.query(OnboardingLink).filter(OnboardingLink.token == token).first()
    if not link or link.is_used:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invalid or used onboarding link")
    if link.expires_at and link.expires_at < datetime.now(timezone.utc):
        raise HTTPException(status.HTTP_410_GONE, "Onboarding link expired")
    if db.query(User).filter(User.email == body.contact_email.lower()).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "A user with this email already exists")

    tenant = Tenant(name=body.company_name, slug=_slugify(body.company_name),
                    industry=body.industry or link.intended_industry)
    db.add(tenant)
    db.flush()

    client = Client(
        tenant_id=tenant.id, company_name=body.company_name, contact_name=body.contact_name,
        contact_email=body.contact_email, contact_phone=body.contact_phone,
        industry=body.industry or link.intended_industry, address=body.address, extra=body.extra,
    )
    db.add(client)

    admin = User(
        tenant_id=tenant.id, email=body.contact_email.lower(), full_name=body.contact_name,
        hashed_password=hash_password(body.admin_password), role="tenant_admin",
    )
    db.add(admin)

    link.is_used = True
    link.tenant_id = tenant.id
    db.commit()
    db.refresh(admin)

    return Token(
        access_token=create_access_token(admin.id, tenant.id, admin.role),
        refresh_token=create_refresh_token(admin.id),
    )
