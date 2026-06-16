from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    PROJECT_NAME: str = "Factory MIOS"
    API_V1: str = "/api/v1"

    DATABASE_URL: str = "postgresql+psycopg://mios:change-me-in-prod@db:5432/mios"
    REDIS_URL: str = "redis://redis:6379/0"

    MQTT_HOST: str = "mqtt"
    MQTT_PORT: int = 1883
    MQTT_TOPIC_PREFIX: str = "mios/telemetry"

    SECRET_KEY: str = "dev-insecure-change-me"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    CORS_ORIGINS: str = "http://localhost:3000"

    ADMIN_EMAIL: str = "admin@factory-mios.local"
    ADMIN_PASSWORD: str = "ChangeMe!2026"

    ANTHROPIC_API_KEY: str = ""

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
