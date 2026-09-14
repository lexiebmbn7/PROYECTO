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