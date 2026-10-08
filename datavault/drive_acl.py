"""Validación pura de los enlaces a carpetas autorizadas por usuario.

La autorización real la ejecuta el servidor usando Supabase y la API de Drive.
Nunca confiar en IDs suministrados por el navegador como permisos.
"""
import re
from urllib.parse import parse_qs, urlparse

_DRIVE_ID = re.compile(r"^[A-Za-z0-9_-]{10,128}$")
_DRIVE_PATH = re.compile(r"^/(?:drive/(?:u/\d+/)?folders/|folders/)([A-Za-z0-9_-]+)(?:/)?$")


def parse_drive_folder_link(value: str) -> str:
    """Acepta enlaces de carpetas de Drive, no IDs libres ni enlaces a archivos."""
    raw = str(value or '').strip()
    try:
        url = urlparse(raw)
    except ValueError as exc:
        raise ValueError('Enlace de Drive inválido.') from exc
    if url.scheme != 'https' or (url.hostname or '').lower() != 'drive.google.com':
        raise ValueError('Usa un enlace https://drive.google.com/drive/folders/…')
    if url.username or url.password or url.port is not None:
        raise ValueError('Enlace de Drive inválido.')
    match = _DRIVE_PATH.fullmatch(url.path)
    if match:
        folder_id = match.group(1)
    elif url.path == '/open':
        values = parse_qs(url.query).get('id', [])
        folder_id = values[0] if len(values) == 1 else ''
    else:
        folder_id = ''
    if not _DRIVE_ID.fullmatch(folder_id):
        raise ValueError('El enlace no contiene un ID válido de carpeta de Drive.')
    return folder_id


def normalize_assignments(values):
    if not isinstance(values, list) or len(values) > 5:
        raise ValueError('Puedes asignar como máximo cinco carpetas por usuario.')
    seen = set()
    result = []
    for item in values:
        if not isinstance(item, dict):
            raise ValueError('Formato de carpeta inválido.')
        folder_id = parse_drive_folder_link(item.get('url'))
        if folder_id in seen:
            raise ValueError('La misma carpeta no puede asignarse dos veces.')
        seen.add(folder_id)
        result.append({'id': folder_id, 'url': f'https://drive.google.com/drive/folders/{folder_id}'})
    return result


def scoped_chain(chain_from_target, allowed_ids):
    """Lista meta desde el destino al padre; devuelve el tramo hasta una raíz asignada."""
    allowed = set(allowed_ids)
    for index, meta in enumerate(chain_from_target):
        if str(meta.get('id') or '') in allowed:
            return list(reversed(chain_from_target[:index+1]))
    return None
