from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
from app.api.routes import (
    auth, onboarding, devices, ingest, masterdata, kpi, shifts, dashboards, chatbot, reports,
)

app = FastAPI(title=settings.PROJECT_NAME, version="0.1.0",
              description="Manufacturing Intelligence Operating System — API")

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


for r in (auth, onboarding, devices, ingest, masterdata, kpi, shifts, dashboards, chatbot, reports):
    app.include_router(r.router, prefix=settings.API_V1)
