from typing import Annotated
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.core.config import settings
from app.core.security import decode_token
from app.models.models import User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl=f"{settings.API_V1}/auth/login")

DbDep = Annotated[Session, Depends(get_db)]


def get_current_user(token: Annotated[str, Depends(oauth2_scheme)], db: DbDep) -> User:
    payload = decode_token(token)
    if not payload or payload.get("type") != "access":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")
    user = db.get(User, payload.get("sub"))
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found or inactive")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def require_roles(*roles: str):
    def checker(user: CurrentUser) -> User:
        if user.role not in roles and user.role != "platform_admin":
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permissions")
        return user
    return checker


def tenant_scope(user: User) -> str:
    """Returns the tenant_id all queries must be scoped to."""
    if not user.tenant_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "User has no tenant context")
    return user.tenant_id
