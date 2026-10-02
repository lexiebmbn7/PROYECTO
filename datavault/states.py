from __future__ import annotations

from fastapi import HTTPException

ESTADO_PENDIENTE = "PENDIENTE"
ESTADO_APROBADO = "APROBADO"
ESTADO_RECHAZADO = "RECHAZADO"
ESTADO_ERROR = "ERROR"

ESTADO_ARCHIVO_ACTIVO = "ACTIVO"
ESTADO_ARCHIVO_ELIMINADO = "ELIMINADO"
ESTADO_ARCHIVO_ELIMINADO_EXTERNAMENTE = "ELIMINADO_EXTERNAMENTE"

PROCESAMIENTO_PENDIENTE = "PENDIENTE"
PROCESAMIENTO_PROCESANDO = "PROCESANDO"
PROCESAMIENTO_APROBADO = "APROBADO"
PROCESAMIENTO_RECHAZADO = "RECHAZADO"
PROCESAMIENTO_ERROR = "ERROR"

ESTADOS_PROCESAMIENTO = {
    PROCESAMIENTO_PENDIENTE,
    PROCESAMIENTO_PROCESANDO,
    PROCESAMIENTO_APROBADO,
    PROCESAMIENTO_RECHAZADO,
    PROCESAMIENTO_ERROR,
}


def normalizar_estado(valor, predeterminado=ESTADO_PENDIENTE) -> str:
    texto = str(valor or "").strip().upper().replace(" ", "_")
    alias = {
        "PENDING": ESTADO_PENDIENTE,
        "EN_COLA": ESTADO_PENDIENTE,
        "PENDIENTE": ESTADO_PENDIENTE,
        "APPROVED": ESTADO_APROBADO,
        "APROBADA": ESTADO_APROBADO,
        "APROBADO": ESTADO_APROBADO,
        "REJECTED": ESTADO_RECHAZADO,
        "RECHAZADA": ESTADO_RECHAZADO,
        "RECHAZADO": ESTADO_RECHAZADO,
        "FAILED": ESTADO_ERROR,
        "FALLO": ESTADO_ERROR,
        "ERROR": ESTADO_ERROR,
    }
    return alias.get(texto, texto or predeterminado)


def normalizar_estado_archivo(valor, predeterminado=ESTADO_ARCHIVO_ACTIVO) -> str:
    texto = str(valor or "").strip().upper().replace(" ", "_")
    alias = {
        "ACTIVE": ESTADO_ARCHIVO_ACTIVO,
        "ACTIVO": ESTADO_ARCHIVO_ACTIVO,
        "DELETED": ESTADO_ARCHIVO_ELIMINADO,
        "ELIMINADO": ESTADO_ARCHIVO_ELIMINADO,
        "TRASHED": ESTADO_ARCHIVO_ELIMINADO,
        "ELIMINADO_EXTERNAMENTE": ESTADO_ARCHIVO_ELIMINADO_EXTERNAMENTE,
    }
    return alias.get(texto, texto or predeterminado)


def normalizar_procesamiento(valor, predeterminado=PROCESAMIENTO_PENDIENTE) -> str:
    texto = str(valor or "").strip().upper().replace(" ", "_")
    alias = {
        "EN_COLA": PROCESAMIENTO_PENDIENTE,
        "PENDING": PROCESAMIENTO_PENDIENTE,
        "PENDIENTE": PROCESAMIENTO_PENDIENTE,
        "PROCESSING": PROCESAMIENTO_PROCESANDO,
        "PROCESANDO": PROCESAMIENTO_PROCESANDO,
        "SUCCESS": PROCESAMIENTO_APROBADO,
        "COMPLETADO": PROCESAMIENTO_APROBADO,
        "APROBADO": PROCESAMIENTO_APROBADO,
        "REJECTED": PROCESAMIENTO_RECHAZADO,
        "RECHAZADO": PROCESAMIENTO_RECHAZADO,
        "FAILED": PROCESAMIENTO_ERROR,
        "FALLO": PROCESAMIENTO_ERROR,
        "ERROR": PROCESAMIENTO_ERROR,
    }
    salida = alias.get(texto, texto or predeterminado)
    return salida if salida in ESTADOS_PROCESAMIENTO else predeterminado


def detalle_error(codigo: str, mensaje: str, contexto=None) -> dict:
    detalle = {
        "code": str(codigo or "ERROR").strip().upper(),
        "message": str(mensaje or "Error no especificado."),
    }
    if contexto not in (None, {}, []):
        detalle["context"] = contexto
    return detalle


def error_api(status_code: int, codigo: str, mensaje: str, contexto=None):
    return HTTPException(
        status_code=status_code,
        detail=detalle_error(codigo, mensaje, contexto),
    )
