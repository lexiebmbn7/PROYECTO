from __future__ import annotations

import os
from dataclasses import dataclass


def _texto(nombre: str, default: str = "") -> str:
    return str(os.getenv(nombre, default) or "").strip()


def _entero(nombre: str, default: int, minimo: int | None = None) -> int:
    try:
        valor = int(_texto(nombre, str(default)))
    except (TypeError, ValueError):
        valor = default
    if minimo is not None:
        valor = max(minimo, valor)
    return valor


def _flotante(nombre: str, default: float, minimo: float | None = None) -> float:
    try:
        valor = float(_texto(nombre, str(default)))
    except (TypeError, ValueError):
        valor = default
    if minimo is not None:
        valor = max(minimo, valor)
    return valor


def _booleano(nombre: str, default: bool) -> bool:
    bruto = _texto(nombre, "true" if default else "false").lower()
    if bruto in {"1", "true", "yes", "si", "sí", "on"}:
        return True
    if bruto in {"0", "false", "no", "off"}:
        return False
    return default


def _chat_ids(valor: str) -> tuple[int, ...]:
    salida: list[int] = []
    for item in str(valor or "").split(","):
        item = item.strip()
        if not item:
            continue
        try:
            salida.append(int(item))
        except ValueError:
            # No se lanza excepción de arranque por un ID aislado mal escrito.
            continue
    return tuple(salida)


@dataclass(frozen=True)
class Settings:
    telegram_token: str
    telegram_webhook_secret: str
    authorized_chat_ids_raw: str
    authorized_chat_ids: tuple[int, ...]

    supabase_url: str
    supabase_key: str
    supabase_service_role_key: str
    supabase_temp_bucket: str

    public_base_url: str

    google_client_id: str
    google_client_secret: str
    google_refresh_token: str
    google_folder_id: str
    google_drive_root_id: str

    drive_cache_ttl_seconds: int
    max_batch_files: int
    max_file_size_mb: int
    http_timeout_seconds: float

    external_retry_attempts: int
    external_retry_backoff_seconds: float
    google_api_retries: int

    outbox_worker_enabled: bool
    outbox_poll_seconds: int
    outbox_batch_size: int
    outbox_max_attempts: int


def load_settings() -> Settings:
    public_base_url = _texto("PUBLIC_BASE_URL").rstrip("/")
    railway_domain = _texto("RAILWAY_PUBLIC_DOMAIN")
    if not public_base_url and railway_domain:
        public_base_url = f"https://{railway_domain}".rstrip("/")

    ids_raw = _texto("AUTHORIZED_CHAT_IDS")

    return Settings(
        telegram_token=_texto("TELEGRAM_TOKEN"),
        telegram_webhook_secret=_texto("TELEGRAM_WEBHOOK_SECRET"),
        authorized_chat_ids_raw=ids_raw,
        authorized_chat_ids=_chat_ids(ids_raw),
        supabase_url=_texto("SUPABASE_URL"),
        supabase_key=_texto("SUPABASE_KEY"),
        supabase_service_role_key=_texto("SUPABASE_SERVICE_ROLE_KEY"),
        supabase_temp_bucket=_texto("SUPABASE_TEMP_BUCKET", "custodia-pendiente") or "custodia-pendiente",
        public_base_url=public_base_url,
        google_client_id=_texto("GOOGLE_CLIENT_ID"),
        google_client_secret=_texto("GOOGLE_CLIENT_SECRET"),
        google_refresh_token=_texto("GOOGLE_REFRESH_TOKEN"),
        google_folder_id=_texto("GOOGLE_FOLDER_ID"),
        google_drive_root_id=_texto("GOOGLE_DRIVE_ROOT_ID", "root") or "root",
        drive_cache_ttl_seconds=_entero("DRIVE_CACHE_TTL_SECONDS", 60, 10),
        max_batch_files=_entero("MAX_BATCH_FILES", 100, 1),
        max_file_size_mb=_entero("MAX_FILE_SIZE_MB", 25, 1),
        http_timeout_seconds=_flotante("HTTP_TIMEOUT_SECONDS", 20.0, 1.0),
        external_retry_attempts=_entero("EXTERNAL_RETRY_ATTEMPTS", 3, 1),
        external_retry_backoff_seconds=_flotante("EXTERNAL_RETRY_BACKOFF_SECONDS", 0.75, 0.1),
        google_api_retries=_entero("GOOGLE_API_RETRIES", 2, 0),
        outbox_worker_enabled=_booleano("OUTBOX_WORKER_ENABLED", True),
        outbox_poll_seconds=_entero("OUTBOX_POLL_SECONDS", 15, 5),
        outbox_batch_size=_entero("OUTBOX_BATCH_SIZE", 20, 1),
        outbox_max_attempts=_entero("OUTBOX_MAX_ATTEMPTS", 8, 1),
    )


settings = load_settings()
