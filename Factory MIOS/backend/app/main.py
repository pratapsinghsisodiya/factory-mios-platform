from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
from app.api.routes import (
    auth, onboarding, devices, ingest, masterdata, kpi, shifts, dashboards, chatbot, reports,
    hierarchy, telemetry_map, logging_routes, analytics, factobot,
)

app = FastAPI(title=settings.PROJECT_NAME, version="0.2.0",
              description="Factory MIOS — Manufacturing Intelligent Operating System API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", tags=["meta"])
def health():
    return {"status": "ok", "service": settings.PROJECT_NAME}


_routers = (auth, onboarding, devices, ingest, masterdata, kpi, shifts, dashboards, chatbot,
            reports, hierarchy, telemetry_map, logging_routes, analytics, factobot)
for r in _routers:
    app.include_router(r.router, prefix=settings.API_V1)
