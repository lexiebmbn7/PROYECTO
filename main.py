import hashlib
import io
import mimetypes
import os
import threading
import requests
from uuid import UUID, uuid4
from typing import List

from fastapi import FastAPI, File, UploadFile, Request, Form, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from supabase import create_client, Client

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload


# ============================================================
# DATAVAULT DLP | GM INGENIEROS Y CONSULTORES
# ============================================================

app = FastAPI(
    title="DataVault DLP API | GM Ingenieros y Consultores"
)

# Exponer la carpeta física "images" para archivos estáticos
app.mount("/images", StaticFiles(directory="images"), name="images")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# CONFIGURACIÓN DESDE RAILWAY Y GOOGLE DRIVE
# ============================================================

TELEGRAM_TOKEN = os.getenv(
    "TELEGRAM_TOKEN",
    ""
).strip()


AUTHORIZED_CHAT_IDS_RAW = os.getenv(
    "AUTHORIZED_CHAT_IDS",
    "8893414961,6718944855"
).strip()


SUPABASE_URL = os.getenv(
    "SUPABASE_URL",
    "https://crujlbbhtkcithullgfs.supabase.co"
).strip()


SUPABASE_KEY = os.getenv(
    "SUPABASE_KEY",
    ""
).strip()


PUBLIC_BASE_URL = os.getenv(
    "PUBLIC_BASE_URL",
    ""
).strip().rstrip("/")


RAILWAY_PUBLIC_DOMAIN = os.getenv(
    "RAILWAY_PUBLIC_DOMAIN",
    ""
).strip()


GOOGLE_CLIENT_ID = os.getenv(
    "GOOGLE_CLIENT_ID",
    ""
).strip()


GOOGLE_CLIENT_SECRET = os.getenv(
    "GOOGLE_CLIENT_SECRET",
    ""
).strip()


GOOGLE_REFRESH_TOKEN = os.getenv(
    "GOOGLE_REFRESH_TOKEN",
    ""
).strip()


GOOGLE_FOLDER_ID = os.getenv(
    "GOOGLE_FOLDER_ID",
    ""
).strip()


if not PUBLIC_BASE_URL and RAILWAY_PUBLIC_DOMAIN:

    PUBLIC_BASE_URL = (
        f"https://{RAILWAY_PUBLIC_DOMAIN}"
    ).rstrip("/")


ARCHIVOS_EN_RAM = {}
DECISION_LOCK = threading.Lock()

# Límites de prueba para carga por lotes. Se pueden cambiar en Railway.
MAX_BATCH_FILES = int(os.getenv("MAX_BATCH_FILES", "100"))
MAX_FILE_SIZE_MB = int(os.getenv("MAX_FILE_SIZE_MB", "25"))
MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024


# ============================================================
# GOOGLE DRIVE UPLOAD
# ============================================================

def google_drive_configurado() -> bool:
    return all([
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        GOOGLE_REFRESH_TOKEN,
        GOOGLE_FOLDER_ID
    ])


def obtener_servicio_google_drive():
    if not google_drive_configurado():
        raise RuntimeError("Faltan variables de Google Drive")

    creds = Credentials(
        token=None,
        refresh_token=GOOGLE_REFRESH_TOKEN,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=GOOGLE_CLIENT_ID,
        client_secret=GOOGLE_CLIENT_SECRET,
    )

    return build(
        "drive",
        "v3",
        credentials=creds,
        cache_discovery=False
    )


def crear_carpeta_google_drive(service, nombre: str, parent_id: str):
    metadata = {
        "name": nombre,
        "mimeType": "application/vnd.google-apps.folder",
        "parents": [parent_id],
    }

    respuesta = (
        service
        .files()
        .create(
            body=metadata,
            fields="id,name",
            supportsAllDrives=True,
        )
        .execute()
    )

    carpeta_id = respuesta.get("id")
    if not carpeta_id:
        raise RuntimeError(f"Google Drive no devolvió ID para la carpeta {nombre}")

    return carpeta_id


def subir_archivo_google_drive_en_carpeta(
    service,
    nombre_archivo: str,
    contenido_bytes: bytes,
    parent_id: str,
):
    if not contenido_bytes:
        raise RuntimeError(f"El archivo {nombre_archivo} está vacío")

    mime_type = (
        mimetypes.guess_type(nombre_archivo)[0]
        or "application/octet-stream"
    )

    media = MediaIoBaseUpload(
        io.BytesIO(contenido_bytes),
        mimetype=mime_type,
        resumable=False,
    )

    respuesta = (
        service
        .files()
        .create(
            body={
                "name": nombre_archivo,
                "parents": [parent_id],
            },
            media_body=media,
            fields="id,name",
            supportsAllDrives=True,
        )
        .execute()
    )

    archivo_id = respuesta.get("id")
    if not archivo_id:
        raise RuntimeError(f"Google Drive no devolvió ID para {nombre_archivo}")

    return archivo_id


def subir_a_google_drive(
    nombre_archivo: str,
    contenido_bytes: bytes
):
    """Sube un archivo individual directamente desde RAM a Google Drive."""

    if not google_drive_configurado():
        print("[DRIVE CONFIG ERROR] Faltan variables de Google Drive")
        return None

    if not contenido_bytes:
        print("[DRIVE ERROR] El contenido recibido está vacío")
        return None

    try:
        service = obtener_servicio_google_drive()
        drive_id = subir_archivo_google_drive_en_carpeta(
            service,
            nombre_archivo,
            contenido_bytes,
            GOOGLE_FOLDER_ID,
        )

        print(
            f"[DRIVE SUCCESS] {nombre_archivo} "
            f"subido con ID: {drive_id}"
        )
        return drive_id

    except Exception as e:
        print(f"[DRIVE EXCEPTION] Error al transferir a Drive: {e}")
        return None


def obtener_carpeta_desde_ruta(ruta_relativa: str):
    ruta = str(ruta_relativa or "").replace("\\", "/").strip("/")
    partes = [p for p in ruta.split("/") if p not in ("", ".", "..")]

    # webkitRelativePath de una carpeta incluye: Carpeta/archivo.ext
    if len(partes) < 2:
        return None

    return partes[0]


def subir_lote_carpeta_a_drive(documentos: list):
    """Sube un lote proveniente de una carpeta como UNA carpeta en Drive.

    Mantiene las subcarpetas. Si cualquier archivo falla, intenta borrar la
    carpeta raíz creada y devuelve None. Supabase/RAM se actualizan después,
    únicamente si todos los archivos llegaron correctamente a Drive.
    """

    if not documentos:
        return None

    if not google_drive_configurado():
        print("[DRIVE LOTE CONFIG ERROR] Faltan variables de Google Drive")
        return None

    preparados = []

    for documento in documentos:
        auditoria_id = str(documento.get("id") or "").strip()
        archivo_ram = ARCHIVOS_EN_RAM.get(auditoria_id)

        if not auditoria_id or not archivo_ram:
            print(
                "[DRIVE LOTE ERROR] Archivo no disponible en RAM:",
                auditoria_id,
            )
            return None

        ruta = str(
            documento.get("ruta_relativa")
            or archivo_ram.get("ruta_relativa")
            or documento.get("nombre_archivo")
            or archivo_ram.get("nombre")
            or "archivo"
        ).replace("\\", "/").strip("/")

        preparados.append({
            "documento": documento,
            "ram": archivo_ram,
            "ruta": ruta,
        })

    nombre_carpeta = obtener_carpeta_desde_ruta(preparados[0]["ruta"])
    if not nombre_carpeta:
        lote_id = str(documentos[0].get("lote_id") or "lote")
        nombre_carpeta = f"LOTE_{lote_id[:8]}"

    service = None
    carpeta_raiz_id = None

    try:
        service = obtener_servicio_google_drive()
        carpeta_raiz_id = crear_carpeta_google_drive(
            service,
            nombre_carpeta,
            GOOGLE_FOLDER_ID,
        )

        # Cache de subcarpetas ya creadas dentro de esta carpeta nueva.
        carpetas_cache = {"": carpeta_raiz_id}
        archivos_drive = []

        for item in preparados:
            ruta = item["ruta"]
            partes = [p for p in ruta.split("/") if p]

            # Quitar el nombre de la carpeta raíz del webkitRelativePath.
            if partes and partes[0] == nombre_carpeta:
                partes = partes[1:]

            if not partes:
                partes = [item["documento"].get("nombre_archivo") or "archivo"]

            nombre_drive = partes[-1]
            subdirectorios = partes[:-1]
            parent_id = carpeta_raiz_id
            ruta_cache = ""

            for directorio in subdirectorios:
                ruta_cache = f"{ruta_cache}/{directorio}" if ruta_cache else directorio

                if ruta_cache not in carpetas_cache:
                    carpetas_cache[ruta_cache] = crear_carpeta_google_drive(
                        service,
                        directorio,
                        parent_id,
                    )

                parent_id = carpetas_cache[ruta_cache]

            archivo_drive_id = subir_archivo_google_drive_en_carpeta(
                service,
                nombre_drive,
                item["ram"]["contenido"],
                parent_id,
            )
            archivos_drive.append(archivo_drive_id)

        print(
            f"[DRIVE LOTE SUCCESS] carpeta={nombre_carpeta} "
            f"archivos={len(archivos_drive)} id={carpeta_raiz_id}"
        )

        return {
            "folder_id": carpeta_raiz_id,
            "folder_name": nombre_carpeta,
            "file_ids": archivos_drive,
        }

    except Exception as error:
        print(f"[DRIVE LOTE EXCEPTION] {error}")

        # Todo el lote se creó debajo de una carpeta nueva. Si hubo un fallo,
        # eliminamos esa carpeta para no dejar una transferencia parcial.
        if service and carpeta_raiz_id:
            try:
                (
                    service
                    .files()
                    .delete(
                        fileId=carpeta_raiz_id,
                        supportsAllDrives=True,
                    )
                    .execute()
                )
                print(f"[DRIVE LOTE ROLLBACK] carpeta eliminada {carpeta_raiz_id}")
            except Exception as rollback_error:
                print(f"[DRIVE LOTE ROLLBACK ERROR] {rollback_error}")

        return None


# ============================================================
# CARGAR IDS DE TELEGRAM
# ============================================================

def cargar_ids_autorizados():

    ids = []

    for valor in AUTHORIZED_CHAT_IDS_RAW.split(","):

        valor = valor.strip()

        if not valor:
            continue

        try:

            ids.append(
                int(valor)
            )

        except ValueError:

            print(
                f"[CONFIG] Telegram ID inválido "
                f"ignorado: {valor}"
            )

    return ids


AUTHORIZED_CHAT_IDS = cargar_ids_autorizados()


# ============================================================
# SUPABASE
# ============================================================

if not SUPABASE_URL:

    raise RuntimeError(
        "SUPABASE_URL no está configurado."
    )


if not SUPABASE_KEY:

    raise RuntimeError(
        "SUPABASE_KEY no está configurado en Railway."
    )


supabase: Client = create_client(
    SUPABASE_URL,
    SUPABASE_KEY
)


# ============================================================
# IDENTIDAD REAL DEL USUARIO DESDE SUPABASE AUTH
# ============================================================

def obtener_usuario_supabase_desde_request(request: Request) -> dict:

    authorization = request.headers.get("Authorization", "").strip()

    if not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=401,
            detail="Sesión de Supabase no enviada."
        )

    access_token = authorization.split(" ", 1)[1].strip()

    if not access_token:
        raise HTTPException(
            status_code=401,
            detail="Token de Supabase vacío."
        )

    try:
        respuesta = requests.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {access_token}"
            },
            timeout=15
        )
    except requests.RequestException as error:
        print("[SUPABASE AUTH ERROR]", error)
        raise HTTPException(
            status_code=503,
            detail="No se pudo validar la sesión con Supabase."
        )

    if respuesta.status_code != 200:
        print(
            "[SUPABASE AUTH REJECTED]",
            respuesta.status_code,
            respuesta.text[:500]
        )
        raise HTTPException(
            status_code=401,
            detail="Sesión de Supabase inválida o expirada."
        )

    usuario = respuesta.json()

    solicitante_id = str(usuario.get("id") or "").strip()
    solicitante_correo = str(usuario.get("email") or "").strip()
    metadata = usuario.get("user_metadata") or {}

    solicitante_nombre = str(
        metadata.get("full_name")
        or metadata.get("name")
        or solicitante_correo
        or "Usuario desconocido"
    ).strip()

    if not solicitante_id:
        raise HTTPException(
            status_code=401,
            detail="Supabase no devolvió el UID del usuario."
        )

    return {
        "id": solicitante_id,
        "nombre": solicitante_nombre,
        "correo": solicitante_correo
    }


# ============================================================
# TELEGRAM
# ============================================================

def telegram_request(
    metodo: str,
    payload: dict
):

    if not TELEGRAM_TOKEN:

        return {
            "ok": False,
            "description":
                "TELEGRAM_TOKEN no configurado"
        }


    url = (
        f"https://api.telegram.org/"
        f"bot{TELEGRAM_TOKEN}/{metodo}"
    )


    try:

        response = requests.post(
            url,
            json=payload,
            timeout=15
        )


        try:

            data = response.json()

        except Exception:

            data = {
                "ok": False,
                "description": response.text
            }


        print(
            f"[TELEGRAM] {metodo} "
            f"HTTP={response.status_code} "
            f"respuesta={data}"
        )


        return data


    except Exception as error:

        print(
            f"[TELEGRAM ERROR] "
            f"{metodo}: {error}"
        )


        return {
            "ok": False,
            "description": str(error)
        }




# ============================================================
# MENÚ TELEGRAM - USUARIOS -> ARCHIVOS -> DECISIÓN
# ============================================================

def obtener_documentos_pendientes():
    """Obtiene documentos PENDIENTES con datos para agrupar carpetas."""
    try:
        respuesta = (
            supabase
            .table("auditoria_custodia")
            .select(
                "id,nombre_archivo,hash_sha256,tamano_bytes,estado,fecha_solicitud,"
                "solicitante_id,solicitante_nombre,solicitante_correo,"
                "lote_id,ruta_relativa"
            )
            .eq("estado", "PENDIENTE")
            .execute()
        )
        return respuesta.data or []
    except Exception as error:
        print("[MENU TELEGRAM ERROR]", error)
        return []


def info_carpeta_documento(documento: dict):
    lote_id = str(documento.get("lote_id") or "").strip()
    ruta = str(documento.get("ruta_relativa") or "").replace("\\", "/").strip("/")

    if not lote_id or "/" not in ruta:
        return None

    nombre_carpeta = obtener_carpeta_desde_ruta(ruta)
    if not nombre_carpeta:
        return None

    return {
        "lote_id": lote_id,
        "nombre": nombre_carpeta,
    }


def mostrar_menu_usuarios(chat_id, message_id=None):
    """Muestra usuarios; una carpeta completa cuenta como una sola unidad."""
    documentos = obtener_documentos_pendientes()
    usuarios = {}

    for documento in documentos:
        solicitante_id = str(documento.get("solicitante_id") or "").strip()
        if not solicitante_id:
            continue

        if solicitante_id not in usuarios:
            usuarios[solicitante_id] = {
                "nombre": (
                    documento.get("solicitante_nombre")
                    or documento.get("solicitante_correo")
                    or "Usuario"
                ),
                "correo": documento.get("solicitante_correo") or "",
                "carpetas": set(),
                "archivos_sueltos": 0,
            }

        info_carpeta = info_carpeta_documento(documento)
        if info_carpeta:
            usuarios[solicitante_id]["carpetas"].add(info_carpeta["lote_id"])
        else:
            usuarios[solicitante_id]["archivos_sueltos"] += 1

    usuarios_ordenados = sorted(
        usuarios.items(),
        key=lambda item: str(item[1]["nombre"]).lower(),
    )

    botones = []

    for uid, usuario in usuarios_ordenados:
        n_carpetas = len(usuario["carpetas"])
        n_archivos = usuario["archivos_sueltos"]
        partes = []

        if n_carpetas:
            partes.append(f"{n_carpetas} carpeta" if n_carpetas == 1 else f"{n_carpetas} carpetas")
        if n_archivos:
            partes.append(f"{n_archivos} archivo" if n_archivos == 1 else f"{n_archivos} archivos")

        resumen = " + ".join(partes) if partes else "sin pendientes"

        botones.append([{
            "text": f"👤 {usuario['nombre']} · {resumen}",
            "callback_data": f"usr:{uid}",
        }])

    botones.append([{
        "text": "🔄 Actualizar",
        "callback_data": "menu:usuarios",
    }])

    if usuarios:
        texto = (
            "🛡️ DataVault DLP - GM Ingenieros\n\n"
            "📂 DOCUMENTOS PENDIENTES\n\n"
            "Seleccione un usuario:"
        )
    else:
        texto = (
            "🛡️ DataVault DLP - GM Ingenieros\n\n"
            "✅ No existen documentos pendientes."
        )

    payload = {
        "chat_id": chat_id,
        "text": texto,
        "reply_markup": {"inline_keyboard": botones},
    }

    if message_id:
        payload["message_id"] = message_id
        return telegram_request("editMessageText", payload)

    return telegram_request("sendMessage", payload)


def mostrar_archivos_usuario(chat_id, message_id, solicitante_id):
    """Muestra carpetas como una sola opción y archivos sueltos individualmente."""
    try:
        respuesta = (
            supabase
            .table("auditoria_custodia")
            .select(
                "id,nombre_archivo,tamano_bytes,fecha_solicitud,"
                "solicitante_id,solicitante_nombre,solicitante_correo,"
                "lote_id,ruta_relativa"
            )
            .eq("solicitante_id", solicitante_id)
            .eq("estado", "PENDIENTE")
            .order("fecha_solicitud", desc=True)
            .execute()
        )
        archivos = respuesta.data or []
    except Exception as error:
        print("[ARCHIVOS USUARIO ERROR]", error)
        archivos = []

    if not archivos:
        return mostrar_menu_usuarios(chat_id, message_id)

    nombre_usuario = (
        archivos[0].get("solicitante_nombre")
        or archivos[0].get("solicitante_correo")
        or "Usuario"
    )
    correo = archivos[0].get("solicitante_correo") or ""

    carpetas = {}
    sueltos = []

    for archivo in archivos:
        info = info_carpeta_documento(archivo)

        if info:
            lote_id = info["lote_id"]
            if lote_id not in carpetas:
                carpetas[lote_id] = {
                    "nombre": info["nombre"],
                    "cantidad": 0,
                    "tamano": 0,
                }
            carpetas[lote_id]["cantidad"] += 1
            carpetas[lote_id]["tamano"] += int(archivo.get("tamano_bytes") or 0)
        else:
            sueltos.append(archivo)

    botones = []

    # Una carpeta = un único botón, aunque contenga 80 archivos.
    for lote_id, carpeta in carpetas.items():
        nombre = carpeta["nombre"]
        if len(nombre) > 30:
            nombre = nombre[:27] + "..."

        botones.append([{
            "text": f"📁 {nombre} · {carpeta['cantidad']} archivos",
            "callback_data": f"lot:{lote_id}",
        }])

    # Los archivos seleccionados de forma suelta siguen siendo individuales.
    for archivo in sueltos:
        nombre = archivo.get("nombre_archivo") or "Archivo"
        nombre_boton = nombre if len(nombre) <= 42 else nombre[:39] + "..."

        botones.append([{
            "text": f"📄 {nombre_boton}",
            "callback_data": f"doc:{archivo['id']}",
        }])

    botones.append([{
        "text": "🔙 Usuarios",
        "callback_data": "menu:usuarios",
    }])

    resumen = []
    if carpetas:
        resumen.append(f"{len(carpetas)} carpeta(s)")
    if sueltos:
        resumen.append(f"{len(sueltos)} archivo(s) suelto(s)")

    texto = (
        f"👤 {nombre_usuario}\n"
        f"📧 {correo}\n\n"
        f"📂 {' + '.join(resumen)} pendiente(s)\n\n"
        "Seleccione una carpeta o archivo:"
    )

    return telegram_request(
        "editMessageText",
        {
            "chat_id": chat_id,
            "message_id": message_id,
            "text": texto,
            "reply_markup": {"inline_keyboard": botones},
        },
    )


def mostrar_detalle_lote(chat_id, message_id, lote_id):
    """Muestra una carpeta/lote completo como una sola decisión."""
    try:
        respuesta = (
            supabase
            .table("auditoria_custodia")
            .select(
                "id,nombre_archivo,hash_sha256,tamano_bytes,estado,"
                "solicitante_id,solicitante_nombre,solicitante_correo,"
                "lote_id,ruta_relativa"
            )
            .eq("lote_id", lote_id)
            .eq("estado", "PENDIENTE")
            .order("fecha_solicitud", desc=False)
            .execute()
        )
        documentos = respuesta.data or []
    except Exception as error:
        print("[DETALLE LOTE ERROR]", error)
        documentos = []

    if not documentos:
        return telegram_request(
            "editMessageText",
            {
                "chat_id": chat_id,
                "message_id": message_id,
                "text": (
                    "🛡️ DataVault DLP - GM Ingenieros\n\n"
                    "⚠️ Esta carpeta ya no tiene documentos pendientes."
                ),
                "reply_markup": {
                    "inline_keyboard": [[{
                        "text": "👥 Usuarios",
                        "callback_data": "menu:usuarios",
                    }]]
                },
            },
        )

    primer = documentos[0]
    solicitante_id = str(primer.get("solicitante_id") or "").strip()
    nombre_usuario = primer.get("solicitante_nombre") or "Usuario"
    correo = primer.get("solicitante_correo") or ""
    nombre_carpeta = obtener_carpeta_desde_ruta(primer.get("ruta_relativa")) or f"LOTE_{lote_id[:8]}"
    total_bytes = sum(int(d.get("tamano_bytes") or 0) for d in documentos)

    def formato_bytes(valor):
        unidades = ["B", "KB", "MB", "GB"]
        numero = float(valor or 0)
        indice = 0
        while numero >= 1024 and indice < len(unidades) - 1:
            numero /= 1024
            indice += 1
        return f"{numero:.2f} {unidades[indice]}" if indice else f"{int(numero)} B"

    nombres = []
    for doc in documentos[:8]:
        ruta = str(doc.get("ruta_relativa") or doc.get("nombre_archivo") or "Archivo").replace("\\", "/")
        partes = [p for p in ruta.split("/") if p]
        if partes and partes[0] == nombre_carpeta:
            partes = partes[1:]
        nombres.append("/".join(partes) if partes else (doc.get("nombre_archivo") or "Archivo"))

    contenido = "\n".join(f"• {nombre}" for nombre in nombres)
    if len(documentos) > len(nombres):
        contenido += f"\n• ... y {len(documentos) - len(nombres)} archivo(s) más"

    texto = (
        "🛡️ DataVault DLP - GM Ingenieros\n\n"
        f"📁 Carpeta: {nombre_carpeta}\n"
        f"👤 Solicitante: {nombre_usuario}\n"
        f"📧 Correo: {correo}\n"
        f"📄 Archivos: {len(documentos)}\n"
        f"📦 Tamaño total: {formato_bytes(total_bytes)}\n\n"
        f"Contenido:\n{contenido}\n\n"
        "¿Autoriza la transferencia de TODA la carpeta a Google Drive?"
    )

    botones = [
        [
            {
                "text": "✅ Aprobar carpeta",
                "callback_data": f"aplot:{lote_id}",
            },
            {
                "text": "❌ Rechazar carpeta",
                "callback_data": f"relot:{lote_id}",
            },
        ],
        [
            {
                "text": "🔙 Volver",
                "callback_data": f"usr:{solicitante_id}",
            },
            {
                "text": "👥 Usuarios",
                "callback_data": "menu:usuarios",
            },
        ],
    ]

    return telegram_request(
        "editMessageText",
        {
            "chat_id": chat_id,
            "message_id": message_id,
            "text": texto,
            "reply_markup": {"inline_keyboard": botones},
        },
    )


def mostrar_detalle_documento(chat_id, message_id, auditoria_id):
    """Muestra un archivo suelto y sus botones Aprobar/Rechazar."""
    try:
        respuesta = (
            supabase
            .table("auditoria_custodia")
            .select(
                "id,nombre_archivo,hash_sha256,estado,"
                "solicitante_id,solicitante_nombre,solicitante_correo"
            )
            .eq("id", auditoria_id)
            .limit(1)
            .execute()
        )

        if not respuesta.data:
            raise ValueError("No existe el documento seleccionado.")

        documento = respuesta.data[0]
    except Exception as error:
        print("[DETALLE DOCUMENTO ERROR]", error)
        return telegram_request(
            "editMessageText",
            {
                "chat_id": chat_id,
                "message_id": message_id,
                "text": (
                    "🛡️ DataVault DLP - GM Ingenieros\n\n"
                    "❌ No se pudo cargar el documento seleccionado."
                ),
                "reply_markup": {
                    "inline_keyboard": [[{
                        "text": "👥 Usuarios",
                        "callback_data": "menu:usuarios",
                    }]]
                },
            },
        )

    solicitante_id = str(documento.get("solicitante_id") or "").strip()
    estado = documento.get("estado") or "DESCONOCIDO"

    if estado != "PENDIENTE":
        texto = (
            "🛡️ DataVault DLP - GM Ingenieros\n\n"
            f"📁 Archivo: {documento.get('nombre_archivo') or 'Archivo'}\n"
            f"👤 Solicitante: {documento.get('solicitante_nombre') or 'Usuario'}\n\n"
            f"⚠️ Este documento ya fue procesado.\n"
            f"Estado actual: {estado}"
        )
        botones = [[{
            "text": "👥 Usuarios",
            "callback_data": "menu:usuarios",
        }]]
    else:
        texto = (
            "🛡️ DataVault DLP - GM Ingenieros\n\n"
            f"📁 Archivo: {documento.get('nombre_archivo') or 'Archivo'}\n"
            f"👤 Solicitante: {documento.get('solicitante_nombre') or 'Usuario'}\n"
            f"📧 Correo: {documento.get('solicitante_correo') or ''}\n\n"
            f"🔑 Hash SHA-256:\n{documento.get('hash_sha256') or ''}\n\n"
            f"🆔 Auditoría:\n{documento.get('id')}\n\n"
            "¿Autoriza su transferencia a la custodia corporativa?"
        )

        botones = [
            [
                {
                    "text": "✅ Aprobar",
                    "callback_data": f"aprobar:{auditoria_id}",
                },
                {
                    "text": "❌ Rechazar",
                    "callback_data": f"rechazar:{auditoria_id}",
                },
            ],
            [
                {
                    "text": "🔙 Archivos",
                    "callback_data": f"usr:{solicitante_id}",
                },
                {
                    "text": "👥 Usuarios",
                    "callback_data": "menu:usuarios",
                },
            ],
        ]

    return telegram_request(
        "editMessageText",
        {
            "chat_id": chat_id,
            "message_id": message_id,
            "text": texto,
            "reply_markup": {"inline_keyboard": botones},
        },
    )


# ============================================================
# OBTENER DOMINIO ACTUAL DE RAILWAY
# ============================================================

def obtener_base_url_request(
    request: Request
):

    forwarded_host = request.headers.get(
        "x-forwarded-host",
        ""
    ).strip()


    host = (
        forwarded_host
        or request.headers.get(
            "host",
            ""
        ).strip()
    )


    forwarded_proto = request.headers.get(
        "x-forwarded-proto",
        ""
    ).strip()


    proto = (
        forwarded_proto
        or request.url.scheme
        or "https"
    )


    if (
        host.endswith(".railway.app")
        or host.endswith(".up.railway.app")
    ):

        proto = "https"


    if host:

        return (
            f"{proto}://{host}"
        ).rstrip("/")


    return str(
        request.base_url
    ).rstrip("/")


# ============================================================
# CONFIGURAR WEBHOOK
# ============================================================

def configurar_webhook_url(
    base_url: str
):

    if not TELEGRAM_TOKEN:

        return {
            "ok": False,
            "description":
                "TELEGRAM_TOKEN no configurado"
        }


    base_url = (
        base_url
        or ""
    ).strip().rstrip("/")


    if not base_url:

        return {
            "ok": False,
            "description":
                "No se pudo determinar "
                "la URL pública"
        }


    webhook_url = (
        f"{base_url}/telegram-webhook"
    )


    info = telegram_request(
        "getWebhookInfo",
        {}
    )


    if info.get("ok"):

        url_actual = (
            info
            .get(
                "result",
                {}
            )
            .get(
                "url",
                ""
            )
        )

    else:

        url_actual = ""


    # Si ya está bien, no hacer nada.
    if url_actual == webhook_url:

        return {
            "ok": True,
            "webhook": webhook_url,
            "changed": False
        }


    resultado = telegram_request(

        "setWebhook",

        {
            "url":
                webhook_url,

            "allowed_updates":
                [
                    "message",
                    "callback_query"
                ],

            "drop_pending_updates":
                False
        }

    )


    return {
        "ok":
            resultado.get(
                "ok",
                False
            ),

        "webhook":
            webhook_url,

        "changed":
            True,

        "telegram":
            resultado
    }


# ============================================================
# INICIO DE SERVIDOR
# ============================================================

@app.on_event("startup")
def startup_event():

    print("=" * 60)

    print(
        "DATAVAULT DLP INICIADO"
    )

    print(
        "Google Drive:",
        "CONFIGURADO" if google_drive_configurado() else "NO CONFIGURADO"
    )

    print(
        "Telegram autorizados:",
        AUTHORIZED_CHAT_IDS
    )

    print(
        "PUBLIC_BASE_URL:",
        PUBLIC_BASE_URL
        or "(se detectará al subir)"
    )

    print("=" * 60)


    if PUBLIC_BASE_URL:

        print(

            "[WEBHOOK STARTUP]",

            configurar_webhook_url(
                PUBLIC_BASE_URL
            )

        )


# ============================================================
# WEB
# ============================================================

@app.get(
    "/",
    response_class=HTMLResponse
)
async def read_index():

    if os.path.exists(
        "index.html"
    ):

        with open(
            "index.html",
            "r",
            encoding="utf-8"
        ) as archivo:

            return archivo.read()


    return """
    <h1>DataVault DLP API activa</h1>
    """


# ============================================================
# HEALTH
# ============================================================

@app.get("/health")
def health_check():

    return {

        "status":
            "ok",

        "service":
            (
                "DataVault DLP API | "
                "GM Ingenieros y Consultores"
            ),

        "telegram_configurado":
            bool(
                TELEGRAM_TOKEN
            ),

        "usuarios_telegram":
            len(
                AUTHORIZED_CHAT_IDS
            ),

        "supabase_configurado":
            bool(
                SUPABASE_URL
                and
                SUPABASE_KEY
            ),

        "google_drive_configurado":
            google_drive_configurado(),

        "google_folder_id":
            GOOGLE_FOLDER_ID
            or None,

        "public_url":
            PUBLIC_BASE_URL
            or None
    }


# ============================================================
# INFORMACIÓN DEL WEBHOOK
# ============================================================

@app.get("/telegram-info")
def telegram_info():

    if not TELEGRAM_TOKEN:

        return {
            "ok": False,
            "error":
                "TELEGRAM_TOKEN no configurado"
        }


    return telegram_request(
        "getWebhookInfo",
        {}
    )


# ============================================================
# FORZAR WEBHOOK MANUALMENTE
# ============================================================

@app.get("/set-webhook")
def set_webhook_manual(
    request: Request
):

    base_url = obtener_base_url_request(
        request
    )


    return configurar_webhook_url(
        base_url
    )


# ============================================================
# SUBIR ARCHIVO
# ============================================================

@app.post("/upload")
async def registrar_y_solicitar_custodia(

    request: Request,

    file: UploadFile = File(...),

    carpeta: str = Form(
        "PLANOS"
    )

):

    # --------------------------------------------------------
    # VALIDAR SESIÓN E IDENTIDAD REAL EN SUPABASE AUTH
    # --------------------------------------------------------

    usuario_auth = obtener_usuario_supabase_desde_request(request)

    solicitante_id = usuario_auth["id"]
    solicitante_nombre = usuario_auth["nombre"]
    solicitante_correo = usuario_auth["correo"]

    # Mantener compatibilidad con los mensajes y la columna antigua
    usuario = solicitante_nombre


    # --------------------------------------------------------
    # VALIDAR TELEGRAM
    # --------------------------------------------------------

    if not TELEGRAM_TOKEN:

        raise HTTPException(

            status_code=500,

            detail=(
                "TELEGRAM_TOKEN "
                "no está configurado."
            )

        )


    if not AUTHORIZED_CHAT_IDS:

        raise HTTPException(

            status_code=500,

            detail=(
                "No hay Telegram IDs "
                "autorizados."
            )

        )


    # --------------------------------------------------------
    # ASEGURAR WEBHOOK CORRECTO
    # --------------------------------------------------------

    base_url_actual = obtener_base_url_request(
        request
    )


    estado_webhook = configurar_webhook_url(
        base_url_actual
    )


    print(
        "[WEBHOOK UPLOAD]",
        estado_webhook
    )


    # --------------------------------------------------------
    # LEER ARCHIVO EN RAM
    # --------------------------------------------------------

    contenido = await file.read()


    if not contenido:

        raise HTTPException(

            status_code=400,

            detail=
                "El archivo está vacío."

        )


    # --------------------------------------------------------
    # SHA-256
    # --------------------------------------------------------

    hash_sha256 = hashlib.sha256(
        contenido
    ).hexdigest()


    # --------------------------------------------------------
    # RENOMBRAR CORRELATIVO SI YA EXISTE
    # --------------------------------------------------------

    nombre_original = file.filename or "archivo_sin_nombre"

    nombre_base, extension = os.path.splitext(nombre_original)


    try:

        res_existentes = (

            supabase

            .table("auditoria_custodia")

            .select("nombre_archivo")

            .ilike("nombre_archivo", f"{nombre_base}%{extension}")

            .execute()

        )


        archivos_existentes = res_existentes.data or []


        if archivos_existentes:

            contador = len(archivos_existentes) + 1

            nombre_final = f"{nombre_base} ({contador}){extension}"

        else:

            nombre_final = nombre_original


    except Exception as e_nombre:

        print(
            "[CORRELATIVO ERROR]",
            e_nombre
        )

        nombre_final = nombre_original


    # --------------------------------------------------------
    # REGISTRAR EN SUPABASE
    # --------------------------------------------------------

    registro = {

        "nombre_archivo":
            nombre_final,

        "hash_sha256":
            hash_sha256,

        "tamano_bytes":
            len(
                contenido
            ),

        "estado":
            "PENDIENTE",

        "usuario_solicitante":
            solicitante_nombre,

        "solicitante_id":
            solicitante_id,

        "solicitante_nombre":
            solicitante_nombre,

        "solicitante_correo":
            solicitante_correo

    }


    try:

        respuesta_db = (

            supabase

            .table(
                "auditoria_custodia"
            )

            .insert(
                registro
            )

            .execute()

        )


    except Exception as error:

        print(
            "[SUPABASE INSERT ERROR]",
            error
        )


        raise HTTPException(

            status_code=500,

            detail=(
                "No se pudo registrar "
                "en Supabase: "
                f"{error}"
            )

        )


    if not respuesta_db.data:

        raise HTTPException(

            status_code=500,

            detail=(
                "Supabase no devolvió "
                "el registro insertado."
            )

        )


    id_auditoria = (
        respuesta_db
        .data[0]
        .get("id")
    )


    # --------------------------------------------------------
    # ALMACENAR TEMPORALMENTE EN RAM
    # --------------------------------------------------------

    ARCHIVOS_EN_RAM[str(id_auditoria)] = {

        "nombre":
            nombre_final,

        "contenido":
            contenido,

        "solicitante_id":
            solicitante_id,

        "solicitante_nombre":
            solicitante_nombre,

        "solicitante_correo":
            solicitante_correo

    }


    # --------------------------------------------------------
    # NOTIFICAR MENÚ DE PENDIENTES A LOS CUSTODIOS
    # --------------------------------------------------------

    resultados_telegram = []
    enviados_correctamente = 0

    for chat_id in AUTHORIZED_CHAT_IDS:
        resultado = mostrar_menu_usuarios(chat_id)
        ok = bool(resultado.get("ok"))

        if ok:
            enviados_correctamente += 1

        resultados_telegram.append({
            "chat_id": chat_id,
            "ok": ok,
            "description": resultado.get("description", "OK"),
        })


    # --------------------------------------------------------
    # NADIE RECIBIÓ LA ALERTA
    # --------------------------------------------------------

    if enviados_correctamente == 0:

        raise HTTPException(

            status_code=502,

            detail={

                "mensaje":
                    (
                        "El archivo quedó registrado "
                        "en Supabase, pero Telegram "
                        "no pudo notificar a ningún "
                        "custodio."
                    ),

                "telegram":
                    resultados_telegram

            }

        )


    return {

        "status":
            "ok",

        "mensaje":
            (
                "Documento registrado "
                "y menú de pendientes notificado a Telegram."
            ),

        "id_auditoria":
            id_auditoria,

        "sha256":
            hash_sha256,

        "telegram_enviados":
            enviados_correctamente,

        "telegram":
            resultados_telegram,

        "webhook":
            estado_webhook

    }


# ============================================================
# APOYO PARA CARGA POR LOTES
# ============================================================

def normalizar_ruta_relativa(ruta: str, nombre_archivo: str) -> str:
    """Normaliza una ruta enviada por el navegador sin escribir nada a disco."""
    ruta_limpia = str(ruta or nombre_archivo or "archivo_sin_nombre")
    ruta_limpia = ruta_limpia.replace("\\", "/").lstrip("/")

    partes = [
        parte
        for parte in ruta_limpia.split("/")
        if parte not in ("", ".", "..")
    ]

    if not partes:
        return nombre_archivo or "archivo_sin_nombre"

    return "/".join(partes)


def obtener_nombre_correlativo(nombre_original: str) -> str:
    """Conserva la misma lógica de correlativos del endpoint individual."""
    nombre_original = nombre_original or "archivo_sin_nombre"
    nombre_base, extension = os.path.splitext(nombre_original)

    try:
        res_existentes = (
            supabase
            .table("auditoria_custodia")
            .select("nombre_archivo")
            .ilike("nombre_archivo", f"{nombre_base}%{extension}")
            .execute()
        )

        archivos_existentes = res_existentes.data or []

        if archivos_existentes:
            contador = len(archivos_existentes) + 1
            return f"{nombre_base} ({contador}){extension}"

        return nombre_original

    except Exception as error:
        print("[CORRELATIVO BATCH ERROR]", error)
        return nombre_original


# ============================================================
# SUBIR VARIOS ARCHIVOS / CARPETA COMPLETA
# ============================================================

@app.post("/upload-batch")
async def registrar_lote_custodia(
    request: Request,
    files: List[UploadFile] = File(...),
    relative_paths: List[str] = Form(default=[]),
    carpeta: str = Form("PLANOS"),
    lote_id: str = Form("")
):
    """
    Registra un lote completo manteniendo cada archivo como una auditoría
    independiente. Todos los registros comparten lote_id y conservan su
    ruta relativa cuando provienen de una carpeta seleccionada en la web.
    """

    # --------------------------------------------------------
    # IDENTIDAD REAL DESDE SUPABASE AUTH
    # --------------------------------------------------------
    usuario_auth = obtener_usuario_supabase_desde_request(request)
    solicitante_id = usuario_auth["id"]
    solicitante_nombre = usuario_auth["nombre"]
    solicitante_correo = usuario_auth["correo"]

    # --------------------------------------------------------
    # VALIDACIONES GENERALES DEL LOTE
    # --------------------------------------------------------
    if not files:
        raise HTTPException(status_code=400, detail="No se recibieron archivos.")

    if len(files) > MAX_BATCH_FILES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"El lote contiene {len(files)} archivos. "
                f"El máximo permitido actualmente es {MAX_BATCH_FILES}."
            )
        )

    if relative_paths and len(relative_paths) != len(files):
        raise HTTPException(
            status_code=400,
            detail="La cantidad de rutas relativas no coincide con la cantidad de archivos."
        )

    if not TELEGRAM_TOKEN:
        raise HTTPException(status_code=500, detail="TELEGRAM_TOKEN no está configurado.")

    if not AUTHORIZED_CHAT_IDS:
        raise HTTPException(status_code=500, detail="No hay Telegram IDs autorizados.")

    # --------------------------------------------------------
    # LOTE UUID
    # --------------------------------------------------------
    if lote_id.strip():
        try:
            lote_uuid = str(UUID(lote_id.strip()))
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(status_code=400, detail="lote_id inválido.")
    else:
        lote_uuid = str(uuid4())

    # --------------------------------------------------------
    # WEBHOOK TELEGRAM (una sola vez por lote)
    # --------------------------------------------------------
    base_url_actual = obtener_base_url_request(request)
    estado_webhook = configurar_webhook_url(base_url_actual)
    print("[WEBHOOK BATCH]", estado_webhook)

    procesados = []
    errores = []
    cancelado = False

    # --------------------------------------------------------
    # PROCESAR ARCHIVOS UNO A UNO EN RAM
    # --------------------------------------------------------
    for indice, archivo in enumerate(files):
        try:
            # Si el navegador canceló la petición, detener los pendientes.
            if await request.is_disconnected():
                cancelado = True
                print(f"[BATCH CANCELLED] lote={lote_uuid} indice={indice}")
                break
        except Exception:
            # Si la plataforma no puede informar desconexión, continuar.
            pass

        nombre_original = archivo.filename or f"archivo_{indice + 1}"
        ruta_original = (
            relative_paths[indice]
            if indice < len(relative_paths)
            else nombre_original
        )
        ruta_relativa = normalizar_ruta_relativa(ruta_original, nombre_original)

        try:
            contenido = await archivo.read()

            if not contenido:
                errores.append({
                    "archivo": nombre_original,
                    "ruta_relativa": ruta_relativa,
                    "error": "Archivo vacío"
                })
                continue

            if len(contenido) > MAX_FILE_SIZE_BYTES:
                errores.append({
                    "archivo": nombre_original,
                    "ruta_relativa": ruta_relativa,
                    "error": f"Supera el límite de {MAX_FILE_SIZE_MB} MB"
                })
                continue

            hash_sha256 = hashlib.sha256(contenido).hexdigest()
            nombre_final = obtener_nombre_correlativo(nombre_original)

            registro = {
                "nombre_archivo": nombre_final,
                "hash_sha256": hash_sha256,
                "tamano_bytes": len(contenido),
                "estado": "PENDIENTE",
                "usuario_solicitante": solicitante_nombre,
                "solicitante_id": solicitante_id,
                "solicitante_nombre": solicitante_nombre,
                "solicitante_correo": solicitante_correo,
                "lote_id": lote_uuid,
                "ruta_relativa": ruta_relativa,
            }

            respuesta_db = (
                supabase
                .table("auditoria_custodia")
                .insert(registro)
                .execute()
            )

            if not respuesta_db.data:
                raise RuntimeError("Supabase no devolvió el registro insertado.")

            id_auditoria = respuesta_db.data[0].get("id")

            ARCHIVOS_EN_RAM[str(id_auditoria)] = {
                "nombre": nombre_final,
                "contenido": contenido,
                "solicitante_id": solicitante_id,
                "solicitante_nombre": solicitante_nombre,
                "solicitante_correo": solicitante_correo,
                "lote_id": lote_uuid,
                "ruta_relativa": ruta_relativa,
                "carpeta": carpeta,
            }

            procesados.append({
                "id_auditoria": id_auditoria,
                "nombre_archivo": nombre_final,
                "ruta_relativa": ruta_relativa,
                "sha256": hash_sha256,
                "tamano_bytes": len(contenido),
            })

        except Exception as error:
            print(f"[BATCH FILE ERROR] {nombre_original}: {error}")
            errores.append({
                "archivo": nombre_original,
                "ruta_relativa": ruta_relativa,
                "error": str(error),
            })

    # --------------------------------------------------------
    # TELEGRAM: UNA SOLA NOTIFICACIÓN AL TERMINAR EL LOTE
    # --------------------------------------------------------
    resultados_telegram = []
    enviados_correctamente = 0

    if procesados:
        for chat_id in AUTHORIZED_CHAT_IDS:
            resultado = mostrar_menu_usuarios(chat_id)
            ok = bool(resultado.get("ok"))

            if ok:
                enviados_correctamente += 1

            resultados_telegram.append({
                "chat_id": chat_id,
                "ok": ok,
                "description": resultado.get("description", "OK"),
            })

    if not procesados and errores:
        raise HTTPException(
            status_code=400,
            detail={
                "mensaje": "Ningún archivo del lote pudo registrarse.",
                "lote_id": lote_uuid,
                "errores": errores,
            }
        )

    estado = "cancelado" if cancelado else ("partial" if errores else "ok")

    return {
        "status": estado,
        "mensaje": (
            "Lote cancelado parcialmente."
            if cancelado
            else (
                "Lote registrado con algunas observaciones."
                if errores
                else "Lote registrado correctamente."
            )
        ),
        "lote_id": lote_uuid,
        "total_recibidos": len(files),
        "total_registrados": len(procesados),
        "total_errores": len(errores),
        "cancelado": cancelado,
        "archivos": procesados,
        "errores": errores,
        "telegram_enviados": enviados_correctamente,
        "telegram": resultados_telegram,
        "webhook": estado_webhook,
    }


# ============================================================
# WEBHOOK TELEGRAM
# ============================================================

@app.post("/telegram-webhook")
async def recibir_respuesta_telegram(request: Request):
    data = await request.json()

    print("[TELEGRAM UPDATE]", data)

    # ========================================================
    # MENSAJES NORMALES / COMANDOS
    # ========================================================
    if "message" in data:
        message = data["message"]
        chat_id = message["chat"]["id"]
        user_id = message["from"]["id"]
        texto = message.get("text", "").strip()

        if user_id not in AUTHORIZED_CHAT_IDS:
            telegram_request(
                "sendMessage",
                {
                    "chat_id": chat_id,
                    "text": (
                        "⛔ Acceso no autorizado.\n\n"
                        f"Tu Telegram ID es: {user_id}\n\n"
                        "Agrega este ID en Railway en la variable "
                        "AUTHORIZED_CHAT_IDS."
                    ),
                },
            )
            return {
                "status": "unauthorized",
                "user_id": user_id,
            }

        texto_lower = texto.lower()

        # /start, /menu y /pendientes abren directamente el panel.
        if (
            texto_lower.startswith("/start")
            or texto_lower.startswith("/menu")
            or texto_lower.startswith("/pendientes")
        ):
            mostrar_menu_usuarios(chat_id)
            return {"status": "menu_usuarios"}

        if texto_lower.startswith("/id"):
            respuesta = (
                "🆔 Tu Telegram ID:\n\n"
                f"{user_id}"
            )
        elif texto_lower.startswith("/estado"):
            respuesta = (
                "🟢 DataVault DLP activo.\n\n"
                "Tu cuenta está autorizada."
            )
        else:
            respuesta = (
                "🛡️ DataVault DLP activo.\n\n"
                "Comandos:\n"
                "/pendientes - Abrir documentos pendientes\n"
                "/menu - Abrir menú\n"
                "/id - Ver tu Telegram ID\n"
                "/estado - Verificar conexión"
            )

        telegram_request(
            "sendMessage",
            {
                "chat_id": chat_id,
                "text": respuesta,
            },
        )
        return {"status": "message_processed"}

    # ========================================================
    # CALLBACKS DE BOTONES
    # ========================================================
    if "callback_query" in data:
        callback = data["callback_query"]
        callback_id = callback["id"]
        user_id = callback["from"]["id"]
        action_data = callback.get("data", "")
        message = callback.get("message", {})
        chat_id = message.get("chat", {}).get("id")
        message_id = message.get("message_id")

        if user_id not in AUTHORIZED_CHAT_IDS:
            telegram_request(
                "answerCallbackQuery",
                {
                    "callback_query_id": callback_id,
                    "text": "❌ Acceso denegado: usuario no autorizado.",
                    "show_alert": True,
                },
            )
            return {"status": "unauthorized"}

        print(
            f"[TELEGRAM CALLBACK] user={user_id} data={action_data}"
        )

        # ----------------------------------------------------
        # NAVEGACIÓN: MENÚ DE USUARIOS
        # ----------------------------------------------------
        if action_data == "menu:usuarios":
            telegram_request(
                "answerCallbackQuery",
                {"callback_query_id": callback_id},
            )
            mostrar_menu_usuarios(chat_id, message_id)
            return {"status": "menu_usuarios"}

        # ----------------------------------------------------
        # NAVEGACIÓN: ARCHIVOS DE UN USUARIO
        # ----------------------------------------------------
        if action_data.startswith("usr:"):
            solicitante_id = action_data.split(":", 1)[1].strip()

            try:
                solicitante_id = str(UUID(solicitante_id))
            except (ValueError, TypeError, AttributeError):
                telegram_request(
                    "answerCallbackQuery",
                    {
                        "callback_query_id": callback_id,
                        "text": "❌ UID de usuario inválido.",
                        "show_alert": True,
                    },
                )
                return {"status": "callback_error"}

            telegram_request(
                "answerCallbackQuery",
                {"callback_query_id": callback_id},
            )
            mostrar_archivos_usuario(
                chat_id,
                message_id,
                solicitante_id,
            )
            return {"status": "menu_archivos"}

        # ----------------------------------------------------
        # NAVEGACIÓN: DETALLE DEL DOCUMENTO
        # ----------------------------------------------------
        if action_data.startswith("doc:"):
            auditoria_id_raw = action_data.split(":", 1)[1].strip()

            try:
                auditoria_id = str(UUID(auditoria_id_raw))
            except (ValueError, TypeError, AttributeError):
                telegram_request(
                    "answerCallbackQuery",
                    {
                        "callback_query_id": callback_id,
                        "text": "❌ ID de auditoría inválido.",
                        "show_alert": True,
                    },
                )
                return {"status": "callback_error"}

            telegram_request(
                "answerCallbackQuery",
                {"callback_query_id": callback_id},
            )
            mostrar_detalle_documento(
                chat_id,
                message_id,
                auditoria_id,
            )
            return {"status": "detalle_documento"}

        # ----------------------------------------------------
        # NAVEGACIÓN: DETALLE DE UNA CARPETA / LOTE
        # ----------------------------------------------------
        if action_data.startswith("lot:"):
            lote_id_raw = action_data.split(":", 1)[1].strip()

            try:
                lote_id = str(UUID(lote_id_raw))
            except (ValueError, TypeError, AttributeError):
                telegram_request(
                    "answerCallbackQuery",
                    {
                        "callback_query_id": callback_id,
                        "text": "❌ ID de lote inválido.",
                        "show_alert": True,
                    },
                )
                return {"status": "callback_error"}

            telegram_request(
                "answerCallbackQuery",
                {"callback_query_id": callback_id},
            )
            mostrar_detalle_lote(chat_id, message_id, lote_id)
            return {"status": "detalle_lote"}

        # ----------------------------------------------------
        # DECISIÓN: APROBAR / RECHAZAR CARPETA COMPLETA
        # ----------------------------------------------------
        if action_data.startswith("aplot:") or action_data.startswith("relot:"):
            accion_lote, lote_id_raw = action_data.split(":", 1)

            try:
                lote_id = str(UUID(lote_id_raw.strip()))
            except (ValueError, TypeError, AttributeError):
                telegram_request(
                    "answerCallbackQuery",
                    {
                        "callback_query_id": callback_id,
                        "text": "❌ ID de lote inválido.",
                        "show_alert": True,
                    },
                )
                return {"status": "callback_error"}

            aprobar_lote = accion_lote == "aplot"
            estado_lote = "APROBADO" if aprobar_lote else "RECHAZADO"
            drive_lote = None
            documentos_lote = []

            try:
                with DECISION_LOCK:
                    consulta_lote = (
                        supabase
                        .table("auditoria_custodia")
                        .select(
                            "id,nombre_archivo,hash_sha256,tamano_bytes,estado,"
                            "solicitante_id,solicitante_nombre,solicitante_correo,"
                            "lote_id,ruta_relativa"
                        )
                        .eq("lote_id", lote_id)
                        .eq("estado", "PENDIENTE")
                        .execute()
                    )

                    documentos_lote = consulta_lote.data or []

                    if not documentos_lote:
                        telegram_request(
                            "answerCallbackQuery",
                            {
                                "callback_query_id": callback_id,
                                "text": "⚠️ Esta carpeta ya fue procesada o no tiene pendientes.",
                                "show_alert": True,
                            },
                        )
                        return {"status": "already_processed"}

                    # Asegurarnos de que realmente es una carpeta seleccionada.
                    nombre_carpeta = obtener_carpeta_desde_ruta(
                        documentos_lote[0].get("ruta_relativa")
                    )
                    if not nombre_carpeta:
                        raise RuntimeError(
                            "El lote no corresponde a una carpeta completa."
                        )

                    if aprobar_lote:
                        # Verificar ANTES de subir que todos siguen disponibles en RAM.
                        faltantes_ram = [
                            str(doc.get("id"))
                            for doc in documentos_lote
                            if not ARCHIVOS_EN_RAM.get(str(doc.get("id")))
                        ]

                        if faltantes_ram:
                            raise RuntimeError(
                                f"{len(faltantes_ram)} archivo(s) ya no están disponibles en RAM. "
                                "La carpeta no fue transferida."
                            )

                        drive_lote = subir_lote_carpeta_a_drive(documentos_lote)

                        if not drive_lote:
                            telegram_request(
                                "answerCallbackQuery",
                                {
                                    "callback_query_id": callback_id,
                                    "text": (
                                        "⚠️ Google Drive no pudo completar toda la carpeta. "
                                        "Los documentos siguen PENDIENTES."
                                    ),
                                    "show_alert": True,
                                },
                            )
                            return {
                                "status": "drive_batch_error",
                                "estado_actual": "PENDIENTE",
                            }

                        resultado_lote = (
                            supabase
                            .table("auditoria_custodia")
                            .update({"estado": "APROBADO"})
                            .eq("lote_id", lote_id)
                            .eq("estado", "PENDIENTE")
                            .execute()
                        )

                        if not resultado_lote.data:
                            # Drive ya se creó, pero Supabase no confirmó. Intentamos rollback.
                            try:
                                service = obtener_servicio_google_drive()
                                (
                                    service
                                    .files()
                                    .delete(
                                        fileId=drive_lote["folder_id"],
                                        supportsAllDrives=True,
                                    )
                                    .execute()
                                )
                            except Exception as rollback_error:
                                print("[DRIVE/SUPABASE ROLLBACK ERROR]", rollback_error)

                            raise RuntimeError(
                                "La carpeta llegó a Drive, pero Supabase no pudo confirmar APROBADO."
                            )

                    else:
                        resultado_lote = (
                            supabase
                            .table("auditoria_custodia")
                            .update({"estado": "RECHAZADO"})
                            .eq("lote_id", lote_id)
                            .eq("estado", "PENDIENTE")
                            .execute()
                        )

                        if not resultado_lote.data:
                            raise RuntimeError(
                                "No se pudo cambiar la carpeta a RECHAZADO."
                            )

                    # Solo después de una decisión confirmada liberamos la RAM.
                    for doc in documentos_lote:
                        ARCHIVOS_EN_RAM.pop(str(doc.get("id")), None)

            except Exception as error:
                print("[CALLBACK LOTE ERROR]", error)
                telegram_request(
                    "answerCallbackQuery",
                    {
                        "callback_query_id": callback_id,
                        "text": f"❌ No se pudo procesar la carpeta: {error}"[:200],
                        "show_alert": True,
                    },
                )
                return {
                    "status": "callback_lote_error",
                    "error": str(error),
                }

            primer = documentos_lote[0]
            solicitante_id_lote = str(primer.get("solicitante_id") or "").strip()
            solicitante_nombre_lote = primer.get("solicitante_nombre") or "Usuario"
            nombre_carpeta = obtener_carpeta_desde_ruta(primer.get("ruta_relativa")) or f"LOTE_{lote_id[:8]}"

            telegram_request(
                "answerCallbackQuery",
                {
                    "callback_query_id": callback_id,
                    "text": f"Carpeta actualizada a: {estado_lote}",
                },
            )

            icono = "✅" if estado_lote == "APROBADO" else "❌"
            nuevo_texto = (
                "🛡️ DataVault DLP - GM Ingenieros\n\n"
                f"📁 Carpeta: {nombre_carpeta}\n"
                f"👤 Solicitante: {solicitante_nombre_lote}\n"
                f"📄 Archivos procesados: {len(documentos_lote)}\n\n"
                f"{icono} DECISIÓN: Carpeta {estado_lote}\n"
            )

            if drive_lote:
                nuevo_texto += (
                    f"☁️ Carpeta subida a Google Drive\n"
                    f"🆔 Drive folder ID: {drive_lote['folder_id']}\n"
                )

            nuevo_texto += f"👤 Procesado por Telegram ID: {user_id}"

            botones_finales_lote = []
            if solicitante_id_lote:
                botones_finales_lote.append([{
                    "text": "🔙 Pendientes del usuario",
                    "callback_data": f"usr:{solicitante_id_lote}",
                }])

            botones_finales_lote.append([{
                "text": "👥 Usuarios pendientes",
                "callback_data": "menu:usuarios",
            }])

            telegram_request(
                "editMessageText",
                {
                    "chat_id": chat_id,
                    "message_id": message_id,
                    "text": nuevo_texto,
                    "reply_markup": {"inline_keyboard": botones_finales_lote},
                },
            )

            return {
                "status": "ok",
                "estado_actualizado": estado_lote,
                "lote_id": lote_id,
                "drive_folder_id": drive_lote["folder_id"] if drive_lote else None,
            }

        # ----------------------------------------------------
        # DECISIÓN: APROBAR / RECHAZAR ARCHIVO SUELTO
        # ----------------------------------------------------
        if ":" not in action_data:
            telegram_request(
                "answerCallbackQuery",
                {
                    "callback_query_id": callback_id,
                    "text": "❌ Formato de decisión inválido.",
                    "show_alert": True,
                },
            )
            return {
                "status": "callback_error",
                "error": "Formato de callback inválido",
            }

        accion, auditoria_id_raw = action_data.split(":", 1)

        if accion not in ("aprobar", "rechazar"):
            telegram_request(
                "answerCallbackQuery",
                {
                    "callback_query_id": callback_id,
                    "text": "❌ Acción inválida.",
                    "show_alert": True,
                },
            )
            return {
                "status": "callback_error",
                "error": "Acción inválida",
            }

        try:
            auditoria_id = str(UUID(auditoria_id_raw.strip()))
        except (ValueError, AttributeError, TypeError):
            telegram_request(
                "answerCallbackQuery",
                {
                    "callback_query_id": callback_id,
                    "text": "❌ ID de auditoría inválido.",
                    "show_alert": True,
                },
            )
            return {
                "status": "callback_error",
                "error": "ID de auditoría inválido",
            }

        id_auditoria_str = auditoria_id
        nuevo_estado = "APROBADO" if accion == "aprobar" else "RECHAZADO"
        drive_id = None
        resultado_update = None
        registro_actual = None

        try:
            # Impide decisiones simultáneas dentro de esta instancia Railway.
            with DECISION_LOCK:
                consulta = (
                    supabase
                    .table("auditoria_custodia")
                    .select(
                        "id,estado,nombre_archivo,hash_sha256,"
                        "solicitante_id,solicitante_nombre,solicitante_correo"
                    )
                    .eq("id", auditoria_id)
                    .limit(1)
                    .execute()
                )

                if not consulta.data:
                    raise ValueError(
                        f"No existe la auditoría {auditoria_id}."
                    )

                registro_actual = consulta.data[0]
                estado_actual = registro_actual.get("estado")

                if estado_actual != "PENDIENTE":
                    telegram_request(
                        "answerCallbackQuery",
                        {
                            "callback_query_id": callback_id,
                            "text": (
                                "⚠️ Este documento ya fue procesado. "
                                f"Estado actual: {estado_actual}."
                            ),
                            "show_alert": True,
                        },
                    )
                    return {
                        "status": "already_processed",
                        "estado_actual": estado_actual,
                    }

                # APROBAR: Drive -> Supabase -> liberar RAM.
                if accion == "aprobar":
                    archivo_ram = ARCHIVOS_EN_RAM.get(id_auditoria_str)

                    if not archivo_ram:
                        raise RuntimeError(
                            "El archivo ya no está disponible en RAM. "
                            "No se modificó el estado en Supabase."
                        )

                    drive_id = subir_a_google_drive(
                        archivo_ram["nombre"],
                        archivo_ram["contenido"],
                    )

                    if not drive_id:
                        telegram_request(
                            "answerCallbackQuery",
                            {
                                "callback_query_id": callback_id,
                                "text": (
                                    "⚠️ Google Drive rechazó o no pudo "
                                    "completar la transferencia. "
                                    "El documento sigue PENDIENTE."
                                ),
                                "show_alert": True,
                            },
                        )
                        return {
                            "status": "drive_error",
                            "estado_actual": "PENDIENTE",
                        }

                    resultado_update = (
                        supabase
                        .table("auditoria_custodia")
                        .update({"estado": "APROBADO"})
                        .eq("id", auditoria_id)
                        .eq("estado", "PENDIENTE")
                        .execute()
                    )

                    if not resultado_update.data:
                        raise RuntimeError(
                            "El archivo llegó a Drive, pero Supabase no pudo "
                            "confirmar el estado APROBADO. "
                            f"Drive ID: {drive_id}"
                        )

                    ARCHIVOS_EN_RAM.pop(id_auditoria_str, None)

                # RECHAZAR: Supabase -> liberar RAM.
                else:
                    resultado_update = (
                        supabase
                        .table("auditoria_custodia")
                        .update({"estado": "RECHAZADO"})
                        .eq("id", auditoria_id)
                        .eq("estado", "PENDIENTE")
                        .execute()
                    )

                    if not resultado_update.data:
                        raise RuntimeError(
                            "No se pudo cambiar el documento a RECHAZADO."
                        )

                    ARCHIVOS_EN_RAM.pop(id_auditoria_str, None)

        except Exception as error:
            print("[CALLBACK ERROR]", error)
            telegram_request(
                "answerCallbackQuery",
                {
                    "callback_query_id": callback_id,
                    "text": (
                        "❌ No se pudo procesar: "
                        f"{error}"
                    )[:200],
                    "show_alert": True,
                },
            )
            return {
                "status": "callback_error",
                "error": str(error),
            }

        print(
            "[SUPABASE UPDATE]",
            getattr(resultado_update, "data", None),
        )

        telegram_request(
            "answerCallbackQuery",
            {
                "callback_query_id": callback_id,
                "text": f"Estado actualizado a: {nuevo_estado}",
            },
        )

        solicitante_id = str(
            (registro_actual or {}).get("solicitante_id") or ""
        ).strip()
        nombre_archivo = (
            (registro_actual or {}).get("nombre_archivo")
            or "Archivo"
        )
        solicitante_nombre = (
            (registro_actual or {}).get("solicitante_nombre")
            or "Usuario"
        )

        icono = "✅" if nuevo_estado == "APROBADO" else "❌"

        nuevo_texto = (
            "🛡️ DataVault DLP - GM Ingenieros\n\n"
            f"📁 Archivo: {nombre_archivo}\n"
            f"👤 Solicitante: {solicitante_nombre}\n\n"
            f"{icono} DECISIÓN: Documento {nuevo_estado}\n"
        )

        if drive_id:
            nuevo_texto += f"☁️ Subido a Google Drive (ID: {drive_id})\n"

        nuevo_texto += f"👤 Procesado por Telegram ID: {user_id}"

        botones_finales = []
        if solicitante_id:
            botones_finales.append([
                {
                    "text": "🔙 Archivos del usuario",
                    "callback_data": f"usr:{solicitante_id}",
                }
            ])

        botones_finales.append([
            {
                "text": "👥 Usuarios pendientes",
                "callback_data": "menu:usuarios",
            }
        ])

        if chat_id and message_id:
            telegram_request(
                "editMessageText",
                {
                    "chat_id": chat_id,
                    "message_id": message_id,
                    "text": nuevo_texto,
                    "reply_markup": {
                        "inline_keyboard": botones_finales
                    },
                },
            )

        return {
            "status": "ok",
            "estado_actualizado": nuevo_estado,
            "autorizado_por": user_id,
            "drive_id": drive_id,
        }

    return {"status": "ignored"}
