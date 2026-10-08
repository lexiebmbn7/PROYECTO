# Carpetas autorizadas por usuario · DataVault DLP

1. En **Supabase → SQL Editor**, ejecutar `sql/20261007_user_drive_permissions.sql`.
2. Conservar en **Railway** las variables de Supabase y Google Drive que ya utiliza el backend. No insertar claves en HTML o JS.
3. Desplegar esta versión del backend y frontend juntos. Entrar como administrador (rol protegido `app_metadata.rol = jefe`).
4. Ir a **Usuarios → Carpetas Drive**, pegar hasta cinco enlaces `https://drive.google.com/drive/folders/<ID>` y guardar.
5. Iniciar sesión como subordinado. El navegador mostrará una raíz virtual **Mis carpetas** que no es el ROOT real. Debe navegar por la carpeta asignada y elegirla (o una subcarpeta) para cargar archivos o solicitar movimientos.
6. Comprobar con otro usuario no autorizado que no pueda consultar `/drive/browse?folder_id=<ID_restringido>`, `/drive/breadcrumb?folder_id=...`, registrar una subida a ella ni solicitar movimientos desde/hacia ella (HTTP 403).

**Seguridad:** la restricción actúa **dentro de DataVault** y no revoca el acceso que un usuario tenga al Drive original desde fuera de la aplicación. El administrador conserva acceso a la raíz configurada. Si se revoca un permiso, las nuevas operaciones y las solicitudes pendientes verifican la autorización al momento de procesarse. Los registros históricos permanecen para auditoría.

**Nota de despliegue:** antes de aplicar el SQL, las solicitudes de carpetas de subordinados fallarán de forma segura (no se les dará acceso general). Las cuentas administradoras existentes deben tener `app_metadata.rol = jefe`: no se permite elevar privilegios desde `user_metadata`, que puede modificar el propietario de la cuenta. Los enlaces asignables deben ser accesibles por la cuenta de Drive utilizada por el backend; pueden pertenecer a otra carpeta o unidad compartida, siempre que Google autorice acceso a esa cuenta.

**No probado contra servicios reales:** se incluyeron tests locales y validaciones de sintaxis, pero no se proporcionaron credenciales de pruebas de Drive/Supabase ni se cambió ninguna configuración remota.
