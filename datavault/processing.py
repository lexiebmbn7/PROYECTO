from __future__ import annotations

from datetime import datetime, timezone

from .states import (
    PROCESAMIENTO_APROBADO,
    PROCESAMIENTO_ERROR,
    PROCESAMIENTO_PENDIENTE,
    PROCESAMIENTO_PROCESANDO,
    PROCESAMIENTO_RECHAZADO,
    normalizar_procesamiento,
)

TERMINALES = {
    PROCESAMIENTO_APROBADO,
    PROCESAMIENTO_RECHAZADO,
    PROCESAMIENTO_ERROR,
}


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def actualizar_estado_procesamiento(
    db,
    tabla: str,
    filtros: dict,
    estado: str,
    *,
    error: str | None = None,
    incrementar_intento: bool = False,
):
    """Actualiza la fase técnica sin alterar el estado de negocio.

    ``estado`` de las tablas sigue representando la decisión DLP
    (PENDIENTE/APROBADO/RECHAZADO). ``estado_procesamiento`` representa lo que
    está haciendo el backend en ese momento.
    """

    estado = normalizar_procesamiento(estado)
    ahora = _ahora_iso()

    payload = {
        "estado_procesamiento": estado,
        "ultimo_error_procesamiento": str(error)[:2000] if error else None,
        "procesamiento_actualizado_at": ahora,
    }

    if estado == PROCESAMIENTO_PROCESANDO:
        payload["procesamiento_iniciado_at"] = ahora
        payload["procesamiento_finalizado_at"] = None
    elif estado in TERMINALES:
        payload["procesamiento_finalizado_at"] = ahora

    # Incremento conservador: se consulta primero porque PostgREST no permite
    # una expresión ``intentos = intentos + 1`` dentro de update JSON.
    if incrementar_intento:
        try:
            consulta = db.table(tabla).select("id,intentos_procesamiento")
            for columna, valor in filtros.items():
                consulta = consulta.eq(columna, valor)
            filas = consulta.execute().data or []
            for fila in filas:
                intento = int(fila.get("intentos_procesamiento") or 0) + 1
                db.table(tabla).update({
                    **payload,
                    "intentos_procesamiento": intento,
                }).eq("id", fila.get("id")).execute()
            return filas
        except Exception:
            # Si no puede incrementar, todavía intentamos guardar el estado.
            pass

    query = db.table(tabla).update(payload)
    for columna, valor in filtros.items():
        query = query.eq(columna, valor)
    return query.execute().data or []


def marcar_pendiente(db, tabla: str, filtros: dict):
    return actualizar_estado_procesamiento(
        db, tabla, filtros, PROCESAMIENTO_PENDIENTE
    )


def marcar_procesando(db, tabla: str, filtros: dict):
    return actualizar_estado_procesamiento(
        db,
        tabla,
        filtros,
        PROCESAMIENTO_PROCESANDO,
        incrementar_intento=True,
    )


def marcar_aprobado(db, tabla: str, filtros: dict):
    return actualizar_estado_procesamiento(
        db, tabla, filtros, PROCESAMIENTO_APROBADO
    )


def marcar_rechazado(db, tabla: str, filtros: dict):
    return actualizar_estado_procesamiento(
        db, tabla, filtros, PROCESAMIENTO_RECHAZADO
    )


def marcar_error(db, tabla: str, filtros: dict, error: str):
    return actualizar_estado_procesamiento(
        db, tabla, filtros, PROCESAMIENTO_ERROR, error=error
    )
