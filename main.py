import hashlib
import os
import requests
from fastapi import FastAPI, File, UploadFile, Request, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from supabase import create_client, Client

# 1. Inicialización de la App FastAPI
app = FastAPI(title="DataVault DLP API | GM Ingenieros y Consultores")

# Habilitar CORS para peticiones desde el Frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 2. Configuración de credenciales de Telegram y Supabase
TELEGRAM_TOKEN = "8934863246:AAEr2BW_fYNyEiri2pv0emcZUBm1qYcwGx8"

# Lista de IDs autorizados en Telegram para recibir y aprobar alertas
AUTHORIZED_CHAT_IDS = [
    8893414961,
    6718944855
]

SUPABASE_URL = "https://crujlbbhtkcithullgfs.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNydWpsYmJodGtjaXRodWxsZ2ZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkzOTQ0ODAsImV4cCI6MjEwNDk3MDQ4MH0.IJTGJ02ldBKp1_yLejsN4643PCj70sxNOKCE0e-YLGw"

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# 3. Endpoints de Interfaz Web y Health Check
@app.get("/", response_class=HTMLResponse)
async def read_index():
    if os.path.exists("index.html"):
        with open("index.html", "r", encoding="utf-8") as f:
            return f.read()
    return "<h1>DataVault DLP API Activa</h1>"

@app.get("/health")
def health_check():
    return {"status": "ok", "service": "DataVault DLP API | GM Ingenieros y Consultores"}

# 4. Endpoint para Cargar Archivo y Notificar (Zero-Disk DLP)
@app.post("/upload")
async def registrar_y_solicitar_custodia(
    file: UploadFile = File(...),
    usuario: str = Form("Alexsa"),
    carpeta: str = Form("PLANOS")
):
    # Leer los bytes en RAM y calcular el Hash SHA-256
    contenido = await file.read()
    hash_sha256 = hashlib.sha256(contenido).hexdigest()
    
    # Insertar registro en Supabase
    registro = {
        "nombre_archivo": file.filename,
        "hash_sha256": hash_sha256,
        "tamano_bytes": len(contenido),
        "estado": "PENDIENTE",
        "usuario_solicitante": usuario
    }
    
    respuesta_db = supabase.table("auditoria_custodia").insert(registro).execute()
    
    # Enviar notificación con botones a los custodios autorizados en Telegram
    mensaje = (
        "🛡️ *[DataVault DLP - GM Ingenieros]*\n\n"
        f"📁 *Archivo:* `{file.filename}`\n"
        f"👤 *Solicitante:* `{usuario}`\n"
        f"📂 *Carpeta Destino:* `{carpeta}`\n"
        f"🔑 *Hash SHA-256:* `{hash_sha256}`\n\n"
        "¿Autoriza su transferencia a la custodia corporativa?"
    )
    
    payload_base = {
        "text": mensaje,
        "parse_mode": "Markdown",
        "reply_markup": {
            "inline_keyboard": [
                [
                    {"text": "✅ Aprobar", "callback_data": f"aprobar_{hash_sha256[:10]}"},
                    {"text": "❌ Rechazar", "callback_data": f"rechazar_{hash_sha256[:10]}"}
                ]
            ]
        }
    }
    
    for chat_id in AUTHORIZED_CHAT_IDS:
        payload = payload_base.copy()
        payload["chat_id"] = chat_id
        requests.post(f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage", json=payload)
    
    return {
        "status": "ok",
        "mensaje": "Documento procesado en RAM, registrado en Supabase y notificado a Telegram.",
        "id_auditoria": respuesta_db.data[0]['id'],
        "sha256": hash_sha256
    }

# 5. Endpoint Webhook de Telegram para Respuesta de Botones
@app.post("/telegram-webhook")
async def recibir_respuesta_telegram(request: Request):
    data = await request.json()
    
    # Verificar si es una respuesta de botón interactivo (callback_query)
    if "callback_query" in data:
        callback = data["callback_query"]
        user_id = callback["from"]["id"]
        
        # Validar si el usuario que presiona el botón está en la lista blanca
        if user_id not in AUTHORIZED_CHAT_IDS:
            requests.post(
                f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/answerCallbackQuery",
                json={"callback_query_id": callback["id"], "text": "❌ Acceso Denegado: Usuario no autorizado."}
            )
            return {"status": "unauthorized"}

        action_data = callback["data"]  # Ej: "aprobar_a1b2c3d4e5"
        callback_id = callback["id"]
        
        accion, hash_prefix = action_data.split("_")
        nuevo_estado = "APROBADO" if accion == "aprobar" else "RECHAZADO"
        
        # 1. Actualizar el estado en Supabase
        supabase.table("auditoria_custodia")\
            .update({"estado": nuevo_estado})\
            .like("hash_sha256", f"{hash_prefix}%")\
            .execute()
        
        # 2. Notificar a Telegram que la acción fue procesada (quita el spinner)
        requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/answerCallbackQuery",
            json={"callback_query_id": callback_id, "text": f"Estado actualizado a: {nuevo_estado}"}
        )
        
        # 3. Editar el mensaje original reflejando la decisión
        chat_id = callback["message"]["chat"]["id"]
        message_id = callback["message"]["message_id"]
        texto_original = callback["message"]["text"]
        
        icono = "✅" if nuevo_estado == "APROBADO" else "❌"
        nuevo_texto = f"{texto_original}\n\n{icono} *DECISIÓN:* Documento {nuevo_estado}"
        
        requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/editMessageText",
            json={
                "chat_id": chat_id,
                "message_id": message_id,
                "text": nuevo_texto,
                "parse_mode": "Markdown"
            }
        )
        
        return {"status": "ok", "estado_actualizado": nuevo_estado}
        
    return {"status": "no_callback"}
