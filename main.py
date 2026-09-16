import hashlib
import os
import requests

from fastapi import (
    FastAPI,
    File,
    UploadFile,
    Request,
    Form,
    HTTPException
)

from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from supabase import create_client, Client


# ============================================================
# DATAVAULT DLP
# GM INGENIEROS Y CONSULTORES
# ============================================================

app = FastAPI(
    title="DataVault DLP API | GM Ingenieros y Consultores"
)


# ============================================================
# CORS
# ============================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# VARIABLES DE ENTORNO
# ============================================================

TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN", "").strip()

SUPABASE_URL = os.getenv(
    "SUPABASE_URL",
    "https://crujlbbhtkcithullgfs.supabase.co"
).strip()

SUPABASE_KEY = os.getenv(
    "SUPABASE_KEY",
    ""
).strip()


# Railway crea esta variable automáticamente normalmente.
RAILWAY_PUBLIC_DOMAIN = os.getenv(
    "RAILWAY_PUBLIC_DOMAIN",
    ""
).strip()

PUBLIC_BASE_URL = os.getenv(
    "PUBLIC_BASE_URL",
    ""
).strip()


if not PUBLIC_BASE_URL and RAILWAY_PUBLIC_DOMAIN:
    PUBLIC_BASE_URL = f"https://{RAILWAY_PUBLIC_DOMAIN}"

PUBLIC_BASE_URL = PUBLIC_BASE_URL.rstrip("/")


# ============================================================
# USUARIOS AUTORIZADOS DE TELEGRAM
#
# En Railway:
#
# AUTHORIZED_CHAT_IDS=8893414961,6718944855
#
# Para agregar otro:
#
# AUTHORIZED_CHAT_IDS=8893414961,6718944855,123456789
#
# ============================================================

AUTHORIZED_CHAT_IDS_RAW = os.getenv(
    "AUTHORIZED_CHAT_IDS",
    ""
)


def cargar_ids_autorizados():
    ids = []

    for item in AUTHORIZED_CHAT_IDS_RAW.split(","):

        item = item.strip()

        if not item:
            continue

        try:
            ids.append(int(item))
        except ValueError:
            print(
                f"[CONFIG] ID Telegram inválido ignorado: {item}"
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
        "SUPABASE_KEY no está configurado."
    )


supabase: Client = create_client(
    SUPABASE_URL,
    SUPABASE_KEY
)


# ============================================================
# FUNCIÓN AUXILIAR TELEGRAM
# ============================================================

def telegram_request(
    metodo: str,
    payload: dict
):
    """
    Ejecuta una petición contra Telegram y devuelve
    la respuesta real para poder detectar errores.
    """

    if not TELEGRAM_TOKEN:
        return {
            "ok": False,
            "description": "TELEGRAM_TOKEN no configurado"
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
            f"[TELEGRAM ERROR] {metodo}: {error}"
        )

        return {
            "ok": False,
            "description": str(error)
        }


# ============================================================
# CONFIGURAR WEBHOOK AUTOMÁTICAMENTE
# ============================================================

def configurar_webhook():

    if not TELEGRAM_TOKEN:

        print(
            "[TELEGRAM] TELEGRAM_TOKEN no configurado."
        )

        return


    if not PUBLIC_BASE_URL:

        print(
            "[TELEGRAM] No se pudo determinar "
            "PUBLIC_BASE_URL."
        )

        return


    webhook_url = (
        f"{PUBLIC_BASE_URL}/telegram-webhook"
    )


    print(
        "[TELEGRAM] Configurando webhook:",
        webhook_url
    )


    resultado = telegram_request(
        "setWebhook",
        {
            "url": webhook_url,
            "allowed_updates": [
                "message",
                "callback_query"
            ]
        }
    )


    print(
        "[TELEGRAM] Resultado webhook:",
        resultado
    )


@app.on_event("startup")
def startup_event():

    print("=" * 60)
    print("DATAVAULT DLP INICIADO")
    print("=" * 60)

    print(
        "PUBLIC_BASE_URL:",
        PUBLIC_BASE_URL
    )

    print(
        "Telegram autorizados:",
        AUTHORIZED_CHAT_IDS
    )

    configurar_webhook()


# ============================================================
# WEB
# ============================================================

@app.get(
    "/",
    response_class=HTMLResponse
)
async def read_index():

    if os.path.exists("index.html"):

        with open(
            "index.html",
            "r",
            encoding="utf-8"
        ) as file:

            return file.read()

    return """
    <h1>DataVault DLP API activa</h1>
    """


# ============================================================
# HEALTH
# ============================================================

@app.get("/health")
def health_check():

    return {
        "status": "ok",
        "service": (
            "DataVault DLP API | "
            "GM Ingenieros y Consultores"
        ),
        "telegram_configurado": bool(
            TELEGRAM_TOKEN
        ),
        "usuarios_telegram": len(
            AUTHORIZED_CHAT_IDS
        ),
        "public_url": PUBLIC_BASE_URL
    }


# ============================================================
# VER WEBHOOK ACTUAL
# ============================================================

@app.get("/telegram-info")
def telegram_info():

    if not TELEGRAM_TOKEN:

        return {
            "ok": False,
            "error": (
                "TELEGRAM_TOKEN no configurado"
            )
        }


    resultado = telegram_request(
        "getWebhookInfo",
        {}
    )

    return resultado


# ============================================================
# SUBIR ARCHIVO
# ============================================================

@app.post("/upload")
async def registrar_y_solicitar_custodia(

    file: UploadFile = File(...),

    usuario: str = Form(
        "Usuario desconocido"
    ),

    carpeta: str = Form(
        "PLANOS"
    )

):

    # --------------------------------------------------------
    # VALIDACIONES DE TELEGRAM
    # --------------------------------------------------------

    if not TELEGRAM_TOKEN:

        raise HTTPException(
            status_code=500,
            detail=(
                "Telegram no está configurado."
            )
        )


    if not AUTHORIZED_CHAT_IDS:

        raise HTTPException(
            status_code=500,
            detail=(
                "No existen usuarios "
                "Telegram autorizados."
            )
        )


    # --------------------------------------------------------
    # LEER ARCHIVO EN RAM
    # --------------------------------------------------------

    contenido = await file.read()


    if not contenido:

        raise HTTPException(
            status_code=400,
            detail="El archivo está vacío."
        )


    # --------------------------------------------------------
    # HASH SHA-256
    # --------------------------------------------------------

    hash_sha256 = hashlib.sha256(
        contenido
    ).hexdigest()


    # --------------------------------------------------------
    # SUPABASE
    # --------------------------------------------------------

    registro = {

        "nombre_archivo":
            file.filename,

        "hash_sha256":
            hash_sha256,

        "tamano_bytes":
            len(contenido),

        "estado":
            "PENDIENTE",

        "usuario_solicitante":
            usuario
    }


    try:

        respuesta_db = (
            supabase
            .table("auditoria_custodia")
            .insert(registro)
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
                "el documento en Supabase."
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
        respuesta_db.data[0]["id"]
    )


    # --------------------------------------------------------
    # MENSAJE TELEGRAM
    #
    # Sin Markdown para evitar errores con nombres como:
    #
    # INFORME_FINAL_[01].pdf
    # --------------------------------------------------------

    mensaje = (
        "🛡️ DATAVAULT DLP - GM INGENIEROS\n\n"
        f"📁 Archivo: {file.filename}\n"
        f"👤 Solicitante: {usuario}\n"
        f"📂 Carpeta Destino: {carpeta}\n\n"
        f"🔑 SHA-256:\n{hash_sha256}\n\n"
        f"🆔 Auditoría: {id_auditoria}\n\n"
        "¿Autoriza la transferencia "
        "a la custodia corporativa?"
    )


    # --------------------------------------------------------
    # BOTONES
    #
    # Ahora usamos el ID exacto de Supabase.
    # Ya no usamos solo 10 caracteres del hash.
    # --------------------------------------------------------

    keyboard = {

        "inline_keyboard": [

            [

                {
                    "text":
                        "✅ Aprobar",

                    "callback_data":
                        f"aprobar:{id_auditoria}"
                },

                {
                    "text":
                        "❌ Rechazar",

                    "callback_data":
                        f"rechazar:{id_auditoria}"
                }

            ]

        ]

    }


    resultados_telegram = []

    enviados_correctamente = 0


    # --------------------------------------------------------
    # ENVIAR A CADA CUSTODIO
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
                    keyboard
            }

        )


        if resultado.get("ok"):

            enviados_correctamente += 1


        resultados_telegram.append({

            "chat_id":
                chat_id,

            "ok":
                resultado.get(
                    "ok",
                    False
                ),

            "description":
                resultado.get(
                    "description",
                    "OK"
                )

        })


    # --------------------------------------------------------
    # SI NADIE RECIBIÓ TELEGRAM
    # --------------------------------------------------------

    if enviados_correctamente == 0:

        print(
            "[TELEGRAM] Ninguna alerta "
            "pudo ser entregada."
        )

        raise HTTPException(

            status_code=502,

            detail={
                "mensaje":
                    (
                        "El documento se registró "
                        "en Supabase, pero Telegram "
                        "no pudo notificar a ningún "
                        "custodio."
                    ),

                "telegram":
                    resultados_telegram
            }

        )


    # --------------------------------------------------------
    # RESPUESTA WEB
    # --------------------------------------------------------

    return {

        "status":
            "ok",

        "mensaje":
            (
                "Documento registrado "
                "y alerta enviada."
            ),

        "id_auditoria":
            id_auditoria,

        "sha256":
            hash_sha256,

        "telegram_enviados":
            enviados_correctamente,

        "telegram":
            resultados_telegram
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
        "\n[TELEGRAM UPDATE]",
        data
    )


    # ========================================================
    # MENSAJES NORMALES
    # ========================================================

    if "message" in data:

        message = data["message"]

        chat_id = (
            message["chat"]["id"]
        )

        user_id = (
            message["from"]["id"]
        )

        texto = (
            message
            .get("text", "")
            .strip()
        )


        print(
            "[TELEGRAM MESSAGE]",
            "user_id=",
            user_id,
            "chat_id=",
            chat_id,
            "texto=",
            texto
        )


        # ----------------------------------------------------
        # NO AUTORIZADO
        # ----------------------------------------------------

        if user_id not in AUTHORIZED_CHAT_IDS:

            telegram_request(

                "sendMessage",

                {
                    "chat_id":
                        chat_id,

                    "text":
                        (
                            "⛔ ACCESO NO AUTORIZADO\n\n"
                            "Tu Telegram ID es:\n\n"
                            f"{user_id}\n\n"
                            "Envía este ID al administrador "
                            "de DataVault para que pueda "
                            "autorizar tu cuenta."
                        )
                }

            )


            return {

                "status":
                    "unauthorized",

                "user_id":
                    user_id
            }


        # ----------------------------------------------------
        # /START
        # ----------------------------------------------------

        if texto.lower().startswith(
            "/start"
        ):

            respuesta = (
                "🛡️ DATAVAULT DLP\n"
                "GM Ingenieros y Consultores\n\n"
                "✅ Usuario autorizado.\n\n"
                f"🆔 Telegram ID: {user_id}\n\n"
                "Recibirás aquí las solicitudes "
                "de custodia de documentos.\n\n"
                "Cuando llegue una solicitud podrás:\n\n"
                "✅ Aprobar\n"
                "❌ Rechazar"
            )


        # ----------------------------------------------------
        # /ID
        # ----------------------------------------------------

        elif texto.lower().startswith(
            "/id"
        ):

            respuesta = (
                "🆔 TU TELEGRAM ID\n\n"
                f"{user_id}"
            )


        # ----------------------------------------------------
        # /ESTADO
        # ----------------------------------------------------

        elif texto.lower().startswith(
            "/estado"
        ):

            respuesta = (
                "🟢 DATAVAULT DLP ACTIVO\n\n"
                "Tu cuenta está autorizada "
                "para recibir solicitudes "
                "de custodia."
            )


        # ----------------------------------------------------
        # MENSAJE CUALQUIERA
        # ----------------------------------------------------

        else:

            respuesta = (
                "🛡️ DATAVAULT DLP\n\n"
                "Bot de autorización activo.\n\n"
                "Comandos disponibles:\n\n"
                "/start - Iniciar el bot\n"
                "/id - Consultar tu Telegram ID\n"
                "/estado - Verificar conexión"
            )


        resultado = telegram_request(

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
                "message_processed",

            "telegram":
                resultado.get(
                    "ok",
                    False
                )
        }


    # ========================================================
    # BOTONES APROBAR / RECHAZAR
    # ========================================================

    if "callback_query" in data:

        callback = (
            data["callback_query"]
        )

        callback_id = (
            callback["id"]
        )

        user_id = (
            callback["from"]["id"]
        )


        # ----------------------------------------------------
        # VALIDAR USUARIO
        # ----------------------------------------------------

        if user_id not in AUTHORIZED_CHAT_IDS:

            telegram_request(

                "answerCallbackQuery",

                {
                    "callback_query_id":
                        callback_id,

                    "text":
                        (
                            "❌ Usuario "
                            "no autorizado."
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
            "[TELEGRAM CALLBACK]",
            action_data
        )


        # ----------------------------------------------------
        # FORMATO:
        #
        # aprobar:123
        # rechazar:123
        # ----------------------------------------------------

        try:

            accion, auditoria_id = (
                action_data.split(
                    ":",
                    1
                )
            )

            auditoria_id = int(
                auditoria_id
            )

        except Exception:

            telegram_request(

                "answerCallbackQuery",

                {
                    "callback_query_id":
                        callback_id,

                    "text":
                        "❌ Acción inválida."
                }

            )


            return {
                "status":
                    "invalid_callback"
            }


        if accion == "aprobar":

            nuevo_estado = (
                "APROBADO"
            )

            icono = "✅"

        elif accion == "rechazar":

            nuevo_estado = (
                "RECHAZADO"
            )

            icono = "❌"

        else:

            telegram_request(

                "answerCallbackQuery",

                {
                    "callback_query_id":
                        callback_id,

                    "text":
                        "❌ Acción desconocida."
                }

            )

            return {
                "status":
                    "invalid_action"
            }


        # ----------------------------------------------------
        # SOLO PERMITIR DECIDIR SI ESTÁ PENDIENTE
        # ----------------------------------------------------

        try:

            resultado_update = (

                supabase
                .table(
                    "auditoria_custodia"
                )
                .update(
                    {
                        "estado":
                            nuevo_estado
                    }
                )
                .eq(
                    "id",
                    auditoria_id
                )
                .eq(
                    "estado",
                    "PENDIENTE"
                )
                .execute()

            )

        except Exception as error:

            print(
                "[SUPABASE UPDATE ERROR]",
                error
            )

            telegram_request(

                "answerCallbackQuery",

                {
                    "callback_query_id":
                        callback_id,

                    "text":
                        (
                            "❌ Error actualizando "
                            "Supabase."
                        ),

                    "show_alert":
                        True
                }

            )

            return {
                "status":
                    "database_error"
            }


        # ----------------------------------------------------
        # YA HABÍA SIDO DECIDIDO
        # ----------------------------------------------------

        if not resultado_update.data:

            telegram_request(

                "answerCallbackQuery",

                {
                    "callback_query_id":
                        callback_id,

                    "text":
                        (
                            "⚠️ Este documento "
                            "ya fue procesado."
                        ),

                    "show_alert":
                        True
                }

            )

            return {
                "status":
                    "already_processed"
            }


        # ----------------------------------------------------
        # CONFIRMAR CALLBACK
        # ----------------------------------------------------

        telegram_request(

            "answerCallbackQuery",

            {
                "callback_query_id":
                    callback_id,

                "text":
                    (
                        f"Documento "
                        f"{nuevo_estado}"
                    )
            }

        )


        # ----------------------------------------------------
        # EDITAR MENSAJE ORIGINAL
        # ----------------------------------------------------

        message = callback.get(
            "message",
            {}
        )


        chat_id = (
            message
            .get("chat", {})
            .get("id")
        )


        message_id = message.get(
            "message_id"
        )


        texto_original = message.get(
            "text",
            ""
        )


        nuevo_texto = (
            f"{texto_original}\n\n"
            "────────────────────────\n"
            f"{icono} DECISIÓN: {nuevo_estado}\n"
            f"👤 Telegram ID: {user_id}"
        )


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

                    # Al editar sin reply_markup
                    # desaparecen los botones.
                    "reply_markup":
                        {
                            "inline_keyboard":
                                []
                        }
                }

            )


        print(
            "[SUPABASE]",
            f"Auditoría {auditoria_id}",
            nuevo_estado,
            "por",
            user_id
        )


        return {

            "status":
                "ok",

            "auditoria_id":
                auditoria_id,

            "estado_actualizado":
                nuevo_estado,

            "autorizado_por":
                user_id
        }


    # ========================================================
    # OTRO TIPO DE UPDATE
    # ========================================================

    return {
        "status":
            "ignored"
    }
