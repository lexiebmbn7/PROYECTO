import hashlib
import os
import requests

from fastapi import FastAPI, File, UploadFile, Request, Form, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from supabase import create_client, Client


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
# CONFIGURACIÓN DESDE RAILWAY
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


if not PUBLIC_BASE_URL and RAILWAY_PUBLIC_DOMAIN:

    PUBLIC_BASE_URL = (
        f"https://{RAILWAY_PUBLIC_DOMAIN}"
    ).rstrip("/")


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

    usuario: str = Form(
        "Usuario desconocido"
    ),

    carpeta: str = Form(
        "PLANOS"
    )

):

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

        print("[CORRELATIVO ERROR]", e_nombre)
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
            usuario

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


    # ========================================================
    # IMPORTANTE:
    # Conservamos el mismo callback_data del código
    # anterior que sí funcionaba.
    # ========================================================

    hash_prefix = (
        hash_sha256[:10]
    )


    # --------------------------------------------------------
    # MENSAJE
    # --------------------------------------------------------

    mensaje = (

        "🛡️ [DataVault DLP - GM Ingenieros]\n\n"

        f"📁 Archivo: {nombre_final}\n"

        f"👤 Solicitante: {usuario}\n"

        f"📂 Carpeta Destino: {carpeta}\n"

        f"🔑 Hash SHA-256: {hash_sha256}\n"

        f"🆔 Auditoría: {id_auditoria}\n\n"

        "¿Autoriza su transferencia "
        "a la custodia corporativa?"

    )


    # --------------------------------------------------------
    # BOTONES
    # --------------------------------------------------------

    reply_markup = {

        "inline_keyboard": [

            [

                {
                    "text":
                        "✅ Aprobar",

                    "callback_data":
                        f"aprobar_{hash_prefix}"
                },

                {
                    "text":
                        "❌ Rechazar",

                    "callback_data":
                        f"rechazar_{hash_prefix}"
                }

            ]

        ]

    }


    resultados_telegram = []

    enviados_correctamente = 0


    # --------------------------------------------------------
    # ENVIAR A TODOS LOS AUTORIZADOS
    # --------------------------------------------------------

    for chat_id in AUTHORIZED_CHAT_IDS:

        resultado = telegram_request(

            "sendMessage",

            {
                "chat_id":
                    chat_id,

                "text":
                    mensaje,

                "reply_markup":
                    reply_markup
            }

        )


        ok = bool(
            resultado.get(
                "ok"
            )
        )


        if ok:

            enviados_correctamente += 1


        resultados_telegram.append({

            "chat_id":
                chat_id,

            "ok":
                ok,

            "description":
                resultado.get(
                    "description",
                    "OK"
                )

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
                "y notificado a Telegram."
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
# WEBHOOK TELEGRAM
# ============================================================

@app.post("/telegram-webhook")
async def recibir_respuesta_telegram(
    request: Request
):

    data = await request.json()


    print(
        "[TELEGRAM UPDATE]",
        data
    )


    # ========================================================
    # MENSAJES NORMALES
    # ========================================================

    if "message" in data:

        message = data[
            "message"
        ]


        chat_id = (
            message[
                "chat"
            ][
                "id"
            ]
        )


        user_id = (
            message[
                "from"
            ][
                "id"
            ]
        )


        texto = (

            message

            .get(
                "text",
                ""
            )

            .strip()

        )


        # ----------------------------------------------------
        # USUARIO NO AUTORIZADO
        # ----------------------------------------------------

        if user_id not in AUTHORIZED_CHAT_IDS:

            telegram_request(

                "sendMessage",

                {
                    "chat_id":
                        chat_id,

                    "text":
                        (
                            "⛔ Acceso no autorizado.\n\n"
                            f"Tu Telegram ID es: "
                            f"{user_id}\n\n"
                            "Agrega este ID en Railway "
                            "en la variable "
                            "AUTHORIZED_CHAT_IDS."
                        )
                }

            )


            return {

                "status":
                    "unauthorized",

                "user_id":
                    user_id

            }


        texto_lower = texto.lower()


        # ----------------------------------------------------
        # /START
        # ----------------------------------------------------

        if texto_lower.startswith(
            "/start"
        ):

            respuesta = (

                "🛡️ DataVault DLP | GM Ingenieros\n\n"

                "✅ Usuario autorizado.\n\n"

                f"Tu Telegram ID es: {user_id}\n\n"

                "Recibirás aquí las solicitudes "
                "de custodia."

            )


        # ----------------------------------------------------
        # /ID
        # ----------------------------------------------------

        elif texto_lower.startswith(
            "/id"
        ):

            respuesta = (

                "🆔 Tu Telegram ID:\n\n"

                f"{user_id}"

            )


        # ----------------------------------------------------
        # /ESTADO
        # ----------------------------------------------------

        elif texto_lower.startswith(
            "/estado"
        ):

            respuesta = (

                "🟢 DataVault DLP activo.\n\n"

                "Tu cuenta está autorizada."

            )


        # ----------------------------------------------------
        # OTROS MENSAJES
        # ----------------------------------------------------

        else:

            respuesta = (

                "🛡️ DataVault DLP activo.\n\n"

                "Comandos:\n"

                "/start - Iniciar\n"

                "/id - Ver tu Telegram ID\n"

                "/estado - Verificar conexión"

            )


        telegram_request(

            "sendMessage",

            {
                "chat_id":
                    chat_id,

                "text":
                    respuesta
            }

        )


        return {
            "status":
                "message_processed"
        }


    # ========================================================
    # BOTONES APROBAR / RECHAZAR
    # ========================================================

    if "callback_query" in data:

        callback = data[
            "callback_query"
        ]


        callback_id = callback[
            "id"
        ]


        user_id = callback[
            "from"
        ][
            "id"
        ]


        # ----------------------------------------------------
        # VALIDAR AUTORIZACIÓN
        # ----------------------------------------------------

        if user_id not in AUTHORIZED_CHAT_IDS:

            telegram_request(

                "answerCallbackQuery",

                {
                    "callback_query_id":
                        callback_id,

                    "text":
                        (
                            "❌ Acceso denegado: "
                            "usuario no autorizado."
                        ),

                    "show_alert":
                        True
                }

            )


            return {
                "status":
                    "unauthorized"
            }


        action_data = callback.get(
            "data",
            ""
        )


        print(

            f"[TELEGRAM CALLBACK] "
            f"user={user_id} "
            f"data={action_data}"

        )


        # ----------------------------------------------------
        # SOPORTAR LOS DOS FORMATOS
        # ----------------------------------------------------

        try:

            if ":" in action_data:

                accion, auditoria_id_raw = (
                    action_data.split(
                        ":",
                        1
                    )
                )


                if accion not in (
                    "aprobar",
                    "rechazar"
                ):

                    raise ValueError(
                        "Acción inválida"
                    )


                auditoria_id = int(
                    auditoria_id_raw
                )


                nuevo_estado = (

                    "APROBADO"

                    if accion == "aprobar"

                    else "RECHAZADO"

                )


                resultado_update = (

                    supabase

                    .table(
                        "auditoria_custodia"
                    )

                    .update({
                        "estado":
                            nuevo_estado
                    })

                    .eq(
                        "id",
                        auditoria_id
                    )

                    .execute()

                )


            elif "_" in action_data:

                accion, hash_prefix = (
                    action_data.split(
                        "_",
                        1
                    )
                )


                if accion not in (
                    "aprobar",
                    "rechazar"
                ):

                    raise ValueError(
                        "Acción inválida"
                    )


                nuevo_estado = (

                    "APROBADO"

                    if accion == "aprobar"

                    else "RECHAZADO"

                )


                resultado_update = (

                    supabase

                    .table(
                        "auditoria_custodia"
                    )

                    .update({
                        "estado":
                            nuevo_estado
                    })

                    .like(
                        "hash_sha256",
                        f"{hash_prefix}%"
                    )

                    .execute()

                )


            else:

                raise ValueError(
                    "Formato de callback inválido"
                )


        except Exception as error:

            print(
                "[CALLBACK ERROR]",
                error
            )


            telegram_request(

                "answerCallbackQuery",

                {
                    "callback_query_id":
                        callback_id,

                    "text":
                        (
                            "❌ No se pudo procesar: "
                            f"{error}"
                        ),

                    "show_alert":
                        True
                }

            )


            return {

                "status":
                    "callback_error",

                "error":
                    str(
                        error
                    )

            }


        print(

            "[SUPABASE UPDATE]",

            getattr(
                resultado_update,
                "data",
                None
            )

        )


        # ----------------------------------------------------
        # CONFIRMAR A TELEGRAM
        # ----------------------------------------------------

        telegram_request(

            "answerCallbackQuery",

            {
                "callback_query_id":
                    callback_id,

                "text":
                    (
                        "Estado actualizado a: "
                        f"{nuevo_estado}"
                    )
            }

        )


        # ----------------------------------------------------
        # EDITAR MENSAJE
        # ----------------------------------------------------

        message = callback.get(
            "message",
            {}
        )


        chat_id = (

            message

            .get(
                "chat",
                {}
            )

            .get(
                "id"
            )

        )


        message_id = message.get(
            "message_id"
        )


        texto_original = message.get(
            "text",
            ""
        )


        icono = (

            "✅"

            if nuevo_estado == "APROBADO"

            else "❌"

        )


        nuevo_texto = (

            f"{texto_original}\n\n"

            f"{icono} DECISIÓN: "
            f"Documento {nuevo_estado}\n"

            f"👤 Procesado por Telegram ID: "
            f"{user_id}"

        )


        # ----------------------------------------------------
        # QUITAR BOTONES DESPUÉS DE DECIDIR
        # ----------------------------------------------------

        if chat_id and message_id:

            telegram_request(

                "editMessageText",

                {
                    "chat_id":
                        chat_id,

                    "message_id":
                        message_id,

                    "text":
                        nuevo_texto,

                    "reply_markup":
                        {
                            "inline_keyboard":
                                []
                        }
                }

            )


        return {

            "status":
                "ok",

            "estado_actualizado":
                nuevo_estado,

            "autorizado_por":
                user_id

        }


    return {
        "status":
            "ignored"
    }
