from fastapi import APIRouter
from pydantic import BaseModel
from app.api.deps import DbDep, CurrentUser, tenant_scope
from app.core.config import settings
from app.services.factobot import answer

router = APIRouter(prefix="/factobot", tags=["facto-bot"])


class Ask(BaseModel):
    question: str


@router.post("")
def ask(body: Ask, db: DbDep, user: CurrentUser):
    tid = tenant_scope(user)
    result = answer(db, tid, body.question)
    # Optional: phrase a friendlier summary with the LLM, but keep DB numbers authoritative.
    if settings.ANTHROPIC_API_KEY and result.get("data"):
        try:
            import httpx
            r = httpx.post("https://api.anthropic.com/v1/messages",
                headers={"x-api-key": settings.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01",
                         "content-type": "application/json"},
                json={"model": "claude-sonnet-4-6", "max_tokens": 300,
                      "system": "You are Facto Bot for a manufacturing platform. Rephrase the given factual "
                                "answer naturally and concisely. Do NOT change any numbers.",
                      "messages": [{"role": "user", "content": f"Question: {body.question}\n"
                                    f"Factual answer: {result['answer']}\nData: {result['data']}"}]},
                timeout=20)
            r.raise_for_status()
            return {"reply": r.json()["content"][0]["text"], "data": result["data"], "engine": "anthropic"}
        except Exception:  # noqa: BLE001
            pass
    return {"reply": result["answer"], "data": result["data"], "engine": "rule-based"}
