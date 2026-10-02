from __future__ import annotations

import time
from typing import Iterable

import httpx

RETRYABLE_HTTP_STATUS = {429, 500, 502, 503, 504}


def build_http_client(timeout_seconds: float) -> httpx.Client:
    return httpx.Client(
        timeout=httpx.Timeout(float(timeout_seconds)),
        limits=httpx.Limits(
            max_connections=40,
            max_keepalive_connections=20,
        ),
        follow_redirects=True,
    )


def http_request_with_retry(
    client: httpx.Client,
    method: str,
    url: str,
    *,
    attempts: int = 3,
    backoff_seconds: float = 0.75,
    retry_statuses: Iterable[int] = RETRYABLE_HTTP_STATUS,
    **kwargs,
) -> httpx.Response:
    """Reintenta operaciones HTTP idempotentes o explícitamente seguras.

    El llamador decide cuándo usarlo. Para ``sendMessage`` de Telegram se usa
    el outbox durable en lugar de reintentar agresivamente y arriesgar mensajes
    duplicados.
    """

    attempts = max(1, int(attempts))
    retry_statuses = set(retry_statuses)
    ultimo_error: Exception | None = None

    for intento in range(1, attempts + 1):
        try:
            respuesta = client.request(method, url, **kwargs)
            if respuesta.status_code not in retry_statuses or intento >= attempts:
                return respuesta
        except (httpx.ConnectError, httpx.ReadTimeout, httpx.WriteTimeout, httpx.PoolTimeout) as error:
            ultimo_error = error
            if intento >= attempts:
                raise

        time.sleep(float(backoff_seconds) * (2 ** (intento - 1)))

    if ultimo_error:
        raise ultimo_error
    raise RuntimeError("La operación HTTP no produjo respuesta.")


def execute_google_request(request, retries: int = 2):
    """Ejecuta una petición del cliente oficial de Google con reintentos.

    ``googleapiclient`` implementa reintentos para respuestas transitorias
    mediante ``num_retries``. Esto se aplica solo a llamadas Google Drive.
    """

    return request.execute(num_retries=max(0, int(retries)))
