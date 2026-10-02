from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone

OUTBOX_PENDIENTE = "PENDIENTE"
OUTBOX_PROCESANDO = "PROCESANDO"
OUTBOX_ENVIADO = "ENVIADO"
OUTBOX_ERROR = "ERROR"


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


def construir_dedupe_key(
    servicio: str,
    tipo: str,
    payload: dict,
    contexto: dict | None = None,
) -> str:
    canonico = json.dumps(
        {
            "servicio": str(servicio or "").upper(),
            "tipo": str(tipo or "").upper(),
            "payload": payload or {},
            "contexto": contexto or {},
        },
        sort_keys=True,
        ensure_ascii=False,
        default=str,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonico.encode("utf-8")).hexdigest()


def encolar_evento(
    db,
    *,
    servicio: str,
    tipo: str,
    payload: dict,
    contexto: dict | None = None,
    error: str | None = None,
    max_intentos: int = 8,
    dedupe_key: str | None = None,
):
    servicio = str(servicio or "").upper()
    tipo = str(tipo or "").strip()
    payload = payload or {}
    contexto = contexto or {}
    dedupe_key = dedupe_key or construir_dedupe_key(servicio, tipo, payload, contexto)
    ahora = _ahora().isoformat()

    # Evita duplicar el mismo aviso cuando el background task se ejecuta más de
    # una vez antes de que Telegram se recupere.
    try:
        existente = (
            db.table("integracion_outbox")
            .select("*")
            .eq("dedupe_key", dedupe_key)
            .limit(1)
            .execute()
        ).data or []
        if existente:
            fila = existente[0]
            if str(fila.get("estado") or "").upper() != OUTBOX_ENVIADO:
                db.table("integracion_outbox").update({
                    "estado": OUTBOX_PENDIENTE,
                    "ultimo_error": str(error)[:2000] if error else fila.get("ultimo_error"),
                    "next_attempt_at": ahora,
                    "updated_at": ahora,
                }).eq("id", fila.get("id")).execute()
            return fila
    except Exception as consulta_error:
        print("[OUTBOX LOOKUP ERROR]", consulta_error)

    registro = {
        "servicio": servicio,
        "tipo": tipo,
        "payload": payload,
        "contexto": contexto,
        "estado": OUTBOX_PENDIENTE,
        "intentos": 0,
        "max_intentos": max(1, int(max_intentos)),
        "next_attempt_at": ahora,
        "ultimo_error": str(error)[:2000] if error else None,
        "dedupe_key": dedupe_key,
        "created_at": ahora,
        "updated_at": ahora,
    }

    try:
        respuesta = db.table("integracion_outbox").insert(registro).execute()
        return (respuesta.data or [None])[0]
    except Exception as insert_error:
        print("[OUTBOX INSERT ERROR]", insert_error)
        return None


def listar_pendientes(
    db,
    *,
    servicio: str,
    limit: int = 20,
    stale_processing_seconds: int = 300,
) -> list[dict]:
    """Lista entregas reintentables y recupera filas PROCESANDO huérfanas.

    Si Railway reinicia después de marcar una fila como PROCESANDO, esa fila no
    puede quedar bloqueada para siempre. Tras ``stale_processing_seconds`` se
    considera huérfana y vuelve a ser elegible para reintento.
    """

    ahora_dt = _ahora()
    ahora = ahora_dt.isoformat()
    servicio = str(servicio or "").upper()
    limite_busqueda = max(1, int(limit)) * 3

    try:
        filas = (
            db.table("integracion_outbox")
            .select("*")
            .eq("servicio", servicio)
            .in_("estado", [OUTBOX_PENDIENTE, OUTBOX_ERROR])
            .lte("next_attempt_at", ahora)
            .order("created_at")
            .limit(limite_busqueda)
            .execute()
        ).data or []
    except Exception as error:
        print("[OUTBOX LIST ERROR]", error)
        filas = []

    # Recuperación de eventos que quedaron PROCESANDO por un reinicio/crash.
    stale_before = (
        ahora_dt - timedelta(seconds=max(30, int(stale_processing_seconds)))
    ).isoformat()
    try:
        huerfanas = (
            db.table("integracion_outbox")
            .select("*")
            .eq("servicio", servicio)
            .eq("estado", OUTBOX_PROCESANDO)
            .lte("updated_at", stale_before)
            .order("updated_at")
            .limit(limite_busqueda)
            .execute()
        ).data or []
        filas.extend(huerfanas)
    except Exception as error:
        print("[OUTBOX STALE LIST ERROR]", error)

    # Deduplicación por id por si una fila aparece en más de un conjunto.
    unicas = {}
    for fila in filas:
        fila_id = str(fila.get("id") or "")
        if fila_id:
            unicas[fila_id] = fila

    salida = []
    for fila in sorted(
        unicas.values(),
        key=lambda x: str(x.get("created_at") or ""),
    ):
        if int(fila.get("intentos") or 0) >= int(fila.get("max_intentos") or 1):
            continue
        salida.append(fila)
        if len(salida) >= max(1, int(limit)):
            break
    return salida

def marcar_procesando(db, outbox_id: str):
    ahora = _ahora().isoformat()
    try:
        respuesta = (
            db.table("integracion_outbox")
            .select("intentos")
            .eq("id", str(outbox_id))
            .limit(1)
            .execute()
        )
        fila = (respuesta.data or [{}])[0]
        intento = int(fila.get("intentos") or 0) + 1
        db.table("integracion_outbox").update({
            "estado": OUTBOX_PROCESANDO,
            "intentos": intento,
            "updated_at": ahora,
        }).eq("id", str(outbox_id)).execute()
        return intento
    except Exception as error:
        print("[OUTBOX PROCESSING ERROR]", error)
        return 1


def marcar_enviado(db, outbox_id: str, resultado: dict | None = None):
    ahora = _ahora().isoformat()
    try:
        db.table("integracion_outbox").update({
            "estado": OUTBOX_ENVIADO,
            "resultado": resultado or {},
            "ultimo_error": None,
            "next_attempt_at": None,
            "sent_at": ahora,
            "updated_at": ahora,
        }).eq("id", str(outbox_id)).execute()
    except Exception as error:
        print("[OUTBOX SENT ERROR]", error)


def marcar_error(db, outbox_id: str, *, intento: int, error: str):
    ahora = _ahora()
    demora = min(900, 5 * (2 ** max(0, int(intento) - 1)))
    siguiente = ahora + timedelta(seconds=demora)
    try:
        db.table("integracion_outbox").update({
            "estado": OUTBOX_ERROR,
            "ultimo_error": str(error)[:2000],
            "next_attempt_at": siguiente.isoformat(),
            "updated_at": ahora.isoformat(),
        }).eq("id", str(outbox_id)).execute()
    except Exception as update_error:
        print("[OUTBOX RETRY ERROR]", update_error)
