import hashlib
from fastapi import FastAPI, File, UploadFile
import requests
from supabase import create_client, Client

app = FastAPI(title="DataVault DLP API")

# Configuración de Telegram
TELEGRAM_TOKEN = "8934863246:AAEr2BW_fYNyEiri2pv0emcZUBm1qYcwGx8"
TELEGRAM_CHAT_ID = "8893414961"

# Configuración de Supabase (Reemplaza con tus claves reales)
SUPABASE_URL = "https://crujlbbhtkcithullgfs.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNydWpsYmJodGtjaXRodWxsZ2ZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkzOTQ0ODAsImV4cCI6MjEwNDk3MDQ4MH0.IJTGJ02ldBKp1_yLejsN4643PCj70sxNOKCE0e-YLGw"

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

@app.post("/upload")
async def registrar_y_solicitar_custodia(file: UploadFile = File(...)):
    # 1. Leer los bytes en la memoria RAM y calcular el Hash SHA-256
    contenido = await file.read()
    hash_sha256 = hashlib.sha256(contenido).hexdigest()
    
    # 2. Insertar el registro en la base de datos de Supabase (PostgreSQL)
    registro = {
        "nombre_archivo": file.filename,
        "hash_sha256": hash_sha256,
        "tamano_bytes": len(contenido),
        "estado": "PENDIENTE",
        "usuario_solicitante": "Alexsa"
    }
    
    respuesta_db = supabase.table("auditoria_custodia").insert(registro).execute()
    
    # 3. Enviar notificación con botones a Telegram
    mensaje = (
        "🔒 *[DataVault DLP - Alerta de Custodia]*\n\n"
        f"📁 *Archivo:* `{file.filename}`\n"
        f"🔑 *Hash SHA-256:* `{hash_sha256}`\n\n"
        "¿Autoriza su transferencia a la custodia corporativa?"
    )
    
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
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
    
    requests.post(f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage", json=payload)
    
    return {
        "mensaje": "Documento procesado en RAM, registrado en Supabase y notificado a Telegram.",
        "id_auditoria": respuesta_db.data[0]['id'],
        "sha256": hash_sha256
    }
from fastapi import Request

@app.post("/telegram-webhook")
async def recibir_respuesta_telegram(request: Request):
    data = await request.json()
    
    # Verificar si es una respuesta de un botón interactivo (callback_query)
    if "callback_query" in data:
        callback = data["callback_query"]
        action_data = callback["data"]  # Ej: "aprobar_a1b2c3d4e5"
        callback_id = callback["id"]
        
        accion, hash_prefix = action_data.split("_")
        nuevo_estado = "APROBADO" if accion == "aprobar" else "RECHAZADO"
        
        # 1. Actualizar el estado en la base de datos de Supabase
        # Buscar el registro que coincide con los primeros caracteres del Hash
        supabase.table("auditoria_custodia")\
            .update({"estado": nuevo_estado})\
            .like("hash_sha256", f"{hash_prefix}%")\
            .execute()
        
        # 2. Notificar a Telegram que la acción fue procesada (quita el reloj del botón)
        requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/answerCallbackQuery",
            json={"callback_query_id": callback_id, "text": f"Estado actualizado a: {nuevo_estado}"}
        )
        
        # 3. Editar el mensaje original para reflejar la decisión tomada
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
        
    return {"status": "ok"}

from fastapi import Request

@app.post("/telegram-webhook")
async def recibir_respuesta_telegram(request: Request):
    data = await request.json()
    
    if "callback_query" in data:
        callback = data["callback_query"]
        action_data = callback["data"]  # Ej: "aprobar_a1b2c3d4"
        
        accion, hash_prefix = action_data.split("_")
        nuevo_estado = "APROBADO" if accion == "aprobar" else "RECHAZADO"
        
        # Actualizar estado en Supabase
        supabase.table("auditoria_custodia")\
            .update({"estado": nuevo_estado})\
            .like("hash_sha256", f"{hash_prefix}%")\
            .execute()
            
        return {"status": "ok", "estado_actualizado": nuevo_estado}
        
    return {"status": "no_callback"}