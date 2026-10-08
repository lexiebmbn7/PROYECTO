/* Existing DataVault integrations; classic script globals are preserved. */

/* Existing application */


// =======================================================
// CONFIG
// =======================================================
const API_URL = window.location.origin;

const SUPABASE_URL = "https://crujlbbhtkcithullgfs.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNydWpsYmJodGtjaXRodWxsZ2ZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkzOTQ0ODAsImV4cCI6MjEwNDk3MDQ4MH0.IJTGJ02ldBKp1_yLejsN4643PCj70sxNOKCE0e-YLGw";
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: true,
    detectSessionInUrl: false
  }
});

// Etiquetas heredadas para controles antiguos. El esquema actual de auditoria_custodia usa lote_id + ruta_relativa.
const CARPETAS = ["PLANOS", "INFORMES", "CUSTODIA", "PROYECTOS", "CONTRATOS"];

let currentUserEmail = "";
let currentDisplayName = "";
let currentRole = "subordinado"; // "jefe" | "subordinado"
let currentUser = null; // objeto completo de Supabase Auth
let selectedFiles = [];          // archivos elegidos para subir (lote)
let auditRealtimeChannel = null;
let colaRealtimeChannel = null;

// =======================================================
// AUTH / HTTP GLOBAL · único helper para rutas protegidas
// =======================================================
async function authHeaders(json=true) {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) throw error;
  const token = data?.session?.access_token;
  if (!token) throw new Error('No existe una sesión válida. Inicia sesión nuevamente.');
  const headers = { Authorization: `Bearer ${token}` };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}
window.authHeaders = authHeaders;

function dvHttpErrorMessage(response, data, fallback='No se pudo completar la operación.') {
  const detail = data?.detail;
  const backendMessage =
    (detail && typeof detail === 'object' && (detail.message || detail.mensaje || detail.detail)) ||
    (typeof detail === 'string' ? detail : '') ||
    data?.message || '';

  if (backendMessage) return String(backendMessage);

  const status = Number(response?.status || 0);
  if (status === 401) return 'Tu sesión expiró o no es válida. Inicia sesión nuevamente.';
  if (status === 403) return 'No tienes permisos para acceder a esta ubicación de Google Drive.';
  if (status === 409) return 'La carpeta o el estado actual no permiten completar esta operación.';
  if (status === 502) return 'No se pudo cargar Google Drive. Intenta nuevamente.';
  if (status === 503) return 'Google Drive no está configurado en el servidor.';
  return fallback;
}
window.dvHttpErrorMessage = dvHttpErrorMessage;

// =======================================================
// UTILIDADES
// =======================================================
function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, val = bytes;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(1)} ${units[i]}`;
}

// Nombre visual de carpeta usando el esquema ACTUAL de auditoria_custodia.
// La tabla no tiene una columna `carpeta`; las carpetas se representan con
// lote_id + ruta_relativa (ej.: "PRACTICA EMPRESA SENATI/subcarpeta/archivo.pdf").
function auditFolderName(row) {
  const ruta = String(row?.ruta_relativa || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (row?.lote_id && ruta.includes('/')) return ruta.split('/')[0] || 'Carpeta';
  return 'Archivo suelto';
}

function populateCarpetaSelects() {
  const selects = ["moverOrigen", "moverDestino", "eliminarOrigen"];
  selects.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = CARPETAS.map(c => `<option value="${c}">${c}</option>`).join("");
  });
}

// =======================================================
// NAVEGACIÓN
// =======================================================
function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById(`view-${name}`).classList.add("active");

  document.querySelectorAll("[data-nav]").forEach(b => b.classList.remove("active"));
  const navBtn = document.querySelector(`[data-nav="${name}"]`);
  if (navBtn) navBtn.classList.add("active");

  const titles = { inicio: "Inicio", gestor: "Gestor de Archivos", operaciones: "Operaciones de archivo", cola: "Cola de Solicitudes", reglas: "Reglas DLP", reportes: "Reportes", auditoria: "Historial y Auditoría", usuarios: "Usuarios" };
  document.getElementById("headerTitle").innerText = titles[name] || "";

  if (name === "cola") loadCola();
  if (name === "auditoria") loadAudit();
  if (name === "operaciones") {
    populateCarpetaSelects();
    showTab("subir");
  }

  closeMobileSidebar();
}

function showTab(name) {
  document.querySelectorAll(".tab-content").forEach(t => t.classList.add("hidden"));
  document.getElementById(`tab-${name}`).classList.remove("hidden");
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelector(`[data-tab="${name}"]`).classList.add("active");
}

// =======================================================
// LOGIN / LOGOUT
// =======================================================
async function handleLogin(e) {
  e.preventDefault();

  const email = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const loginBtn = document.getElementById('loginBtn');
  const loginError = document.getElementById('loginError');

  loginError.classList.add('hidden');
  loginError.textContent = "";
  loginBtn.disabled = true;
  loginBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Verificando credenciales...';

  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (!data || !data.user) throw new Error("Supabase no devolvió el usuario.");

    const remember = document.getElementById('rememberUser')?.checked;
    if (remember) localStorage.setItem('datavault_remembered_email', email);
    else localStorage.removeItem('datavault_remembered_email');

    setSessionFromUser(data.user);
    enterApp();

  } catch (error) {
    console.error("LOGIN ERROR:", error);
    loginError.textContent = "Acceso denegado: " + (error.message || "Error desconocido");
    loginError.classList.remove("hidden");
  } finally {
    loginBtn.disabled = false;
    loginBtn.innerHTML = '<span>Ingresar</span><i class="fa-solid fa-arrow-right text-[10px]"></i>';
  }
}

function togglePasswordVisibility() {
  const input = document.getElementById('password');
  const button = document.getElementById('togglePasswordBtn');
  if (!input || !button) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  button.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
  button.setAttribute('title', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
  button.innerHTML = `<i class="fa-regular ${show ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
  input.focus();
}

function hydrateRememberedLogin() {
  const savedEmail = localStorage.getItem('datavault_remembered_email') || '';
  const emailInput = document.getElementById('username');
  const remember = document.getElementById('rememberUser');
  if (emailInput && savedEmail) emailInput.value = savedEmail;
  if (remember) remember.checked = Boolean(savedEmail);
}

function setSessionFromUser(user) {
  currentUser = user;
  currentUserEmail = user.email;
  currentDisplayName = user.user_metadata?.full_name || currentUserEmail;
  currentRole = (user.app_metadata?.rol || "subordinado").toLowerCase();

  const inicial = currentDisplayName.substring(0, 1).toUpperCase();
  const rolTexto = currentRole === "jefe" ? "Jefe" : "Subordinado";
  const rolBadgeClass = currentRole === "jefe"
    ? "bg-blue-50 text-blue-600 border-blue-200"
    : "bg-slate-100 text-slate-500 border-slate-200";

  document.getElementById('userBadge').innerText = currentDisplayName;
  document.getElementById('userRoleBadge').innerText = rolTexto;
  document.getElementById('userAvatar').innerText = inicial;

  // Panel de detalles del perfil
  document.getElementById('profileAvatarBig').innerText = inicial;
  document.getElementById('profileNombre').innerText = currentDisplayName;
  document.getElementById('profileCorreo').innerText = currentUserEmail;
  document.getElementById('profileRolTexto').innerText = rolTexto;
  const rolBadgeEl = document.getElementById('profileRolBadge');
  rolBadgeEl.innerText = rolTexto;
  rolBadgeEl.className = "text-[11px] px-2 py-0.5 rounded-full border " + rolBadgeClass;

  document.getElementById('profileMiembroDesde').innerText = user.created_at
    ? new Date(user.created_at).toLocaleDateString('es-PE', { year: 'numeric', month: 'short', day: 'numeric' })
    : "—";
  document.getElementById('profileUltimoAcceso').innerText = user.last_sign_in_at
    ? new Date(user.last_sign_in_at).toLocaleString('es-PE', { dateStyle: 'medium', timeStyle: 'short' })
    : "—";

  const isJefe = currentRole === "jefe";
  document.getElementById('adminLabel').classList.toggle('hidden', !isJefe);
  document.getElementById('navUsuarios').classList.toggle('hidden', !isJefe);
  const topUsers = document.getElementById('topNavUsuarios'); if(topUsers) topUsers.classList.toggle('hidden', !isJefe);
}

function toggleProfileMenu() {
  document.getElementById('profileMenu').classList.toggle('hidden');
}

function toggleSidebar() {
  const sidebarEl = document.getElementById('sidebar');
  const overlayEl = document.getElementById('sidebarOverlay');
  const topbarEl = document.getElementById('topbar');
  const useMobileMenu = window.innerWidth <= 900 || (topbarEl && topbarEl.classList.contains('compact-nav'));

  if (useMobileMenu) {
    // Cuando la barra superior ya no tiene espacio, el menú pasa a ser sandwich
    // aunque la pantalla todavía sea de escritorio/tablet.
    const isOpen = sidebarEl.classList.toggle('mobile-open');
    overlayEl.classList.toggle('show', isOpen);
    const menuBtn = document.querySelector('.mobile-menu-btn');
    if (menuBtn) {
      menuBtn.setAttribute('aria-expanded', String(isOpen));
      menuBtn.innerHTML = isOpen ? '<i class="fa-solid fa-xmark"></i>' : '<i class="fa-solid fa-bars"></i>';
    }
    return;
  }

  // Escritorio amplio: conservar el comportamiento de colapsar la barra lateral.
  sidebarEl.classList.toggle('collapsed');
  const collapsed = sidebarEl.classList.contains('collapsed');
  sidebarEl.classList.toggle('w-64', !collapsed);
  sidebarEl.classList.toggle('w-[4.5rem]', collapsed);
}

function closeMobileSidebar() {
  document.getElementById('sidebar').classList.remove('mobile-open');
  document.getElementById('sidebarOverlay').classList.remove('show');
  const menuBtn = document.querySelector('.mobile-menu-btn');
  if (menuBtn) {
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.innerHTML = '<i class="fa-solid fa-bars"></i>';
  }
}

window.addEventListener('resize', () => {
  updateTopbarResponsive();
  const topbarEl = document.getElementById('topbar');
  const stillNeedsMenu = topbarEl && topbarEl.classList.contains('compact-nav');
  if (window.innerWidth > 900 && !stillNeedsMenu) closeMobileSidebar();
});

/* La navegación superior se adapta al ESPACIO REAL disponible.
   No usamos un breakpoint fijo: primero se intenta mostrar todos los botones;
   si el ancho de la barra no alcanza, se cambia automáticamente a sandwich. */
function updateTopbarResponsive() {
  const topbar = document.getElementById('topbar');
  const nav = topbar && topbar.querySelector('.topbar-nav');
  const brand = topbar && topbar.querySelector('.topbar-brand');
  const actions = topbar && topbar.querySelector('.topbar-actions');
  const menuBtn = topbar && topbar.querySelector('.mobile-menu-btn');
  if (!topbar || !nav || !brand || !actions || !menuBtn) return;

  // En móvil se mantiene el modo sandwich directamente.
  if (window.innerWidth <= 900) {
    topbar.classList.add('compact-nav');
    return;
  }

  // Medimos la barra con la navegación visible, pero sin dejar que el contenido
  // se comprima artificialmente. El sandwich aparece justo cuando ya no cabe.
  topbar.classList.remove('compact-nav');
  nav.style.visibility = 'hidden';
  nav.style.position = 'absolute';
  nav.style.whiteSpace = 'nowrap';
  const topbarStyle = getComputedStyle(topbar);
  const horizontalPadding = parseFloat(topbarStyle.paddingLeft || 0) + parseFloat(topbarStyle.paddingRight || 0);
  const gap = parseFloat(topbarStyle.gap || 0);
  const available = topbar.clientWidth - horizontalPadding - brand.offsetWidth - actions.offsetWidth - (gap * 2);
  const required = nav.scrollWidth;

  nav.style.visibility = '';
  nav.style.position = '';
  nav.style.whiteSpace = '';

  // Un pequeño margen evita que el último botón quede cortado por 1–2 px.
  const needsMenu = required > available - 8;
  topbar.classList.toggle('compact-nav', needsMenu);

  if (!needsMenu) closeMobileSidebar();
}

window.addEventListener('DOMContentLoaded', () => {
  updateTopbarResponsive();
  const topbar = document.getElementById('topbar');
  const appSection = document.getElementById('appSection');
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => updateTopbarResponsive());
    if (topbar) ro.observe(topbar);
    if (appSection) ro.observe(appSection);
  }
  if (appSection && window.MutationObserver) {
    new MutationObserver(() => updateTopbarResponsive()).observe(appSection, {attributes:true, attributeFilter:['class','style']});
  }
  setTimeout(updateTopbarResponsive, 250);
});

document.addEventListener('click', (e) => {
  const menu = document.getElementById('profileMenu');
  if (!menu || menu.classList.contains('hidden')) return;
  const wrapper = menu.parentElement;
  if (!wrapper.contains(e.target)) menu.classList.add('hidden');
});

function enterApp() {
  document.getElementById('loginSection').classList.add('hidden');
  document.getElementById('appSection').classList.remove('hidden');
  populateCarpetaSelects();
  showView('inicio');
  loadAudit();
  loadCola();
  listenRealtime();
}

async function handleLogout() {
  await supabaseClient.auth.signOut();
  currentUserEmail = ""; currentDisplayName = ""; currentRole = "subordinado";
  if(typeof dvResetUploadDestination==='function')dvResetUploadDestination();
  if(typeof dvSelectedEntries!=='undefined')dvSelectedEntries=[];
  if(typeof dvUploadDestinationFolders!=='undefined')dvUploadDestinationFolders=[];
  if (auditRealtimeChannel) { supabaseClient.removeChannel(auditRealtimeChannel); auditRealtimeChannel = null; }
  if (colaRealtimeChannel) { supabaseClient.removeChannel(colaRealtimeChannel); colaRealtimeChannel = null; }
  document.getElementById('appSection').classList.add('hidden');
  document.getElementById('loginSection').classList.remove('hidden');
}

window.addEventListener('DOMContentLoaded', () => {
  hydrateRememberedLogin();
  const login = document.getElementById('loginSection');
  const app = document.getElementById('appSection');
  if (login) login.classList.remove('hidden');
  if (app) app.classList.add('hidden');
  document.getElementById('password')?.value && (document.getElementById('password').value = '');
});

// =======================================================
// SUBIR (LOTE)
// =======================================================
function handleFilesSelected(fileList) {
  selectedFiles = selectedFiles.concat(Array.from(fileList));
  renderSelectedFiles();
}

function removeSelectedFile(index) {
  selectedFiles.splice(index, 1);
  renderSelectedFiles();
}

function renderSelectedFiles() {
  const container = document.getElementById('selectedFilesList');
  const btn = document.getElementById('uploadBatchBtn');

  if (selectedFiles.length === 0) {
    container.classList.add('hidden');
    container.innerHTML = "";
    btn.disabled = true;
    return;
  }

  container.classList.remove('hidden');
  container.innerHTML = selectedFiles.map((f, i) => `
    <div class="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
      <div class="flex items-center gap-2 min-w-0">
        <i class="fa-solid fa-file text-blue-500"></i>
        <span class="text-sm text-slate-700 truncate">${escapeHtml(f.name)}</span>
        <span class="text-xs text-slate-400 flex-shrink-0">${formatBytes(f.size)}</span>
      </div>
      <button onclick="removeSelectedFile(${i})" class="text-slate-400 hover:text-red-500 transition"><i class="fa-solid fa-xmark"></i></button>
    </div>
  `).join("");
  btn.disabled = false;
}

async function submitUploadBatch() {
  if (selectedFiles.length === 0) return;

  const carpeta = document.getElementById('uploadCarpeta').value;
  const statusDiv = document.getElementById('uploadStatus');
  const btn = document.getElementById('uploadBatchBtn');

  statusDiv.classList.remove('hidden');
  statusDiv.className = "mt-3 text-sm font-semibold text-amber-600";
  statusDiv.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Procesando lote de ${selectedFiles.length} archivo(s)...`;
  btn.disabled = true;

  const formData = new FormData();
  selectedFiles.forEach(f => formData.append('archivos', f));
  formData.append('usuario', currentDisplayName || currentUserEmail);
  formData.append('carpeta', carpeta);
  formData.append('tipo_operacion', 'SUBIDA_MASIVA');

  try {
    const response = await fetch(`${API_URL}/upload-lote`, { method: 'POST', body: formData });
    let data = {};
    try { data = await response.json(); } catch (_) {}

    if (!response.ok) {
      throw new Error(typeof data.detail === 'string' ? data.detail : (data.detail?.mensaje || `Error HTTP ${response.status}`));
    }

    statusDiv.className = "mt-3 text-sm font-semibold text-green-600";
    statusDiv.innerHTML = `<i class="fa-solid fa-circle-check mr-2"></i>Lote enviado a custodia (${selectedFiles.length} archivo(s)). Notificación agrupada enviada a Telegram.`;

    selectedFiles = [];
    renderSelectedFiles();
    loadAudit();

  } catch (err) {
    console.error("UPLOAD LOTE ERROR:", err);
    statusDiv.className = "mt-3 text-sm font-semibold text-red-600";
    statusDiv.innerHTML = '<i class="fa-solid fa-circle-xmark mr-2"></i>Error: ' + escapeHtml(err.message || 'Error desconocido');
    btn.disabled = false;
  }
}

// =======================================================
// LISTAR ARCHIVOS POR CARPETA (para Mover / Eliminar)
// =======================================================
async function cargarArchivosCarpeta(modo) {
  const origenId = modo === 'mover' ? 'moverOrigen' : 'eliminarOrigen';
  const listId = modo === 'mover' ? 'moverFilesList' : 'eliminarFilesList';
  const btnId = modo === 'mover' ? 'moverBatchBtn' : 'eliminarBatchBtn';

  const carpeta = document.getElementById(origenId).value;
  const listEl = document.getElementById(listId);
  listEl.innerHTML = `<p class="p-4 text-center text-slate-400 text-sm"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Cargando archivos de ${escapeHtml(carpeta)}...</p>`;
  document.getElementById(btnId).disabled = true;

  const { data: rawData, error } = await supabaseClient
    .from('auditoria_custodia')
    .select('id,nombre_archivo,hash_sha256,lote_id,ruta_relativa,estado,fecha_solicitud')
    .eq('estado', 'APROBADO')
    .order('fecha_solicitud', { ascending: false })
    .limit(500);

  const data = (Array.isArray(rawData) ? rawData : [])
    .filter(row => auditFolderName(row) === carpeta);

  if (error) {
    console.error("Error cargando archivos de carpeta:", error);
    listEl.innerHTML = `<p class="p-4 text-center text-red-400 text-sm">No se pudo cargar la lista de archivos.</p>`;
    return;
  }

  if (!data || data.length === 0) {
    listEl.innerHTML = `<p class="p-4 text-center text-slate-400 text-sm">No hay archivos registrados en esta carpeta.</p>`;
    return;
  }

  listEl.innerHTML = data.map(row => `
    <label class="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 cursor-pointer">
      <input type="checkbox" class="archivo-checkbox" data-modo="${modo}" data-id="${row.id}" data-nombre="${escapeHtml(row.nombre_archivo)}"
        onchange="onFileCheckboxChange('${modo}')" class="rounded border-slate-300">
      <i class="fa-solid fa-file text-blue-400 text-sm"></i>
      <span class="text-sm text-slate-700 truncate">${escapeHtml(row.nombre_archivo)}</span>
    </label>
  `).join("");
}

function onFileCheckboxChange(modo) {
  const btnId = modo === 'mover' ? 'moverBatchBtn' : 'eliminarBatchBtn';
  const checked = document.querySelectorAll(`.archivo-checkbox[data-modo="${modo}"]:checked`);
  document.getElementById(btnId).disabled = checked.length === 0;
}

// =======================================================
// MOVER (LOTE)
// =======================================================
async function submitMoveBatch() {
  const checked = Array.from(document.querySelectorAll('.archivo-checkbox[data-modo="mover"]:checked'));
  if (checked.length === 0) return;

  const origen = document.getElementById('moverOrigen').value;
  const destino = document.getElementById('moverDestino').value;
  const statusDiv = document.getElementById('moverStatus');
  const btn = document.getElementById('moverBatchBtn');

  if (origen === destino) {
    statusDiv.classList.remove('hidden');
    statusDiv.className = "mt-3 text-sm font-semibold text-red-600";
    statusDiv.innerHTML = '<i class="fa-solid fa-circle-xmark mr-2"></i>La carpeta destino debe ser distinta a la de origen.';
    return;
  }

  statusDiv.classList.remove('hidden');
  statusDiv.className = "mt-3 text-sm font-semibold text-amber-600";
  statusDiv.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Solicitando movimiento de ${checked.length} archivo(s)...`;
  btn.disabled = true;

  const payload = {
    tipo_operacion: "MOVIMIENTO_MASIVO",
    usuario: currentDisplayName || currentUserEmail,
    carpeta_origen: origen,
    carpeta_destino: destino,
    archivos: checked.map(c => ({ id: c.dataset.id, nombre: c.dataset.nombre }))
  };

  try {
    const response = await fetch(`${API_URL}/mover-lote`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : (data.detail?.mensaje || `Error HTTP ${response.status}`));

    statusDiv.className = "mt-3 text-sm font-semibold text-green-600";
    statusDiv.innerHTML = `<i class="fa-solid fa-circle-check mr-2"></i>Solicitud de movimiento enviada. Quedará en la Cola de Solicitudes hasta su aprobación.`;
    document.getElementById('moverFilesList').innerHTML = `<p class="p-4 text-center text-slate-400 text-sm">Selecciona una carpeta origen para ver sus archivos.</p>`;

  } catch (err) {
    console.error("MOVER LOTE ERROR:", err);
    statusDiv.className = "mt-3 text-sm font-semibold text-red-600";
    statusDiv.innerHTML = '<i class="fa-solid fa-circle-xmark mr-2"></i>Error: ' + escapeHtml(err.message || 'Error desconocido');
    btn.disabled = false;
  }
}

// =======================================================
// ELIMINAR (LOTE)
// =======================================================
async function submitDeleteBatch() {
  const checked = Array.from(document.querySelectorAll('.archivo-checkbox[data-modo="eliminar"]:checked'));
  if (checked.length === 0) return;

  if (!confirm(`¿Confirmas solicitar la eliminación de ${checked.length} archivo(s)? Esta acción requiere aprobación del jefe / custodio.`)) return;

  const origen = document.getElementById('eliminarOrigen').value;
  const statusDiv = document.getElementById('eliminarStatus');
  const btn = document.getElementById('eliminarBatchBtn');

  statusDiv.classList.remove('hidden');
  statusDiv.className = "mt-3 text-sm font-semibold text-amber-600";
  statusDiv.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Solicitando eliminación de ${checked.length} archivo(s)...`;
  btn.disabled = true;

  const payload = {
    tipo_operacion: "ELIMINACION_MASIVA",
    usuario: currentDisplayName || currentUserEmail,
    carpeta_origen: origen,
    archivos: checked.map(c => ({ id: c.dataset.id, nombre: c.dataset.nombre }))
  };

  try {
    const response = await fetch(`${API_URL}/eliminar-lote`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : (data.detail?.mensaje || `Error HTTP ${response.status}`));

    statusDiv.className = "mt-3 text-sm font-semibold text-green-600";
    statusDiv.innerHTML = `<i class="fa-solid fa-circle-check mr-2"></i>Solicitud de eliminación enviada. Quedará en la Cola de Solicitudes hasta su aprobación.`;
    document.getElementById('eliminarFilesList').innerHTML = `<p class="p-4 text-center text-slate-400 text-sm">Selecciona una carpeta origen para ver sus archivos.</p>`;

  } catch (err) {
    console.error("ELIMINAR LOTE ERROR:", err);
    statusDiv.className = "mt-3 text-sm font-semibold text-red-600";
    statusDiv.innerHTML = '<i class="fa-solid fa-circle-xmark mr-2"></i>Error: ' + escapeHtml(err.message || 'Error desconocido');
    btn.disabled = false;
  }
}

// =======================================================
// COLA DE SOLICITUDES (agrupada por lote)
// =======================================================
async function loadCola() {
  const container = document.getElementById('colaContainer');

  const { data, error } = await supabaseClient
    .from('solicitudes_lote')
    .select('*')
    .order('fecha_solicitud', { ascending: false })
    .limit(50);

  if (error) {
    console.error("Error cargando cola:", error);
    container.innerHTML = `<p class="p-6 text-center text-red-400 text-sm">No se pudo cargar la cola de solicitudes.</p>`;
    return;
  }

  if (!data || data.length === 0) {
    container.innerHTML = `<p class="p-6 text-center text-slate-400 text-sm">No hay solicitudes registradas.</p>`;
    updateKpis({ pendientes: 0 });
    return;
  }

  const pendientes = data.filter(l => l.estado === 'PENDIENTE').length;
  updateKpis({ pendientes });

  const iconos = { SUBIDA_MASIVA: 'fa-upload text-blue-500', MOVIMIENTO_MASIVO: 'fa-arrows-turn-right text-amber-500', ELIMINACION_MASIVA: 'fa-trash text-red-500' };
  const etiquetas = { SUBIDA_MASIVA: 'Subida masiva', MOVIMIENTO_MASIVO: 'Movimiento masivo', ELIMINACION_MASIVA: 'Eliminación masiva' };

  container.innerHTML = data.map(lote => {
    const archivos = Array.isArray(lote.archivos) ? lote.archivos : (typeof lote.archivos === 'string' ? JSON.parse(lote.archivos || '[]') : []);
    const badge = lote.estado === 'APROBADO' ? 'bg-green-50 text-green-600 border-green-200'
                : lote.estado === 'RECHAZADO' ? 'bg-red-50 text-red-600 border-red-200'
                : 'bg-amber-50 text-amber-600 border-amber-200';

    const acciones = (currentRole === 'jefe' && lote.estado === 'PENDIENTE') ? `
      <div class="flex gap-2 mt-3">
        <button onclick="resolverLote('${lote.id}', 'APROBADO')" class="bg-green-600 hover:bg-green-500 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition">
          <i class="fa-solid fa-check mr-1"></i>Aprobar lote
        </button>
        <button onclick="resolverLote('${lote.id}', 'RECHAZADO')" class="bg-red-600 hover:bg-red-500 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition">
          <i class="fa-solid fa-xmark mr-1"></i>Rechazar lote
        </button>
      </div>` : '';

    return `
      <div class="p-4">
        <div class="flex items-start justify-between gap-3">
          <div class="flex items-start gap-3 min-w-0">
            <div class="h-9 w-9 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
              <i class="fa-solid ${iconos[lote.tipo_operacion] || 'fa-file'}"></i>
            </div>
            <div class="min-w-0">
              <p class="text-sm font-semibold text-slate-800">
                ${escapeHtml(lote.usuario_solicitante)} · ${etiquetas[lote.tipo_operacion] || lote.tipo_operacion}
              </p>
              <p class="text-xs text-slate-400 mt-0.5">
                ${archivos.length} archivo(s)
                ${lote.carpeta_origen ? ' · desde ' + escapeHtml(lote.carpeta_origen) : ''}
                ${lote.carpeta_destino ? ' → ' + escapeHtml(lote.carpeta_destino) : ''}
              </p>
              <details class="mt-2">
                <summary class="text-xs text-blue-600 cursor-pointer">Ver archivos</summary>
                <ul class="mt-1 text-xs text-slate-500 list-disc list-inside max-h-32 overflow-y-auto">
                  ${archivos.map(a => `<li>${escapeHtml(a.nombre || a.nombre_archivo || 'Archivo')}</li>`).join('')}
                </ul>
              </details>
              ${acciones}
            </div>
          </div>
          <span class="px-2.5 py-1 rounded-full text-xs border flex-shrink-0 ${badge}">${escapeHtml(lote.estado || 'PENDIENTE')}</span>
        </div>
      </div>`;
  }).join('');
}

async function resolverLote(loteId, nuevoEstado) {
  if (currentRole !== 'jefe') return;
  try {
    const response = await fetch(`${API_URL}/lote/${loteId}/resolver`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ estado: nuevoEstado, resuelto_por: currentDisplayName || currentUserEmail })
    });
    if (!response.ok) throw new Error(`Error HTTP ${response.status}`);
    loadCola();
  } catch (err) {
    console.error("RESOLVER LOTE ERROR:", err);
    alert("No se pudo actualizar el lote: " + (err.message || "error desconocido"));
  }
}

// =======================================================
// AUDITORÍA / INICIO
// =======================================================
async function loadAudit() {
  const { data, error } = await supabaseClient
    .from('auditoria_custodia')
    .select('*')
    .order('fecha_solicitud', { ascending: false })
    .limit(10);

  const auditBody = document.getElementById('auditTableBody');
  const inicioBody = document.getElementById('inicioTableBody');

  if (error) {
    console.error("Error al consultar Supabase:", error);
    return;
  }

  if (!data || data.length === 0) {
    const emptyRow = `<tr><td colspan="5" class="p-4 text-center text-slate-400">No existen registros.</td></tr>`;
    auditBody.innerHTML = emptyRow;
    inicioBody.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-slate-400">No existen registros.</td></tr>`;
    updateKpis({ archivos: 0, hash: 0 });
    return;
  }

  updateKpis({ archivos: data.length, hash: data.filter(r => r.hash_sha256).length });

  const badgeFor = (estado) => estado === 'APROBADO' ? 'bg-green-50 text-green-600 border-green-200'
    : estado === 'RECHAZADO' ? 'bg-red-50 text-red-600 border-red-200'
    : 'bg-amber-50 text-amber-600 border-amber-200';

  auditBody.innerHTML = data.map(row => {
    const nombre = escapeHtml(row.nombre_archivo || 'Sin nombre');
    const usuario = escapeHtml(row.usuario_solicitante || 'Usuario desconocido');
    const carpeta = escapeHtml(auditFolderName(row));
    const estado = escapeHtml(row.estado || 'PENDIENTE');
    const hashCompleto = row.hash_sha256 || '';
    const hashCorto = hashCompleto ? escapeHtml(hashCompleto.substring(0, 16)) + '...' : 'N/A';

    return `
      <tr class="border-b border-slate-100 hover:bg-slate-50 transition">
        <td class="p-3 font-medium text-slate-800">${nombre}</td>
        <td class="p-3 text-slate-500">${usuario}</td>
        <td class="p-3 text-slate-500">${carpeta}</td>
        <td class="p-3 font-mono text-xs text-blue-600" title="${escapeHtml(hashCompleto)}">${hashCorto}</td>
        <td class="p-3"><span class="px-2.5 py-1 rounded-full text-xs border ${badgeFor(row.estado)}">${estado}</span></td>
      </tr>`;
  }).join('');

  inicioBody.innerHTML = data.slice(0, 5).map(row => `
    <tr class="border-b border-slate-100 hover:bg-slate-50 transition">
      <td class="p-3 font-medium text-slate-800">${escapeHtml(row.nombre_archivo || 'Sin nombre')}</td>
      <td class="p-3 text-slate-500">${escapeHtml(row.usuario_solicitante || 'Usuario desconocido')}</td>
      <td class="p-3 text-slate-500">${escapeHtml(auditFolderName(row))}</td>
      <td class="p-3"><span class="px-2.5 py-1 rounded-full text-xs border ${badgeFor(row.estado)}">${escapeHtml(row.estado || 'PENDIENTE')}</span></td>
    </tr>`).join('');
}

function updateKpis({ archivos, carpetas, pendientes, hash }) {
  if (archivos !== undefined) document.getElementById('kpiArchivos').innerText = archivos;
  if (hash !== undefined) document.getElementById('kpiHash').innerText = hash;
  if (pendientes !== undefined) {
    document.getElementById('kpiPendientes').innerText = pendientes;
    const badge = document.getElementById('bellBadge');
    if (pendientes > 0) {
      badge.innerText = pendientes;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
  document.getElementById('kpiCarpetas').innerText = CARPETAS.length;
}

// =======================================================
// REALTIME
// =======================================================
function listenRealtime() {
  if (!auditRealtimeChannel) {
    auditRealtimeChannel = supabaseClient
      .channel('realtime_audit')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'auditoria_custodia' }, () => loadAudit())
      .subscribe();
  }
  if (!colaRealtimeChannel) {
    colaRealtimeChannel = supabaseClient
      .channel('realtime_cola')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'solicitudes_lote' }, () => {
        if (document.getElementById('view-cola').classList.contains('active')) loadCola();
      })
      .subscribe();
  }
}

// =======================================================
// DRAG & DROP
// =======================================================
const dropZoneEl = document.getElementById('dropZone');
const dropUploadAllowed = () => !['jefe','admin','administrador'].includes(String(currentRole || '').trim().toLowerCase());
['dragenter', 'dragover'].forEach(evt => {
  dropZoneEl.addEventListener(evt, e => {
    if(e.dataTransfer?.types?.includes('application/x-datavault-item')) return;
    if(!dropUploadAllowed()) return;
    e.preventDefault();
    dropZoneEl.classList.add('drop-active');
  });
});
['dragleave', 'drop'].forEach(evt => {
  dropZoneEl.addEventListener(evt, e => {
    if(e.dataTransfer?.types?.includes('application/x-datavault-item')) return;
    if(!dropUploadAllowed()) return;
    e.preventDefault();
    dropZoneEl.classList.remove('drop-active');
  });
});
dropZoneEl.addEventListener('drop', async e => {
  if(e.dataTransfer?.types?.includes('application/x-datavault-item')) return;
  if (!dropUploadAllowed() || dvUploadInProgress) return;

  const items = Array.from(e.dataTransfer?.items || []);
  const entradas = [];

  // En Chromium/Brave esto permite arrastrar una carpeta completa
  // y conservar también todas sus subcarpetas.
  const roots = items
    .map(item => item.webkitGetAsEntry ? item.webkitGetAsEntry() : null)
    .filter(Boolean);

  async function leerTodasLasEntradas(reader){
    const total = [];
    while(true){
      const bloque = await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));
      if(!bloque.length) break;
      total.push(...bloque);
    }
    return total;
  }

  async function recorrerEntry(entry, rutaBase){
    if(entry.isFile){
      const file = await new Promise((resolve,reject)=>entry.file(resolve,reject));
      entradas.push({ file, relativePath: rutaBase });
      return;
    }
    if(entry.isDirectory){
      const reader = entry.createReader();
      const hijos = await leerTodasLasEntradas(reader);
      for(const hijo of hijos){
        await recorrerEntry(hijo, `${rutaBase}/${hijo.name}`);
      }
    }
  }

  if(roots.length){
    try{
      for(const root of roots){
        await recorrerEntry(root, root.name);
      }

      if(entradas.length){
        const primeraRaiz = roots[0];
        const esCarpeta = roots.length === 1 && primeraRaiz?.isDirectory;

        dvSelectionMode = esCarpeta ? 'folder' : 'files';
        dvSelectedFolderName = esCarpeta ? (primeraRaiz.name || 'Carpeta') : '';
        dvSelectedEntries = entradas.sort((a,b)=>a.relativePath.localeCompare(b.relativePath,'es',{numeric:true,sensitivity:'base'}));
        renderSelectedFiles();
        return;
      }
    }catch(error){
      console.warn('[DROP FOLDER ERROR]', error);
    }
  }

  // Respaldo para arrastrar únicamente archivos sueltos.
  if (e.dataTransfer.files?.length) handleFilesSelected(e.dataTransfer.files,false);
});



// =======================================================
// VISTAS COMPLEMENTARIAS: DLP / REPORTES / ARCHIVOS
// =======================================================
let auditCache = [];
let colaCache = [];

const DLP_RULES_DEFAULT = [
  { id:'extensiones', nombre:'Bloqueo de extensiones no permitidas', desc:'Controla tipos de archivo considerados de riesgo antes de ingresar a custodia.', estado:true, icon:'fa-file-circle-exclamation', color:'red', detalle:'Ej.: ejecutables, scripts y archivos potencialmente peligrosos.' },
  { id:'integridad', nombre:'Verificación de integridad SHA-256', desc:'Calcula y registra el hash SHA-256 para validar la integridad de los archivos.', estado:true, icon:'fa-fingerprint', color:'violet', detalle:'Permite comparar la huella registrada con verificaciones posteriores.' },
  { id:'aprobacion', nombre:'Aprobación para operaciones sensibles', desc:'Requiere autorización del jefe/custodio para movimientos y eliminaciones.', estado:true, icon:'fa-user-shield', color:'amber', detalle:'Se mantiene alineado con la cola de solicitudes existente.' },
  { id:'auditoria', nombre:'Auditoría de operaciones', desc:'Registra solicitudes y estados para mantener trazabilidad de la custodia.', estado:true, icon:'fa-shield-halved', color:'blue', detalle:'Usa la información disponible en auditoria_custodia.' },
  { id:'alertas', nombre:'Alertas de actividad crítica', desc:'Muestra eventos que requieren revisión dentro del panel de control.', estado:true, icon:'fa-bell', color:'orange', detalle:'La notificación externa depende de la integración del backend.' },
  { id:'sesion', nombre:'Control de sesión y roles', desc:'Limita las acciones administrativas según el rol de Supabase Auth.', estado:true, icon:'fa-key', color:'green', detalle:'Roles actuales: jefe y subordinado.' }
];

function getDlpRules(){
  try {
    const saved = JSON.parse(localStorage.getItem('datavault_dlp_rules') || 'null');
    return Array.isArray(saved) && saved.length ? saved : DLP_RULES_DEFAULT.map(x=>({...x}));
  } catch(e){ return DLP_RULES_DEFAULT.map(x=>({...x})); }
}
function saveDlpRules(rules){ localStorage.setItem('datavault_dlp_rules', JSON.stringify(rules)); }
function toggleDlpRule(id){
  const rules=getDlpRules(); const r=rules.find(x=>x.id===id); if(!r) return;
  r.estado=!r.estado; saveDlpRules(rules); renderDlpRules();
}
function renderDlpRules(){
  const el=document.getElementById('dlpRulesContainer'); if(!el) return;
  const rules=getDlpRules();
  el.innerHTML=rules.map(r=>`
    <div class="bg-white border border-slate-200 rounded-2xl p-5 hover:border-slate-300 transition">
      <div class="flex items-start justify-between gap-4">
        <div class="flex items-start gap-3 min-w-0">
          <div class="h-11 w-11 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center shrink-0"><i class="fa-solid ${r.icon}"></i></div>
          <div><h3 class="font-bold text-slate-800">${escapeHtml(r.nombre)}</h3><p class="text-sm text-slate-500 mt-1">${escapeHtml(r.desc)}</p></div>
        </div>
        <button onclick="toggleDlpRule('${r.id}')" class="relative w-11 h-6 rounded-full transition ${r.estado?'bg-[#0f2c42]':'bg-slate-300'}" aria-label="Cambiar regla">
          <span class="absolute top-1 h-4 w-4 rounded-full bg-white shadow transition ${r.estado?'left-6':'left-1'}"></span>
        </button>
      </div>
      <div class="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between gap-3">
        <p class="text-xs text-slate-400">${escapeHtml(r.detalle)}</p>
        <span class="text-[10px] uppercase tracking-wide font-bold px-2 py-1 rounded-full border ${r.estado?'bg-green-50 text-green-600 border-green-200':'bg-slate-50 text-slate-400 border-slate-200'}">${r.estado?'Activa':'Inactiva'}</span>
      </div>
    </div>`).join('');
  const active=rules.filter(r=>r.estado).length;
  const count=document.getElementById('dlpActiveCount'); if(count) count.textContent=active;
}


function setHeaderMeta(title, subtitle){
  const t=document.getElementById('headerTitle'); const s=document.getElementById('headerSubtitle');
  if(t)t.textContent=title; if(s)s.textContent=subtitle || 'DataVault DLP';
}

// Override navigation behavior while retaining all original operations.
const originalShowView = showView;
showView = function(name){
  originalShowView(name);
  const meta={
    inicio:['Inicio','Resumen general de seguridad y custodia'],
    gestor:['Archivos','Custodia, carga, movimiento y eliminación'],
    cola:['Solicitudes','Revisión y aprobación de operaciones'],
    auditoria:['Auditoría','Trazabilidad y verificación de integridad'],
    reglas:['Reglas DLP','Políticas de protección de información'],
    reportes:['Reportes','Indicadores y actividad del sistema'],
    usuarios:['Usuarios','Gestión de acceso y roles']
  };
  if(meta[name]) setHeaderMeta(meta[name][0],meta[name][1]);
  if(name==='reglas') renderDlpRules();
  if(name==='reportes') loadReports();
  if(name==='gestor') loadFilesView();
};

async function loadFilesView(){
  const body=document.getElementById('filesTableBody'); if(!body) return;
  body.innerHTML='<tr><td colspan="5" class="p-6 text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Cargando archivos...</td></tr>';
  const {data,error}=await supabaseClient.from('auditoria_custodia').select('*').order('fecha_solicitud',{ascending:false}).limit(200);
  if(error){ body.innerHTML='<tr><td colspan="5" class="p-6 text-center text-red-400">No se pudo cargar el inventario de archivos.</td></tr>'; return; }
  auditCache=Array.isArray(data)?data:[]; renderFilesTable(auditCache);
}
function renderFilesTable(rows){
  const body=document.getElementById('filesTableBody'); if(!body)return;
  const count=document.getElementById('fileCountLabel'); if(count) count.textContent=`${rows.length} archivo${rows.length===1?'':'s'} en custodia`;
  if(!rows.length){body.innerHTML='<tr><td colspan="5" class="p-8 text-center text-slate-400">No hay archivos registrados.</td></tr>';return;}
  const badgeFor2=estado=>estado==='APROBADO'?'status-approved':estado==='RECHAZADO'?'status-rejected':'status-pending';
  const iconFor=name=>{const ext=String(name||'').split('.').pop().toLowerCase(); if(ext==='pdf')return 'fa-file-pdf'; if(['dwg','dxf'].includes(ext))return 'fa-file-code'; if(['xlsx','xls','csv'].includes(ext))return 'fa-file-excel'; if(['doc','docx'].includes(ext))return 'fa-file-word'; return 'fa-file-lines';};
  body.innerHTML=rows.map(r=>`<tr>
    <td><div class="flex items-center gap-2"><div class="h-7 w-7 rounded-md bg-[#edf3f5] text-[#6c8698] flex items-center justify-center"><i class="fa-solid ${iconFor(r.nombre_archivo)} text-[10px]"></i></div><div><p class="font-semibold text-[#1f2b31] text-[9px]">${escapeHtml(r.nombre_archivo||'Sin nombre')}</p><p class="text-[7px] text-slate-400">${escapeHtml(r.usuario_solicitante||'—')}</p></div></div></td>
    <td class="text-[8px] text-slate-500">${escapeHtml(auditFolderName(r))}</td>
    <td><span class="integrity-ok"><i class="fa-solid fa-fingerprint"></i> Verificado</span></td>
    <td><span class="status-pill ${badgeFor2(r.estado)}">${escapeHtml(r.estado||'PENDIENTE')}</span></td>
    <td class="text-[8px] text-slate-400">${r.fecha_solicitud?new Date(r.fecha_solicitud).toLocaleString('es-PE',{dateStyle:'short',timeStyle:'short'}):'—'}</td>
  </tr>`).join('');
}
function filterFiles(){
  const q=(document.getElementById('fileSearch')?.value||'').toLowerCase().trim();
  const carpeta=document.getElementById('fileFolderFilter')?.value||'';
  renderFilesTable(auditCache.filter(r=>(!q || [r.nombre_archivo,r.usuario_solicitante,r.hash_sha256].some(v=>String(v||'').toLowerCase().includes(q))) && (!carpeta || auditFolderName(r)===carpeta)));
}
function isSharedFile(r){
  const flags=[r.compartido,r.compartida,r.is_shared,r.shared,r.es_compartido,r.compartido_con].some(v=>v===true || (typeof v==='string' && ['true','1','si','sí','shared','compartido','compartida'].includes(v.trim().toLowerCase())));
  const text=[r.visibilidad,r.tipo_acceso,r.acceso,r.estado_compartido].map(v=>String(v||'').toLowerCase()).join(' ');
  return flags || /compartid|shared/.test(text);
}
function isTrashFile(r){
  const flags=[r.en_papelera,r.papelera,r.is_deleted,r.deleted,r.eliminado,r.eliminada].some(v=>v===true || (typeof v==='string' && ['true','1','si','sí','yes','deleted','eliminado','eliminada','papelera','trash'].includes(v.trim().toLowerCase())));
  const text=[r.estado,r.estado_archivo,r.ubicacion,r.ubicacion_archivo].map(v=>String(v||'').toLowerCase()).join(' ');
  const dates=['fecha_eliminacion','eliminado_at','deleted_at','fecha_baja'].some(k=>r[k]);
  return flags || dates || /papelera|trash|eliminad|deleted/.test(text);
}
function selectFileFolder(folder){
  const select=document.getElementById('fileFolderFilter');
  if(select && !['__SHARED__','__TRASH__'].includes(folder)) select.value=folder;
  document.querySelectorAll('.tree-item,.tree-subitem').forEach(b=>b.classList.remove('active'));
  const btn=document.querySelector(`[data-folder="${folder}"]`); if(btn) btn.classList.add('active');
  const label=document.getElementById('currentFolderLabel'); const title=document.getElementById('filePanelTitle');
  let name=folder==='__SHARED__'?'Compartidos':folder==='__TRASH__'?'Papelera':(folder||'Todos los archivos');
  if(label) label.textContent=name; if(title) title.textContent=folder==='__SHARED__'?'Archivos compartidos':folder==='__TRASH__'?'Papelera':(folder||'Mis archivos');
  filterFiles(folder);
}
function filterFiles(specialFolder){
  const q=(document.getElementById('fileSearch')?.value||'').toLowerCase().trim();
  const selected=specialFolder || document.querySelector('.tree-item.active,.tree-subitem.active')?.dataset.folder || document.getElementById('fileFolderFilter')?.value || '';
  let rows=auditCache.filter(r=>(!q || [r.nombre_archivo,r.usuario_solicitante,r.hash_sha256].some(v=>String(v||'').toLowerCase().includes(q))));
  if(selected==='__SHARED__') rows=rows.filter(isSharedFile);
  else if(selected==='__TRASH__') rows=rows.filter(isTrashFile);
  else rows=rows.filter(r=>!selected || auditFolderName(r)===selected);
  renderFilesTable(rows);
}
async function exportSimpleReport(){
  const btn=document.getElementById('btnExportReport');
  const originalHtml=btn?.innerHTML||'';

  try{
    if(btn){
      btn.disabled=true;
      btn.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i>Generando Excel...';
    }

    const response=await fetch(`${API_URL}/reports/audit.xlsx`,{
      method:'GET',
      headers:await authHeaders(false)
    });

    if(!response.ok){
      let detail='No se pudo generar el reporte Excel.';
      try{
        const errorData=await response.json();
        detail=dvHttpErrorMessage(response,errorData,detail);
      }catch(_){}
      throw new Error(detail);
    }

    const blob=await response.blob();
    const disposition=response.headers.get('content-disposition')||'';
    const match=disposition.match(/filename="?([^";]+)"?/i);
    const filename=match?.[1]||'datavault_reporte_auditoria.xlsx';
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download=filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }catch(error){
    console.error('REPORT EXCEL ERROR',error);
    alert(error?.message||'No se pudo generar el reporte Excel.');
  }finally{
    if(btn){
      btn.disabled=false;
      btn.innerHTML=originalHtml;
    }
  }
}

async function loadReports(){
  const [{data:aud,error:e1},{data:sol,error:e2}]=await Promise.all([
    supabaseClient.from('auditoria_custodia').select('*').order('fecha_solicitud',{ascending:false}).limit(500),
    supabaseClient.from('solicitudes_lote').select('*').order('fecha_solicitud',{ascending:false}).limit(500)
  ]);
  if(e1||e2){ console.error('REPORTES ERROR',e1,e2); return; }
  auditCache=Array.isArray(aud)?aud:[]; colaCache=Array.isArray(sol)?sol:[];
  const totalA=auditCache.length, aprob=auditCache.filter(x=>x.estado==='APROBADO').length, rech=auditCache.filter(x=>x.estado==='RECHAZADO').length, hash=auditCache.filter(x=>x.hash_sha256).length;
  const pend=colaCache.filter(x=>x.estado==='PENDIENTE').length;
  document.getElementById('repTotalArchivos').textContent=totalA;
  document.getElementById('repAprobados').textContent=aprob;
  document.getElementById('repRechazados').textContent=rech;
  document.getElementById('repPendientes').textContent=pend;
  document.getElementById('repHash').textContent=hash;
  const types={SUBIDA_MASIVA:0,MOVIMIENTO_MASIVO:0,ELIMINACION_MASIVA:0}; colaCache.forEach(x=>{if(types[x.tipo_operacion]!==undefined)types[x.tipo_operacion]++;});
  const max=Math.max(1,...Object.values(types));
  document.getElementById('repBars').innerHTML=Object.entries(types).map(([k,v])=>`<div><div class="flex justify-between text-xs mb-1"><span class="text-slate-600">${k==='SUBIDA_MASIVA'?'Subidas':k==='MOVIMIENTO_MASIVO'?'Movimientos':'Eliminaciones'}</span><b class="text-slate-800">${v}</b></div><div class="h-2.5 bg-slate-100 rounded-full overflow-hidden"><div class="h-full bg-[#0f2c42] rounded-full" style="width:${Math.round(v/max*100)}%"></div></div></div>`).join('');
  const states=[['Aprobadas',aprob,'bg-green-500'],['Pendientes',auditCache.filter(x=>x.estado==='PENDIENTE').length,'bg-amber-500'],['Rechazadas',rech,'bg-red-500']];
  document.getElementById('repStates').innerHTML=states.map(([n,v,c])=>`<div class="flex items-center gap-3"><span class="h-3 w-3 rounded-full ${c}"></span><span class="text-sm text-slate-600 flex-1">${n}</span><b>${v}</b></div>`).join('');
  document.getElementById('repFolders').innerHTML=CARPETAS.map(c=>{const n=auditCache.filter(x=>auditFolderName(x)===c).length;return `<div><div class="flex justify-between text-xs mb-1"><span class="text-slate-600">${c}</span><span class="font-semibold">${n}</span></div><div class="h-2 bg-slate-100 rounded-full"><div class="h-full bg-blue-500 rounded-full" style="width:${totalA?Math.round(n/totalA*100):0}%"></div></div></div>`}).join('');
}

function resetDlpRules(){ if(confirm('¿Restaurar las reglas DLP a su configuración inicial?')){saveDlpRules(DLP_RULES_DEFAULT.map(x=>({...x})));renderDlpRules();} }

// Actualiza caches y nuevas vistas con el realtime existente.
const originalLoadAudit = loadAudit;
loadAudit = async function(){ await originalLoadAudit(); if(document.getElementById('view-gestor')?.classList.contains('active')) loadFilesView(); };




/* Existing application */

window.addEventListener('DOMContentLoaded',()=>{
  const f=document.getElementById('fileFolderFilter'); if(f) f.innerHTML='<option value="">Todas las carpetas</option>'+CARPETAS.map(c=>`<option value="${c}">${c}</option>`).join('');
  renderDlpRules();
});
const _oldSetSessionFromUser=setSessionFromUser;
setSessionFromUser=function(user){
  _oldSetSessionFromUser(user);
  const role=document.getElementById('solRoleMini'); if(role) role.textContent=currentRole==='jefe'?'Jefe':'Subordinado';
  document.getElementById('navUsuarios')?.classList.toggle('hidden',currentRole!=='jefe');
  document.getElementById('adminLabel')?.classList.toggle('hidden',currentRole!=='jefe');
};
const _oldLoadCola=loadCola;
loadCola=async function(){ await _oldLoadCola(); const pending=document.getElementById('kpiPendientes')?.textContent||'0'; const m=document.getElementById('solPendingMini');if(m)m.textContent=pending; };
const _oldUpdateKpis=updateKpis;
updateKpis=function(x){_oldUpdateKpis(x);const m=document.getElementById('solPendingMini');if(m&&x.pendientes!==undefined)m.textContent=x.pendientes;const rules=getDlpRules();const active=rules.filter(r=>r.estado).length;const hc=document.getElementById('homeDlpCount');if(hc)hc.textContent=active;const hp=document.getElementById('homeDlpPercent');if(hp)hp.textContent=Math.round(active/rules.length*100)+'%';};


/* Existing application */

/* ===== Capa visual final: replica del mockup y conserva las operaciones existentes ===== */
function statusPill(estado){
  if(estado==='APROBADO') return '<span class="status-pill status-approved">Completada</span>';
  if(estado==='RECHAZADO') return '<span class="status-pill status-rejected">Bloqueada</span>';
  return '<span class="status-pill status-pending">En cola</span>';
}
function operationLabel(tipo){return tipo==='SUBIDA_MASIVA'?'Archivo':tipo==='MOVIMIENTO_MASIVO'?'Carpeta':tipo==='ELIMINACION_MASIVA'?'Eliminación':(tipo||'Solicitud');}
function requestActionHtml(lote,canResolve,archivos){
  if(canResolve) return '<div class=\"flex gap-1\"><button onclick=\"resolverLote(\''+lote.id+'\',\'APROBADO\')\" class=\"text-[9px] text-emerald-600 font-bold px-2 py-1 rounded bg-emerald-50\">Aprobar</button><button onclick=\"resolverLote(\''+lote.id+'\',\'RECHAZADO\')\" class=\"text-[9px] text-red-500 font-bold px-2 py-1 rounded bg-red-50\">Rechazar</button></div>';
  return '<button class=\"text-slate-400 px-2\" title=\"Ver archivos\" onclick=\"this.closest(\'td\').querySelector(\'.request-files\').classList.toggle(\'hidden\')\"><i class=\"fa-solid fa-ellipsis\"></i></button><div class=\"request-files hidden absolute bg-white border rounded shadow p-2 text-[9px]\">'+archivos.map(a=>escapeHtml(a.nombre||a.nombre_archivo||'Archivo')).join('<br>')+'</div>';
}
function formatShortDate(v){return v?new Date(v).toLocaleString('es-PE',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—';}

/* Gráfico real de actividad: usa transferencias de auditoría y operaciones aprobadas. */
function dvActivityDayKey(value){
  if(!value) return '';
  const d=value instanceof Date?value:new Date(value);
  if(Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function renderRealFileActivityChart(auditRows,operationRows){
  const audit=Array.isArray(auditRows)?auditRows:[];
  const ops=Array.isArray(operationRows)?operationRows:[];
  const bars=document.getElementById('dashBars');
  if(!bars)return;

  // Últimos 7 días reales, usando la zona horaria local del navegador.
  const today=new Date();
  today.setHours(12,0,0,0);
  const days=[];
  for(let offset=6;offset>=0;offset--){
    const d=new Date(today);
    d.setDate(today.getDate()-offset);
    days.push({
      key:dvActivityDayKey(d),
      label:d.toLocaleDateString('es-PE',{day:'2-digit',month:'short'}).replace('.','')
    });
  }

  const dayIndex=new Map(days.map((d,i)=>[d.key,i]));
  const uploaded=Array(days.length).fill(0);
  const moved=Array(days.length).fill(0);
  const deleted=Array(days.length).fill(0);

  // SUBIDOS: cada archivo que realmente llegó a Drive. Para registros antiguos
  // sin fecha_transferencia se usa la fecha de solicitud, pero solo si fue aprobado.
  audit.forEach(row=>{
    if(String(row?.estado||'').toUpperCase()==='APROBADO'){
      const uploadDate=row?.fecha_transferencia||row?.fecha_solicitud;
      const idx=dayIndex.get(dvActivityDayKey(uploadDate));
      if(idx!==undefined)uploaded[idx]++;
    }

    // ELIMINADOS: fecha_eliminacion se escribe cuando Drive envía el elemento a papelera.
    const deleteIdx=dayIndex.get(dvActivityDayKey(row?.fecha_eliminacion));
    if(deleteIdx!==undefined)deleted[deleteIdx]++;
  });

  // MOVIDOS: solo solicitudes MOVER realmente APROBADAS/ejecutadas.
  // Si fue una carpeta, contamos los archivos del lote afectados por ese movimiento.
  ops.forEach(op=>{
    if(String(op?.estado||'').toUpperCase()!=='APROBADO')return;
    if(String(op?.tipo_operacion||'').toUpperCase()!=='MOVER')return;
    const idx=dayIndex.get(dvActivityDayKey(op?.fecha_resolucion||op?.fecha_solicitud));
    if(idx===undefined)return;

    let affected=1;
    if(String(op?.objeto_tipo||'').toUpperCase()==='CARPETA' && op?.lote_id){
      const loteId=String(op.lote_id);
      const count=audit.filter(r=>String(r?.lote_id||'')===loteId).length;
      if(count>0)affected=count;
    }
    moved[idx]+=affected;
  });

  const width=680,height=190,pad={l:38,r:12,t:12,b:30};
  const rawMax=Math.max(0,...uploaded,...moved,...deleted);
  const maxY=rawMax<=4?4:rawMax<=10?10:Math.ceil(rawMax/5)*5;
  const sx=i=>pad.l+i*((width-pad.l-pad.r)/(days.length-1));
  const sy=v=>pad.t+(height-pad.t-pad.b)*(1-v/maxY);
  const path=arr=>arr.map((v,i)=>`${i?'L':'M'} ${sx(i).toFixed(1)} ${sy(v).toFixed(1)}`).join(' ');
  const dots=(arr,cls,serie)=>arr.map((v,i)=>`<circle cx="${sx(i).toFixed(1)}" cy="${sy(v).toFixed(1)}" r="3.2" class="${cls}"><title>${serie} · ${days[i].label}: ${v}</title></circle>`).join('');
  const grid=[0,.25,.5,.75,1].map(t=>{
    const y=pad.t+(height-pad.t-pad.b)*t;
    const val=Math.round(maxY*(1-t));
    return `<line x1="${pad.l}" y1="${y}" x2="${width-pad.r}" y2="${y}" class="chart-grid"/><text x="${pad.l-8}" y="${y+3}" text-anchor="end" class="chart-axis">${val}</text>`;
  }).join('');
  const xlabels=days.map((d,i)=>`<text x="${sx(i)}" y="${height-8}" text-anchor="middle" class="chart-axis">${d.label}</text>`).join('');

  bars.innerHTML=`<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="activity-chart" aria-label="Actividad real de archivos de los últimos 7 días">${grid}<path d="${path(uploaded)}" class="chart-line uploaded-line"/><path d="${path(moved)}" class="chart-line moved-line"/><path d="${path(deleted)}" class="chart-line deleted-line"/>${dots(uploaded,'uploaded-dot','Subidos')}${dots(moved,'moved-dot','Movidos')}${dots(deleted,'deleted-dot','Eliminados')}${xlabels}</svg>`;
}

function updateDashboardVisuals(){
  const sol = Array.isArray(colaCache) ? colaCache : [];
  const aud = Array.isArray(auditCache) ? auditCache : [];
  const today = new Date();
  const sameDay = (v) => {
    if(!v) return false;
    const d = new Date(v);
    return d.getFullYear()===today.getFullYear() && d.getMonth()===today.getMonth() && d.getDate()===today.getDate();
  };

  const pending = sol.filter(x=>x.estado==='PENDIENTE').length;
  const eventsToday = aud.filter(x=>sameDay(x.fecha_solicitud)).length;
  const users = new Set([...aud.map(x=>x.usuario_solicitante), ...sol.map(x=>x.usuario_solicitante)].filter(Boolean)).size;
  const protectedFiles = aud.length;

  const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v;};
  set('dashTotalSolicitudes',protectedFiles);
  set('dashEnCola',pending);
  set('dashCompletadas',eventsToday);
  set('dashBloqueadas',users);
  set('dashDonutTotal',aud.length || sol.length);

  // Gráfico con datos reales. En esta capa legacy, sol puede contener una cola parcial;
  // el dashboard V3 vuelve a dibujarlo después con el historial completo de operaciones.
  renderRealFileActivityChart(aud,sol);

  const approved=sol.filter(x=>x.estado==='APROBADO').length;
  const rejected=sol.filter(x=>x.estado==='RECHAZADO').length;
  const totalEvents=Math.max(1,approved+pending+rejected);
  const apPct=Math.round(approved/totalEvents*100), pePct=Math.round(pending/totalEvents*100);
  const donut=document.getElementById('dashDonut');
  if(donut) donut.style.background=`conic-gradient(#1677d2 0 ${apPct}%,#55a9e5 ${apPct}% ${apPct+pePct}%,#d9e7f2 ${apPct+pePct}% 100%)`;
  const legend=document.getElementById('dashDonutLegend');
  if(legend) legend.innerHTML=[
    ['Bloqueos',rejected,'#173f62'],
    ['Alertas',pending,'#3b86bb'],
    ['Permisos',approved,'#8caac1'],
    ['Otros',Math.max(0,aud.length-(rejected+pending+approved)),'#b9cbd8']
  ].map(([n,v,c])=>`<div class="flex items-center gap-2"><span class="legend-square" style="background:${c}"></span><span class="flex-1 text-slate-600">${n}</span><b>${totalEvents?Math.round(v/Math.max(1,aud.length||totalEvents)*100):0}%</b></div>`).join('');

  const d=new Date();
  set('dashDate',d.toLocaleDateString('es-PE',{day:'2-digit',month:'long',year:'numeric'}));
  set('dashWelcome',currentDisplayName||'Administrador');
  const rules=getDlpRules(), active=rules.filter(r=>r.estado).length;
  set('homeDlpCount',active);
  set('homeDlpPercent',(rules.length?Math.round(active/rules.length*100):0)+'%');
}

async function loadAudit(){
  const {data,error}=await supabaseClient.from('auditoria_custodia').select('*').order('fecha_solicitud',{ascending:false}).limit(50);
  if(error){console.error('Error al consultar Supabase:',error);return;}
  auditCache=Array.isArray(data)?data:[];
  const badgeFor=(estado)=>estado==='APROBADO'?'status-approved':estado==='RECHAZADO'?'status-rejected':'status-pending';
  const auditBody=document.getElementById('auditTableBody');
  if(auditBody) auditBody.innerHTML=auditCache.length?auditCache.map(row=>`<tr><td>${escapeHtml(row.nombre_archivo||'Sin nombre')}</td><td>${escapeHtml(row.usuario_solicitante||'—')}</td><td>${escapeHtml(auditFolderName(row))}</td><td class="font-mono text-[9px]" title="${escapeHtml(row.hash_sha256||'')}">${row.hash_sha256?escapeHtml(row.hash_sha256.slice(0,18))+'…':'N/A'}</td><td>${statusPill(row.estado)}</td></tr>`).join(''):'<tr><td colspan="5" class="p-6 text-center text-slate-400">No existen registros.</td></tr>';
  const inicioBody=document.getElementById('inicioTableBody');
  if(inicioBody) inicioBody.innerHTML=auditCache.slice(0,5).map(row=>`<tr><td>${formatShortDate(row.fecha_solicitud)}</td><td>${escapeHtml(row.usuario_solicitante||'—')}</td><td>${escapeHtml(operationLabel(row.tipo_operacion||row.accion||'Archivo'))}</td><td>${statusPill(row.estado)}</td></tr>`).join('') || '<tr><td colspan="4" class="p-6 text-center text-slate-400">No existen registros.</td></tr>';
  updateKpis({archivos:auditCache.length,hash:auditCache.filter(r=>r.hash_sha256).length});
  updateDashboardVisuals();
  if(document.getElementById('view-gestor')?.classList.contains('active')) renderFilesTable(auditCache);
}

async function loadCola(){
  const {data,error}=await supabaseClient.from('solicitudes_lote').select('*').order('fecha_solicitud',{ascending:false}).limit(50);
  if(error){console.error('Error cargando cola:',error);return;}
  colaCache=Array.isArray(data)?data:[];
  const pending=colaCache.filter(x=>x.estado==='PENDIENTE').length;updateKpis({pendientes:pending});
  const role=document.getElementById('solRoleMini');if(role)role.textContent=currentRole==='jefe'?'Jefe':'Subordinado';
  const tbody=document.getElementById('colaContainer');
  if(tbody){tbody.innerHTML=colaCache.length?colaCache.map((lote,i)=>{
    const archivos=Array.isArray(lote.archivos)?lote.archivos:(typeof lote.archivos==='string'?JSON.parse(lote.archivos||'[]'):[]);
    const canResolve=currentRole==='jefe'&&lote.estado==='PENDIENTE';
    return `<tr><td>#${String(lote.id??i+1).slice(-4)}</td><td><span class="font-semibold text-slate-700">${escapeHtml(operationLabel(lote.tipo_operacion))}</span><div class="text-[9px] text-slate-400">${archivos.length} archivo(s)</div></td><td>${escapeHtml(lote.carpeta_origen||'—')}</td><td>${escapeHtml(lote.carpeta_destino||'—')}</td><td>${escapeHtml(lote.usuario_solicitante||'—')}</td><td>${formatShortDate(lote.fecha_solicitud)}</td><td>${statusPill(lote.estado)}</td><td>${requestActionHtml(lote,canResolve,archivos)}</td></tr>`;
  }).join(''):'<tr><td colspan="8" class="p-8 text-center text-slate-400">No hay solicitudes registradas.</td></tr>';
  }
  const sum=document.getElementById('solSummary');if(sum)sum.textContent=`Mostrando ${colaCache.length} solicitud(es)`;
  const mini=document.getElementById('solPendingMini');if(mini)mini.textContent=pending;
  updateDashboardVisuals();
}

function filterSolicitudesUI(){
  const q=(document.getElementById('solSearch')?.value||'').toLowerCase().trim();const st=document.getElementById('solStateFilter')?.value||'';
  const rows=(colaCache||[]).filter(x=>{const text=[x.id,x.tipo_operacion,x.carpeta_origen,x.carpeta_destino,x.usuario_solicitante].join(' ').toLowerCase();return(!q||text.includes(q))&&(!st||x.estado===st)});
  const tbody=document.getElementById('colaContainer');if(!tbody)return;
  tbody.innerHTML=rows.length?rows.map((lote,i)=>{const archivos=Array.isArray(lote.archivos)?lote.archivos:[];const can=currentRole==='jefe'&&lote.estado==='PENDIENTE';return `<tr><td>#${String(lote.id??i+1).slice(-4)}</td><td>${escapeHtml(operationLabel(lote.tipo_operacion))}<div class="text-[9px] text-slate-400">${archivos.length} archivo(s)</div></td><td>${escapeHtml(lote.carpeta_origen||'—')}</td><td>${escapeHtml(lote.carpeta_destino||'—')}</td><td>${escapeHtml(lote.usuario_solicitante||'—')}</td><td>${formatShortDate(lote.fecha_solicitud)}</td><td>${statusPill(lote.estado)}</td><td>${can?requestActionHtml(lote,true,archivos):'—'}</td></tr>`}).join(''):'<tr><td colspan="8" class="p-8 text-center text-slate-400">No se encontraron solicitudes.</td></tr>';
}

function renderDlpRules(){
  const el=document.getElementById('dlpRulesContainer');if(!el)return;const rules=getDlpRules();
  el.innerHTML=`<div class="overflow-x-auto"><table class="rule-table"><thead><tr><th>Nombre</th><th>Tipo</th><th>Descripción</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${rules.map(r=>`<tr><td class="font-semibold text-slate-700">${escapeHtml(r.nombre)}</td><td>Contenido</td><td>${escapeHtml(r.desc)}</td><td><span class="status-pill ${r.estado?'status-on':'status-off'}">${r.estado?'Activa':'En pausa'}</span></td><td><button onclick="toggleDlpRule('${r.id}')" class="rule-switch ${r.estado?'on':''}"><span></span></button></td></tr>`).join('')}</tbody></table></div>`;
  const active=rules.filter(r=>r.estado).length;const c=document.getElementById('dlpActiveCount');if(c)c.textContent=active;updateDashboardVisuals();
}

const _visualShowView=showView;
showView=function(name){_visualShowView(name);if(name==='inicio')updateDashboardVisuals();if(name==='reglas')renderDlpRules();if(name==='reportes')loadReports();};

window.addEventListener('DOMContentLoaded',()=>{renderDlpRules();updateDashboardVisuals();});


/* Existing application */

/* =======================================================
   CONTROL VISUAL DE PERMISOS POR ROL
   Jefe: administración completa.
   Subordinado: consulta + creación/seguimiento de solicitudes.
   La validación definitiva deberá repetirse en Supabase/backend.
======================================================= */
(function(){
  const ROLE_JEFE = 'jefe';
  const ROLE_SUBORDINADO = 'subordinado';

  function isJefe(){ return String(currentRole || '').toLowerCase() === ROLE_JEFE; }

  function applyRoleUI(){
    const jefe = isJefe();

    // Usuarios: exclusivo para Jefe.
    ['navUsuarios','topNavUsuarios'].forEach(id=>{
      const el=document.getElementById(id);
      if(el) el.classList.toggle('hidden', !jefe);
    });
    const adminLabel=document.getElementById('adminLabel');
    if(adminLabel) adminLabel.classList.toggle('hidden', !jefe);

    // Orden del menú superior para el Jefe: flujo lógico de navegación.
    const topbarNav = document.querySelector('#topbar .topbar-nav');
    if(topbarNav){
      const adminOrder = ['inicio','gestor','cola','operaciones','reglas','reportes','auditoria','usuarios'];
      adminOrder.forEach((navName, index)=>{
        const btn = topbarNav.querySelector(`[data-nav="${navName}"]`);
        if(!btn) return;
        if(jefe){
          topbarNav.appendChild(btn);
          btn.style.order = String(index + 1);
        }else{
          btn.style.removeProperty('order');
        }
      });
    }

    // Reglas DLP: visibles para ambos, pero solo el Jefe puede modificar.
    const reset=document.getElementById('btnResetDlpRules');
    if(reset){
      reset.classList.toggle('hidden', !jefe);
      reset.disabled=!jefe;
    }

    // Reportes: ambos pueden consultar; solo Jefe puede exportar.
    const exportBtn=document.getElementById('btnExportReport');
    if(exportBtn){
      exportBtn.classList.toggle('hidden', !jefe);
      exportBtn.disabled=!jefe;
    }

    // Etiquetas informativas de permisos.
    document.querySelectorAll('[data-jefe-only]').forEach(el=>{
      el.classList.toggle('hidden', !jefe);
    });
    document.querySelectorAll('[data-subordinado-only]').forEach(el=>{
      el.classList.toggle('hidden', jefe);
    });

    // Re-renderiza las reglas para que los interruptores sean realmente de solo lectura.
    if(typeof renderDlpRules === 'function' && document.getElementById('dlpRulesContainer')){
      renderDlpRules();
    }
  }

  // Normaliza el rol y aplica la interfaz cada vez que cambia la sesión.
  const roleSetSessionBase = setSessionFromUser;
  setSessionFromUser = function(user){
    roleSetSessionBase(user);
    currentRole = String(user?.app_metadata?.rol || ROLE_SUBORDINADO).toLowerCase() === ROLE_JEFE
      ? ROLE_JEFE : ROLE_SUBORDINADO;
    applyRoleUI();
  };

  // Impide entrar a módulos administrativos exclusivos por llamada directa a showView().
  const showViewBase = showView;
  showView = function(name){
    if(name === 'usuarios' && !isJefe()){
      name = 'inicio';
    }
    showViewBase(name);
    applyRoleUI();
  };

  // Protección del lado cliente para acciones administrativas DLP.
  const toggleDlpRuleBase = toggleDlpRule;
  toggleDlpRule = function(id){
    if(!isJefe()){
      console.warn('Acción DLP bloqueada: requiere rol jefe.');
      return;
    }
    return toggleDlpRuleBase(id);
  };

  const resetDlpRulesBase = resetDlpRules;
  resetDlpRules = function(){
    if(!isJefe()){
      console.warn('Restauración DLP bloqueada: requiere rol jefe.');
      return;
    }
    return resetDlpRulesBase();
  };

  const exportSimpleReportBase = exportSimpleReport;
  exportSimpleReport = function(){
    if(!isJefe()){
      console.warn('Exportación bloqueada: requiere rol jefe.');
      return;
    }
    return exportSimpleReportBase();
  };

  // Renderizado de Reglas DLP: consulta para ambos roles, edición solo para Jefe.
  renderDlpRules = function(){
    const el=document.getElementById('dlpRulesContainer');
    if(!el) return;
    const rules=getDlpRules();
    const jefe=isJefe();

    el.innerHTML=`<div class="overflow-x-auto">
      <table class="rule-table">
        <thead><tr><th>Nombre</th><th>Tipo</th><th>Descripción</th><th>Estado</th><th>${jefe?'Acciones':'Permiso'}</th></tr></thead>
        <tbody>
          ${rules.map(r=>`<tr>
            <td class="font-semibold text-slate-700">${escapeHtml(r.nombre)}</td>
            <td>Contenido</td>
            <td>${escapeHtml(r.desc)}</td>
            <td><span class="status-pill ${r.estado?'status-on':'status-off'}">${r.estado?'Activa':'En pausa'}</span></td>
            <td>
              ${jefe
                ? `<button onclick="toggleDlpRule('${r.id}')" class="rule-switch ${r.estado?'on':''}" aria-label="Cambiar regla"><span></span></button>`
                : `<span class="text-xs font-semibold text-slate-400"><i class="fa-solid fa-lock mr-1"></i>Solo lectura</span>`}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

    const active=rules.filter(r=>r.estado).length;
    const count=document.getElementById('dlpActiveCount');
    if(count) count.textContent=active;
    updateDashboardVisuals();
  };

  // No confiar solo en que el botón esté oculto.
  document.addEventListener('DOMContentLoaded', applyRoleUI);
  window.addEventListener('load', applyRoleUI);
})();


/* datavault-icon-fallback-script */

(function(){
  const P={
    home:'<path d="M3 10.8 12 3l9 7.8"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/>',
    'folder-open':'<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5V10"/><path d="M3 8h18l-2.2 9.1A2.5 2.5 0 0 1 16.4 19H5.6a2.5 2.5 0 0 1-2.4-1.9L2 11.3A2.7 2.7 0 0 1 3 8Z"/>',
    folder:'<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v7A2.5 2.5 0 0 1 18.5 18h-13A2.5 2.5 0 0 1 3 15.5Z"/>',
    shield:'<path d="M12 3 20 6v5.5c0 4.8-3.1 8.2-8 9.5-4.9-1.3-8-4.7-8-9.5V6Z"/><path d="m9 12 2 2 4-4"/>',
    'shield-halved':'<path d="M12 3 20 6v5.5c0 4.8-3.1 8.2-8 9.5V3Z"/><path d="M12 3 4 6v5.5c0 4.8 3.1 8.2 8 9.5"/><path d="m9.5 12 1.5 1.5 3-3"/>',
    'shield-virus':'<path d="M12 3 20 6v5.5c0 4.8-3.1 8.2-8 9.5-4.9-1.3-8-4.7-8-9.5V6Z"/><circle cx="12" cy="12" r="3"/><path d="M12 7v2M12 15v2M7 12h2M15 12h2M8.5 8.5l1.4 1.4M14.1 14.1l1.4 1.4M15.5 8.5l-1.4 1.4M9.9 14.1l-1.4 1.4"/>',
    'chart-column':'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    'clock-rotate-left':'<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/>',
    gear:'<path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18"/><circle cx="12" cy="12" r="3.5"/><circle cx="12" cy="12" r="8"/>',
    users:'<path d="M16 20v-1.5a4.5 4.5 0 0 0-4.5-4.5h-3A4.5 4.5 0 0 0 4 18.5V20"/><circle cx="10" cy="7" r="3"/><path d="M16 5.5a3 3 0 0 1 0 5.8M17 14.2a4.5 4.5 0 0 1 3 4.3V20"/>',
    'list-check':'<path d="M4 6h1M4 12h1M4 18h1M9 6h11M9 12h5M9 18h11"/><path d="m16 11 2 2 4-4"/>',
    bell:'<path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
    user:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    lock:'<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
    'arrow-right':'<path d="M5 12h14M13 6l6 6-6 6"/>',
    'arrow-up':'<path d="M12 19V5M6 11l6-6 6 6"/>',
    upload:'<path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 15v4h14v-4"/>',
    'arrow-up-from-bracket':'<path d="M12 16V3M7 8l5-5 5 5"/><path d="M5 14v5h14v-5"/>',
    'cloud-arrow-up':'<path d="M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19 11a3.5 3.5 0 0 1 0 7H7Z"/><path d="M12 15V9M9.5 11.5 12 9l2.5 2.5"/>',
    trash:'<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    'trash-can':'<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    'magnifying-glass':'<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    file:'<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    'file-lines':'<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 12h6M9 16h6"/>',
    'file-word':'<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13l1 4 2-4 2 4 1-4"/>',
    'file-pdf':'<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 17h6M9 13c3-1 5 0 5 1s-2 2-5 2"/>',
    'file-code':'<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M10 12l-2 2 2 2M14 12l2 2-2 2"/>',
    'file-excel':'<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 12l6 6M15 12l-6 6"/>',
    fingerprint:'<path d="M12 11a3 3 0 0 1 3 3v3M12 7a7 7 0 0 1 7 7v3M12 3a11 11 0 0 1 11 11v2M8 20c0-2 1-4 1-6a3 3 0 0 1 6 0v4M5 20c0-3 2-5 2-8a5 5 0 0 1 10 0"/>',
    'circle-check':'<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    'circle-xmark':'<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
    xmark:'<path d="m7 7 10 10M17 7 7 17"/>',
    'circle-info':'<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    'file-export':'<path d="M6 3h8l4 4v6M14 3v5h5M10 18H6v3h8"/><path d="M13 16h8M18 13l3 3-3 3"/>',
    'paper-plane':'<path d="m21 3-7 18-4-8-7-4Z"/><path d="m21 3-11 10"/>',
    key:'<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l2 2M18 5l2 2"/>',
    'user-shield':'<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M17 12l4 1.5v3c0 2.3-1.5 3.9-4 4.5-2.5-.6-4-2.2-4-4.5v-3Z"/>',
    'user-lock':'<circle cx="8" cy="8" r="3"/><path d="M2 20a6 6 0 0 1 12 0M17 14v-2a2 2 0 0 1 4 0v2M16 14h6v5h-6z"/>',
    'right-from-bracket':'<path d="M10 5H5v14h5M14 8l4 4-4 4M9 12h9"/>',
    'rotate':'<path d="M4 8a8 8 0 0 1 14-2l2 2"/><path d="M20 4v4h-4M20 16a8 8 0 0 1-14 2l-2-2"/><path d="M4 20v-4h4"/>',
    'arrows-up-down-left-right':'<path d="M8 3v18M3 8l5-5 5 5M16 21V3M11 16l5 5 5-5M3 12h18"/>',
    'arrows-turn-right':'<path d="M4 6h8a5 5 0 0 1 5 5v7M13 15l4 4 4-4"/>',
    'ellipsis':'<circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
    'chevron-down':'<path d="m6 9 6 6 6-6"/>',
    'chevron-right':'<path d="m9 6 6 6-6 6"/>',
    'check-double':'<path d="m2 12 4 4 7-7M9 12l3 3 8-8"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    'file-circle-exclamation':'<circle cx="12" cy="12" r="9"/><path d="M12 7v5M12 15h.01"/>',
    spinner:'<path d="M12 3a9 9 0 1 0 9 9"/>',
    circle:'<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
    'file-upload':'<path d="M6 3h8l4 4v14H6zM14 3v5h5"/><path d="M12 17v-6M9.5 13.5 12 11l2.5 2.5"/>',
    'download':'<path d="M12 4v11M8 11l4 4 4-4M5 20h14"/>'
  };
  Object.assign(P, {
    bars:'<path d="M4 6h16M4 12h16M4 18h16"/>',
    eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    'eye-slash':'<path d="m3 3 18 18M3 12s4-7 9-7 9 7 9 7M3 12s4 7 9 7c3 0 5-2 6-3"/>',
    'user-plus':'<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M18 8v6M15 11h6"/>',
    'folder-tree':'<path d="M3 3h6l2 2h10v5H3zM6 10v9h6M12 16h9v6h-9z"/>',
    'arrow-right-arrow-left':'<path d="M3 7h17l-4-4M21 17H4l4 4"/>',
    'triangle-exclamation':'<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
    'box-open':'<path d="m3 7 9 4 9-4M3 7l4-4 5 3 5-3 4 4v11l-9 4-9-4V7ZM12 11v11"/>'
  });
  const aliases={
    'fa-home':'home','fa-house':'home','fa-folder-open':'folder-open','fa-folder':'folder','fa-shield-halved':'shield-halved','fa-shield':'shield','fa-shield-virus':'shield-virus',
    'fa-chart-column':'chart-column','fa-clock-rotate-left':'clock-rotate-left','fa-gear':'gear','fa-users':'users','fa-list-check':'list-check','fa-bell':'bell','fa-user':'user','fa-lock':'lock',
    'fa-arrow-right':'arrow-right','fa-arrow-up':'arrow-up','fa-upload':'upload','fa-arrow-up-from-bracket':'arrow-up-from-bracket','fa-cloud-arrow-up':'cloud-arrow-up','fa-trash':'trash','fa-trash-can':'trash-can',
    'fa-search':'search','fa-magnifying-glass':'magnifying-glass','fa-file':'file','fa-file-lines':'file-lines','fa-file-word':'file-word','fa-file-pdf':'file-pdf','fa-file-code':'file-code','fa-file-excel':'file-excel',
    'fa-fingerprint':'fingerprint','fa-circle-check':'circle-check','fa-check':'check','fa-circle-xmark':'circle-xmark','fa-xmark':'xmark','fa-circle-info':'circle-info','fa-clock':'clock','fa-file-export':'file-export',
    'fa-paper-plane':'paper-plane','fa-key':'key','fa-user-shield':'user-shield','fa-user-lock':'user-lock','fa-right-from-bracket':'right-from-bracket','fa-rotate':'rotate','fa-arrows-up-down-left-right':'arrows-up-down-left-right',
    'fa-arrows-turn-right':'arrows-turn-right','fa-ellipsis':'ellipsis','fa-chevron-down':'chevron-down','fa-chevron-right':'chevron-right','fa-check-double':'check-double','fa-plus':'plus',
    'fa-file-circle-exclamation':'file-circle-exclamation','fa-spinner':'spinner','fa-circle':'circle','fa-file-upload':'file-upload','fa-download':'download'
  };
  Object.assign(aliases, {
    'fa-bars':'bars','fa-eye':'eye','fa-eye-slash':'eye-slash','fa-user-plus':'user-plus',
    'fa-user-group':'users','fa-folder-tree':'folder-tree','fa-file-arrow-up':'file-upload',
    'fa-folder-arrow-up':'upload','fa-folder-circle-exclamation':'folder',
    'fa-arrow-right-arrow-left':'arrow-right-arrow-left','fa-ban':'circle-xmark',
    'fa-triangle-exclamation':'triangle-exclamation','fa-circle-exclamation':'circle-info',
    'fa-box-open':'box-open','fa-hand-pointer':'arrow-up','fa-telegram':'paper-plane'
  });
  function makeIcon(el){
    if(!el || el.dataset.dvIconDone) return;
    const cls=[...el.classList];
    let key=null;
    for(const c of cls){ if(aliases[c]){key=aliases[c];break;} }
    if(!key || !P[key]) return;
    const span=document.createElement('span');
    span.className=cls.filter(c=>!c.startsWith('fa-')).concat('dv-svg-icon').join(' ');
    if(cls.includes('fa-spin')) span.classList.add('dv-spin');
    span.setAttribute('aria-hidden','true');
    span.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">'+P[key]+'</svg>';
    el.replaceWith(span);
  }
  function scan(root=document){
    root.querySelectorAll && root.querySelectorAll('i[class*="fa-"]').forEach(makeIcon);
  }
  function init(){
    /* Si Font Awesome está disponible, se conserva exactamente. Si no, se usan SVG locales. */
    // Local SVGs keep the shared interface consistent without a font download.
    scan();
    const observer=new MutationObserver(muts=>muts.forEach(m=>m.addedNodes.forEach(n=>{
      if(n.nodeType===1){if(n.matches && n.matches('i[class*="fa-"]')) makeIcon(n); scan(n);}
    })));
    observer.observe(document.body,{childList:true,subtree:true});
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();


/* datavault-current-backend-compat */

/* =========================================================
   COMPATIBILIDAD CON EL BACKEND ACTUAL DE DATAVAULT
   - /upload-batch
   - Supabase Auth + Authorization Bearer
   - auditoria_custodia (lote_id + ruta_relativa)
   - Carpetas agrupadas / subcarpetas desplegables
   - Telegram resuelve aprobación/rechazo; web es lectura/carga
   ========================================================= */

let dvSelectedEntries = [];
let dvSelectionMode = null; // files | folder
let dvSelectedFolderName = '';
let dvUploadController = null;
let dvUploadInProgress = false;
let dvExplorerFolder = '';
let dvUploadDestinationFolders = [];
let dvUploadDestinationSelectedId = '';
let dvUploadDestinationSelectedPath = '';
let dvUploadDestinationLoading = false;

function dvEntryKey(entry){
  return [entry.relativePath, entry.file.size, entry.file.lastModified].join('|');
}

function dvResetUploadDestination(){
  dvUploadDestinationSelectedId='';
  dvUploadDestinationSelectedPath='';
  const search=document.getElementById('dvUploadDestinationSearch');
  if(search)search.value='';
  const selection=document.getElementById('dvUploadDestinationSelection');
  if(selection)selection.innerHTML='Selecciona una carpeta. Para dejar archivos sueltos, selecciona explícitamente <b>DRIVE PROYECTO</b>.';
  dvRenderUploadDestinationFolders();
  dvRefreshUploadButtonState();
}

function dvRefreshUploadButtonState(){
  const btn=document.getElementById('uploadBatchBtn');
  if(btn)btn.disabled=!!dvUploadInProgress || !dvSelectedEntries.length || !dvUploadDestinationSelectedId;
}

async function dvEnsureUploadDestinationFolders(force=false){
  const panel=document.getElementById('dvUploadDestinationPanel');
  if(!dvSelectedEntries.length){if(panel)panel.classList.add('hidden');return;}
  if(panel)panel.classList.remove('hidden');
  if(dvUploadDestinationFolders.length && !force){dvRenderUploadDestinationFolders();return;}
  if(dvUploadDestinationLoading)return;
  dvUploadDestinationLoading=true;
  const list=document.getElementById('dvUploadDestinationList');
  if(list)list.innerHTML='<div class="p-4 text-center text-xs text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Cargando carpetas de Google Drive...</div>';
  try{
    const res=await fetch(`${API_URL}/drive-folders`,{headers:await authHeaders(false)});
    const data=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(dvHttpErrorMessage(res,data));
    dvUploadDestinationFolders=(Array.isArray(data.folders)?data.folders:[]).slice().sort((a,b)=>{
      if(Boolean(a?.root)!==Boolean(b?.root))return a?.root?-1:1;
      return String(a?.path||a?.name||'').localeCompare(String(b?.path||b?.name||''),'es',{numeric:true,sensitivity:'base'});
    });
    dvRenderUploadDestinationFolders();
  }catch(err){
    if(list)list.innerHTML=`<div class="p-4 text-center text-xs text-red-500"><i class="fa-solid fa-circle-exclamation mr-2"></i>${escapeHtml(err?.message||'No se pudieron cargar las carpetas.')}</div>`;
  }finally{dvUploadDestinationLoading=false;}
}

function dvRenderUploadDestinationFolders(){
  const list=document.getElementById('dvUploadDestinationList');
  if(!list)return;
  if(!dvUploadDestinationFolders.length){
    if(!dvUploadDestinationLoading)list.innerHTML='<div class="p-4 text-center text-xs text-slate-400">Selecciona archivos para cargar los destinos disponibles.</div>';
    return;
  }
  const q=String(document.getElementById('dvUploadDestinationSearch')?.value||'').trim().toLowerCase();
  const folders=dvUploadDestinationFolders.filter(f=>!q||String(`${f?.name||''} ${f?.path||''}`).toLowerCase().includes(q));
  if(!folders.length){list.innerHTML='<div class="p-4 text-center text-xs text-slate-400"><i class="fa-solid fa-folder-open mr-2"></i>No se encontraron carpetas.</div>';return;}
  list.innerHTML=folders.map(f=>{
    const id=String(f?.id||'');
    const selected=id===String(dvUploadDestinationSelectedId||'');
    const depth=Math.min(Number(f?.depth||0),8);
    const root=!!f?.root || Number(f?.depth||0)===0;
    const path=String(f?.path||f?.name||'Carpeta');
    const note=root
      ? (dvSelectionMode==='folder'?'La carpeta seleccionada se creará aquí':'Raíz: los archivos quedarán sueltos aquí')
      : path;
    return `<button type="button" class="dv-folder-option${selected?' selected':''}" data-dv-upload-folder-id="${escapeHtml(id)}" style="padding-left:${9+(depth*15)}px" title="${escapeHtml(path)}">
      <i class="fa-solid ${root?'fa-hard-drive':'fa-folder'} text-amber-500"></i>
      <span class="folder-main"><span class="folder-name">${escapeHtml(f?.name||'Carpeta')}</span><span class="folder-path">${escapeHtml(note)}</span></span>
      ${selected?'<span class="folder-note"><i class="fa-solid fa-check"></i> Seleccionada</span>':''}
    </button>`;
  }).join('');
  list.querySelectorAll('[data-dv-upload-folder-id]').forEach(btn=>btn.addEventListener('click',()=>dvSelectUploadDestination(btn.dataset.dvUploadFolderId)));
}

function dvFilterUploadDestinations(){dvRenderUploadDestinationFolders();}

function dvSelectUploadDestination(folderId){
  const folder=(dvUploadDestinationFolders||[]).find(f=>String(f?.id||'')===String(folderId||''));
  if(!folder)return;
  dvUploadDestinationSelectedId=String(folder.id||'');
  dvUploadDestinationSelectedPath=String(folder.path||folder.name||'DRIVE PROYECTO');
  dvRenderUploadDestinationFolders();
  const selection=document.getElementById('dvUploadDestinationSelection');
  if(selection){
    const root=!!folder.root || Number(folder.depth||0)===0;
    const extra=root && dvSelectionMode!=='folder'?' · los archivos quedarán sueltos en la raíz':'';
    selection.innerHTML=`Destino seleccionado:<br><strong><i class="fa-solid fa-folder mr-1 text-amber-500"></i>${escapeHtml(dvUploadDestinationSelectedPath)}</strong>${escapeHtml(extra)}`;
  }
  dvRefreshUploadButtonState();
}

// Selector real de carpeta para navegadores Chromium (Chrome/Brave/Edge).
// Permite elegir LA CARPETA directamente y recorre sus subcarpetas.
async function seleccionarCarpetaReal(){
  if(dvUploadInProgress) return;

  const status=document.getElementById('uploadStatus');
  if(status){
    status.classList.add('hidden');
    status.innerHTML='';
  }

  // Selección clásica de CARPETA COMPLETA.
  // El usuario elige únicamente la carpeta raíz una vez.
  // webkitdirectory hace que el navegador incluya automáticamente
  // todos los archivos de esa carpeta y de sus subcarpetas.
  const folderInput=document.getElementById('folderInput');
  if(!folderInput) return;

  folderInput.value='';
  folderInput.click();
}

handleFilesSelected = function(fileList, fromFolder=false){
  if(dvUploadInProgress || !fileList || !fileList.length) return;
  const mode = fromFolder ? 'folder' : 'files';
  const hadEntries=dvSelectedEntries.length>0;
  const changedMode=!!dvSelectionMode && dvSelectionMode !== mode;
  if(changedMode) dvSelectedEntries = [];
  if(!hadEntries || changedMode || fromFolder) dvResetUploadDestination();
  dvSelectionMode = mode;
  if(fromFolder){
    dvSelectedEntries = [];
    const firstPath = fileList[0]?.webkitRelativePath || '';
    dvSelectedFolderName = firstPath.split('/')[0] || 'Carpeta';
  }else{
    dvSelectedFolderName = '';
  }
  const map = new Map(dvSelectedEntries.map(e=>[dvEntryKey(e),e]));
  Array.from(fileList).forEach(file=>{
    const relativePath = fromFolder && file.webkitRelativePath ? file.webkitRelativePath : file.name;
    const entry={file,relativePath}; map.set(dvEntryKey(entry),entry);
  });
  dvSelectedEntries = Array.from(map.values());
  const fi=document.getElementById('fileInput'); if(fi) fi.value='';
  const fo=document.getElementById('folderInput'); if(fo) fo.value='';
  renderSelectedFiles();
  dvEnsureUploadDestinationFolders();
};

removeSelectedFile = function(index){
  if(dvUploadInProgress) return;
  if(index<0 || index>=dvSelectedEntries.length) return;
  dvSelectedEntries.splice(index,1);
  if(!dvSelectedEntries.length){dvSelectionMode=null;dvSelectedFolderName='';dvResetUploadDestination();}
  renderSelectedFiles();
};

function clearSelectedBatch(){
  if(dvUploadInProgress) return;
  dvSelectedEntries=[]; dvSelectionMode=null; dvSelectedFolderName='';
  dvResetUploadDestination();
  const fi=document.getElementById('fileInput'); if(fi) fi.value='';
  const fo=document.getElementById('folderInput'); if(fo) fo.value='';
  const status=document.getElementById('uploadStatus'); if(status){status.classList.add('hidden');status.innerHTML='';}
  renderSelectedFiles();
}

function dvSetUploading(flag){
  dvUploadInProgress=flag;
  const clear=document.getElementById('clearSelectionBtn');if(clear){clear.disabled=flag;clear.classList.toggle('opacity-50',flag)}
  const c=document.getElementById('cancelUploadBtn'); if(c)c.classList.toggle('hidden',!flag);
  dvRefreshUploadButtonState();
}

function cancelUploadBatch(){
  if(!dvUploadController) return;
  dvUploadController.abort(); dvUploadController=null;
  const status=document.getElementById('uploadStatus');
  if(status){status.classList.remove('hidden');status.className='mt-3 text-sm font-semibold text-amber-600';status.innerHTML='<i class="fa-solid fa-ban mr-2"></i>Carga cancelada. Los registros que el servidor ya haya procesado se conservan por trazabilidad.';}
  dvSetUploading(false);
}

renderSelectedFiles = function(){
  const box=document.getElementById('selectedFilesList');
  const bar=document.getElementById('batchActionBar');
  const btn=document.getElementById('uploadBatchBtn');
  const meta=document.getElementById('batchSelectionMeta');
  if(!box) return;

  if(!dvSelectedEntries.length){
    box.classList.add('hidden');
    if(bar)bar.classList.add('hidden');
    document.getElementById('dvUploadDestinationPanel')?.classList.add('hidden');
    box.innerHTML='';
    if(btn)btn.disabled=true;
    if(meta)meta.textContent='';
    return;
  }

  const total=dvSelectedEntries.reduce((s,e)=>s+e.file.size,0);
  box.classList.remove('hidden');
  if(bar)bar.classList.remove('hidden');
  document.getElementById('dvUploadDestinationPanel')?.classList.remove('hidden');
  dvRefreshUploadButtonState();

  if(dvSelectionMode==='folder'){
    // Mostrar el contenido completo de la carpeta ANTES de subirlo.
    // Cada archivo puede retirarse individualmente sin modificar la carpeta
    // original del equipo. El backend recibirá solo los que queden aquí.
    const raiz=(dvSelectedFolderName || 'Carpeta').replace(/\\/g,'/').replace(/^\/+|\/+$/g,'');
    const filas=dvSelectedEntries.map((e,i)=>{
      let ruta=String(e.relativePath || e.file.name || 'Archivo').replace(/\\/g,'/');
      if(raiz && ruta.startsWith(raiz + '/')) ruta=ruta.slice(raiz.length + 1);
      return `<div class="dv-selected-row">
        <span class="truncate text-[10px] text-slate-600" title="${escapeHtml(ruta)}"><i class="fa-solid fa-file mr-2 text-slate-400"></i>${escapeHtml(ruta)}</span>
        <span class="text-[9px] text-slate-400 whitespace-nowrap">${formatBytes(e.file.size)}</span>
        <button type="button" class="dv-remove-file" title="Quitar este archivo de la subida" onclick="removeSelectedFile(${i})">×</button>
      </div>`;
    }).join('');

    box.innerHTML=`
      <div class="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div class="flex items-center gap-3 px-3 py-3 border-b border-slate-100">
          <div class="h-10 w-10 rounded-lg bg-amber-50 text-amber-500 flex items-center justify-center flex-none">
            <i class="fa-solid fa-folder-open text-lg"></i>
          </div>
          <div class="min-w-0 flex-1">
            <div class="font-bold text-slate-700 text-[12px] truncate">${escapeHtml(dvSelectedFolderName || 'Carpeta')}</div>
            <div class="text-[10px] text-slate-400 mt-1">${dvSelectedEntries.length} archivo(s) seleccionado(s) · ${formatBytes(total)}</div>
            <div class="text-[9px] text-slate-400 mt-1"><i class="fa-solid fa-circle-info mr-1"></i>Quita con × los archivos que no quieras enviar. No se borran de tu equipo.</div>
          </div>
          <button type="button" class="dv-remove-file" title="Quitar toda la carpeta de la selección" onclick="clearSelectedBatch()">×</button>
        </div>
        <div class="max-h-64 overflow-y-auto px-3 py-1">
          ${filas}
        </div>
      </div>`;
  }else{
    box.innerHTML=`
      <div class="mb-2 text-[11px] font-bold text-slate-700">${dvSelectedEntries.length} archivo(s) seleccionado(s)</div>
      <div class="max-h-52 overflow-y-auto">
        ${dvSelectedEntries.map((e,i)=>`<div class="dv-selected-row"><span class="truncate text-[10px] text-slate-600"><i class="fa-solid fa-file mr-2 text-slate-400"></i>${escapeHtml(e.relativePath)}</span><span class="text-[9px] text-slate-400 whitespace-nowrap">${formatBytes(e.file.size)}</span><button type="button" class="dv-remove-file" title="Quitar archivo" onclick="removeSelectedFile(${i})">×</button></div>`).join('')}
      </div>`;
  }

  if(meta){
    const destino=dvUploadDestinationSelectedPath?` · Destino: ${dvUploadDestinationSelectedPath}`:' · Selecciona destino';
    meta.textContent=`${formatBytes(total)} · ${dvSelectedEntries.length} archivo(s) ${dvSelectionMode==='folder'?'de carpeta':'sueltos'}${destino}`;
  }
  dvRenderUploadDestinationFolders();
  dvRefreshUploadButtonState();
};

submitUploadBatch = async function(){
  if(!dvSelectedEntries.length || dvUploadInProgress) return;
  const status=document.getElementById('uploadStatus');
  if(!dvUploadDestinationSelectedId){
    status.classList.remove('hidden');status.className='mt-3 text-sm font-semibold text-amber-600';
    status.innerHTML='<i class="fa-solid fa-folder-circle-exclamation mr-2"></i>Selecciona primero una carpeta destino en Google Drive.';
    document.getElementById('dvUploadDestinationPanel')?.scrollIntoView({behavior:'smooth',block:'center'});
    return;
  }
  status.classList.remove('hidden'); status.className='mt-3 text-sm font-semibold text-amber-600';
  status.innerHTML=`<i class="fa-solid fa-spinner fa-spin mr-2"></i>Procesando ${dvSelectedEntries.length} archivo(s) en RAM...`;
  dvSetUploading(true); dvUploadController=new AbortController();
  try{
    const {data:sessionData,error:sessionError}=await supabaseClient.auth.getSession();
    if(sessionError) throw sessionError;
    const token=sessionData?.session?.access_token;
    if(!token) throw new Error('Tu sesión expiró. Inicia sesión nuevamente.');
    const fd=new FormData();
    dvSelectedEntries.forEach(e=>{fd.append('files',e.file,e.file.name);fd.append('relative_paths',e.relativePath);});
    fd.append('carpeta','PLANOS');
    fd.append('carpeta_destino_id',dvUploadDestinationSelectedId);
    const res=await fetch(`${API_URL}/upload-batch`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:fd,signal:dvUploadController.signal});
    let data={}; try{data=await res.json();}catch(_){ }
    if(!res.ok)throw new Error(dvHttpErrorMessage(res,data,'No se pudo registrar la solicitud de subida.'));
    const n=data.total_registrados??dvSelectedEntries.length;
    status.className=(data.total_errores||0)>0?'mt-3 text-sm font-semibold text-amber-600':'mt-3 text-sm font-semibold text-emerald-600';
    status.innerHTML=`<i class="fa-solid fa-circle-check mr-2"></i>${dvSelectionMode==='folder'?'Carpeta':'Lote'} registrado: ${n} archivo(s). Destino solicitado: ${escapeHtml(data?.destino_drive?.path||dvUploadDestinationSelectedPath||'Google Drive')}.`;
    dvSelectedEntries=[];dvSelectionMode=null;dvSelectedFolderName='';dvResetUploadDestination();renderSelectedFiles();
    await loadAudit(); await loadFilesView(); await loadCola();
  }catch(err){
    if(err?.name==='AbortError') return;
    console.error('UPLOAD BATCH ACTUAL ERROR',err);
    status.className='mt-3 text-sm font-semibold text-red-600';status.innerHTML='<i class="fa-solid fa-circle-xmark mr-2"></i>Error: '+escapeHtml(err?.message||'Error desconocido');
  }finally{
    dvUploadController=null; dvSetUploading(false); dvRefreshUploadButtonState();
  }
};

function dvPath(row){return String(row?.ruta_relativa||row?.nombre_archivo||'').replaceAll('\\\\','/').replace(/^\/+/, '');}
function dvRoot(row){const p=dvPath(row);return p.includes('/')?p.split('/')[0]:'';}
function dvIsFolderRecord(row){return Boolean(row?.lote_id && dvPath(row).includes('/'));}
function dvGroupState(rows){const s=[...new Set(rows.map(r=>String(r.estado||'PENDIENTE')))];return s.length===1?s[0]:'PARCIAL';}
function dvStatusClass(state){return state==='APROBADO'?'status-approved':state==='RECHAZADO'?'status-rejected':state==='PARCIAL'?'status-on':'status-pending';}
function dvIconFor(name){const ext=String(name||'').split('.').pop().toLowerCase();if(ext==='pdf')return 'fa-file-pdf';if(['xlsx','xls','csv'].includes(ext))return 'fa-file-excel';if(['doc','docx'].includes(ext))return 'fa-file-word';if(['html','htm','js','gs','json','xml'].includes(ext))return 'fa-file-code';return 'fa-file-lines';}
function dvDate(v){try{return v?new Date(v).toLocaleString('es-PE',{dateStyle:'short',timeStyle:'short'}):'—';}catch(_){return '—'}}
function dvFolderDetailId(id){return 'dv-folder-'+String(id||'').replace(/[^a-zA-Z0-9_-]/g,'');}
function toggleDvFolder(id){const row=document.getElementById(dvFolderDetailId(id));const icon=document.getElementById(dvFolderDetailId(id)+'-icon');if(!row)return;const hidden=row.classList.toggle('hidden');if(icon)icon.textContent=hidden?'▶':'▼';}

function dvBuildTree(rows){
  const root={folders:{},files:[]};
  rows.forEach(r=>{
    let parts=dvPath(r).split('/').filter(Boolean);if(parts.length>1)parts=parts.slice(1);
    if(!parts.length)parts=[r.nombre_archivo||'Archivo'];
    const fileName=parts.pop();let node=root;
    parts.forEach(p=>{node.folders[p]??={folders:{},files:[]};node=node.folders[p];});
    node.files.push({name:fileName,row:r});
  });return root;
}
function dvTreeCount(n){return n.files.length+Object.values(n.folders).reduce((s,x)=>s+dvTreeCount(x),0);}
function dvRenderTree(node){
  let html='';
  Object.entries(node.folders).sort(([a],[b])=>a.localeCompare(b)).forEach(([name,child])=>{html+=`<details><summary><i class="fa-solid fa-folder text-amber-500"></i><span>${escapeHtml(name)}</span><span class="ml-auto text-[8px] text-slate-400">${dvTreeCount(child)} archivo(s)</span></summary><div class="pl-4">${dvRenderTree(child)}</div></details>`;});
  node.files.sort((a,b)=>a.name.localeCompare(b.name)).forEach(({name,row})=>{html+=`<div class="dv-tree-file"><span class="dv-tree-file-name"><i class="fa-solid ${dvIconFor(name)} mr-2 text-blue-400"></i>${escapeHtml(name)}</span><span class="dv-hide-mobile text-[8px] text-slate-400">${formatBytes(Number(row.tamano_bytes||0))}</span><span class="status-pill ${dvStatusClass(row.estado)}">${escapeHtml(row.estado||'PENDIENTE')}</span></div>`;});
  return html;
}
function dvLooseRow(r){const hash=String(r.hash_sha256||'');return `<tr><td><div class="flex items-center gap-2"><div class="h-7 w-7 rounded-md bg-[#edf3f5] text-[#6c8698] flex items-center justify-center"><i class="fa-solid ${dvIconFor(r.nombre_archivo)} text-[10px]"></i></div><div><p class="font-semibold text-[#1f2b31] text-[9px]">${escapeHtml(r.nombre_archivo||'Sin nombre')}</p><p class="dv-unit-sub">${escapeHtml(r.solicitante_nombre||r.usuario_solicitante||'—')}</p></div></div></td><td class="text-[8px] text-slate-500">Archivo suelto</td><td><span class="integrity-ok"><i class="fa-solid fa-fingerprint"></i> Verificado</span></td><td><span class="status-pill ${dvStatusClass(r.estado)}">${escapeHtml(r.estado||'PENDIENTE')}</span></td><td class="text-[8px] text-slate-400">${dvDate(r.fecha_solicitud)}</td></tr>`;}
function dvFolderRows(rows,loteId){
  const root=dvRoot(rows[0])||'Carpeta';const total=rows.reduce((s,r)=>s+Number(r.tamano_bytes||0),0);const state=dvGroupState(rows);const id=dvFolderDetailId(loteId);const tree=dvBuildTree(rows);const last=rows.map(r=>r.fecha_solicitud||'').sort().reverse()[0];
  return `<tr class="dv-folder-summary"><td><button class="dv-folder-toggle" onclick="toggleDvFolder('${escapeHtml(String(loteId))}')"><span class="dv-caret" id="${id}-icon">▶</span><i class="fa-solid fa-folder text-amber-500"></i><span>${escapeHtml(root)}</span><span class="dv-folder-chip">${rows.length} archivo(s)</span></button></td><td class="text-[8px] text-slate-500">Carpeta / lote</td><td><span class="integrity-ok"><i class="fa-solid fa-fingerprint"></i> ${formatBytes(total)}</span></td><td><span class="status-pill ${dvStatusClass(state)}">${state}</span></td><td class="text-[8px] text-slate-400">${dvDate(last)}</td></tr><tr id="${id}" class="hidden dv-folder-detail"><td colspan="5"><div class="dv-folder-panel"><div class="flex flex-wrap justify-between gap-2 mb-2"><div><b class="text-[11px] text-slate-700"><i class="fa-solid fa-folder-open mr-2 text-amber-500"></i>${escapeHtml(root)}</b><div class="text-[8px] text-slate-400 mt-1">Lote ${escapeHtml(String(loteId))}</div></div><span class="text-[9px] text-slate-500">${rows.length} archivo(s) · ${formatBytes(total)}</span></div><div class="dv-tree">${dvRenderTree(tree)}</div></div></td></tr>`;
}

function dvGroupedUnits(rows){
  const groups=[];const map=new Map();
  rows.forEach(r=>{if(dvIsFolderRecord(r)){const id=String(r.lote_id);if(!map.has(id)){const g={type:'folder',id,rows:[],date:r.fecha_solicitud||''};map.set(id,g);groups.push(g);}const g=map.get(id);g.rows.push(r);if(String(r.fecha_solicitud||'')>String(g.date))g.date=r.fecha_solicitud||'';}else groups.push({type:'file',row:r,date:r.fecha_solicitud||''});});
  return groups.sort((a,b)=>String(b.date).localeCompare(String(a.date)));
}

function dvRenderDynamicFolders(){
  const box=document.getElementById('dynamicFolderTree');if(!box)return;
  const roots=[...new Set((auditCache||[]).filter(dvIsFolderRecord).map(dvRoot).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  box.innerHTML=roots.length?roots.map(root=>`<button onclick="selectFileFolder('${escapeHtml(root).replaceAll("'","&#039;")}')" class="tree-subitem" data-folder="${escapeHtml(root)}"><i class="fa-solid fa-folder"></i><span class="truncate">${escapeHtml(root)}</span></button>`).join(''):'<p class="tree-subitem text-slate-400">Sin carpetas cargadas</p>';
}

renderFilesTable = function(rows){
  const body=document.getElementById('filesTableBody');if(!body)return;
  const units=dvGroupedUnits(rows||[]);const count=document.getElementById('fileCountLabel');if(count)count.textContent=`${units.length} unidad${units.length===1?'':'es'} visuales · ${(rows||[]).length} archivo(s) auditados`;
  if(!units.length){body.innerHTML='<tr><td colspan="5" class="p-8 text-center text-slate-400">No hay archivos registrados.</td></tr>';return;}
  body.innerHTML=units.map(u=>u.type==='folder'?dvFolderRows(u.rows,u.id):dvLooseRow(u.row)).join('');
};

loadFilesView = async function(){
  const body=document.getElementById('filesTableBody');if(!body)return;
  body.innerHTML='<tr><td colspan="5" class="p-6 text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Cargando archivos...</td></tr>';
  const {data,error}=await supabaseClient.from('auditoria_custodia').select('*').order('fecha_solicitud',{ascending:false}).limit(500);
  if(error){console.error('FILES VIEW ERROR',error);body.innerHTML='<tr><td colspan="5" class="p-6 text-center text-red-400">No se pudo cargar el inventario.</td></tr>';return;}
  auditCache=Array.isArray(data)?data:[];dvRenderDynamicFolders();filterFiles();
};

selectFileFolder = function(folder){
  dvExplorerFolder=folder||'';
  document.querySelectorAll('.tree-item,.tree-subitem').forEach(b=>b.classList.remove('active'));
  const btn=[...document.querySelectorAll('[data-folder]')].find(b=>b.dataset.folder===folder);if(btn)btn.classList.add('active');
  const label=document.getElementById('currentFolderLabel'),title=document.getElementById('filePanelTitle');
  const name=folder==='__SHARED__'?'Compartidos conmigo':folder==='__TRASH__'?'Papelera':folder||'Todos los archivos';if(label)label.textContent=name;if(title)title.textContent=folder?name:'Mi unidad';
  filterFiles();
};

filterFiles = function(){
  const q=(document.getElementById('fileSearch')?.value||'').toLowerCase().trim();
  let rows=(auditCache||[]).filter(r=>!q||[r.nombre_archivo,r.solicitante_nombre,r.usuario_solicitante,r.hash_sha256,r.ruta_relativa].some(v=>String(v||'').toLowerCase().includes(q)));
  if(dvExplorerFolder==='__SHARED__' && typeof isSharedFile==='function')rows=rows.filter(isSharedFile);
  else if(dvExplorerFolder==='__TRASH__' && typeof isTrashFile==='function')rows=rows.filter(isTrashFile);
  else if(dvExplorerFolder)rows=rows.filter(r=>dvRoot(r)===dvExplorerFolder);
  renderFilesTable(rows);
};

function dvFolderLabel(row){return dvRoot(row)||'Archivo suelto';}

loadAudit = async function(){
  const {data,error}=await supabaseClient.from('auditoria_custodia').select('*').order('fecha_solicitud',{ascending:false}).limit(500);
  if(error){console.error('AUDIT ERROR',error);return;}
  auditCache=Array.isArray(data)?data:[];
  const auditBody=document.getElementById('auditTableBody'),inicioBody=document.getElementById('inicioTableBody');
  const badge=(s)=>dvStatusClass(s);
  if(auditBody){auditBody.innerHTML=auditCache.length?auditCache.slice(0,120).map(r=>`<tr><td>${escapeHtml(r.nombre_archivo||'Sin nombre')}</td><td>${escapeHtml(r.solicitante_nombre||r.usuario_solicitante||'—')}</td><td>${escapeHtml(dvFolderLabel(r))}</td><td class="font-mono text-[9px] text-blue-600" title="${escapeHtml(r.hash_sha256||'')}">${escapeHtml(String(r.hash_sha256||'').slice(0,16))}${r.hash_sha256?'...':''}</td><td><span class="status-pill ${badge(r.estado)}">${escapeHtml(r.estado||'PENDIENTE')}</span></td></tr>`).join(''):'<tr><td colspan="5" class="p-6 text-center text-slate-400">No existen registros.</td></tr>';}
  if(inicioBody){const units=dvGroupedUnits(auditCache).slice(0,5);inicioBody.innerHTML=units.length?units.map(u=>{if(u.type==='folder'){const s=dvGroupState(u.rows);return `<tr><td>📁 ${escapeHtml(dvRoot(u.rows[0])||'Carpeta')} <span class="text-[8px] text-slate-400">· ${u.rows.length}</span></td><td>${escapeHtml(u.rows[0]?.solicitante_nombre||u.rows[0]?.usuario_solicitante||'—')}</td><td>Carpeta</td><td><span class="status-pill ${badge(s)}">${s}</span></td></tr>`;}const r=u.row;return `<tr><td>📄 ${escapeHtml(r.nombre_archivo||'Archivo')}</td><td>${escapeHtml(r.solicitante_nombre||r.usuario_solicitante||'—')}</td><td>Archivo suelto</td><td><span class="status-pill ${badge(r.estado)}">${escapeHtml(r.estado||'PENDIENTE')}</span></td></tr>`;}).join(''):'<tr><td colspan="4" class="p-4 text-center text-slate-400">No existen registros.</td></tr>';}
  const pending=auditCache.filter(r=>r.estado==='PENDIENTE').length;updateKpis({archivos:auditCache.length,hash:auditCache.filter(r=>r.hash_sha256).length,pendientes:pending,carpetas:new Set(auditCache.filter(dvIsFolderRecord).map(dvRoot)).size});
  if(document.getElementById('view-gestor')?.classList.contains('active')){dvRenderDynamicFolders();filterFiles();}
  if(typeof updateDashboardVisuals==='function')updateDashboardVisuals();
};

loadCola = async function(){
  const body=document.getElementById('colaContainer');if(!body)return;
  const {data,error}=await supabaseClient.from('auditoria_custodia').select('*').eq('estado','PENDIENTE').order('fecha_solicitud',{ascending:false}).limit(500);
  if(error){console.error('COLA ACTUAL ERROR',error);body.innerHTML='<tr><td colspan="8" class="p-6 text-center text-red-400">No se pudo cargar la cola actual.</td></tr>';return;}
  const rows=Array.isArray(data)?data:[];const units=dvGroupedUnits(rows);colaCache=units.map(u=>({id:u.type==='folder'?u.id:u.row.id,tipo_operacion:u.type==='folder'?'CARPETA':'ARCHIVO',estado:'PENDIENTE',usuario_solicitante:u.type==='folder'?(u.rows[0]?.solicitante_nombre||u.rows[0]?.usuario_solicitante):(u.row.solicitante_nombre||u.row.usuario_solicitante),fecha_solicitud:u.date,archivos:u.type==='folder'?u.rows.map(r=>({nombre:r.nombre_archivo})): [{nombre:u.row.nombre_archivo}]}));
  const summary=document.getElementById('solSummary');if(summary)summary.textContent=`${units.length} unidad(es) pendientes · ${rows.length} archivo(s)`;const mini=document.getElementById('solPendingMini');if(mini)mini.textContent=rows.length;
  if(!units.length){body.innerHTML='<tr><td colspan="8" class="p-8 text-center text-slate-400">No existen documentos pendientes.</td></tr>';return;}
  body.innerHTML=units.map((u,i)=>{const isF=u.type==='folder';const r=isF?u.rows[0]:u.row;const id=isF?u.id:r.id;const name=isF?`📁 ${dvRoot(r)||'Carpeta'} · ${u.rows.length} archivo(s)`:`📄 ${r.nombre_archivo||'Archivo'}`;return `<tr><td>#${escapeHtml(String(id).slice(0,8))}</td><td>${isF?'Carpeta':'Archivo'}</td><td>${escapeHtml(name)}</td><td>Google Drive</td><td>${escapeHtml(r.solicitante_nombre||r.usuario_solicitante||'—')}</td><td>${dvDate(u.date)}</td><td><span class="status-pill status-pending">En cola</span></td><td><span class="text-[9px] text-slate-400"><i class="fa-brands fa-telegram mr-1"></i>Resolver en Telegram</span></td></tr>`;}).join('');
  updateKpis({pendientes:rows.length});if(typeof updateDashboardVisuals==='function')updateDashboardVisuals();
};

listenRealtime = function(){
  if(auditRealtimeChannel)return;
  auditRealtimeChannel=supabaseClient.channel('realtime_datavault_actual').on('postgres_changes',{event:'*',schema:'public',table:'auditoria_custodia'},async()=>{await loadAudit();if(document.getElementById('view-cola')?.classList.contains('active'))await loadCola();}).subscribe();
};

loadReports = async function(){
  const {data,error}=await supabaseClient.from('auditoria_custodia').select('*').order('fecha_solicitud',{ascending:false}).limit(1000);if(error){console.error('REPORTES ACTUAL ERROR',error);return;}
  auditCache=Array.isArray(data)?data:[];const total=auditCache.length,ap=auditCache.filter(x=>x.estado==='APROBADO').length,re=auditCache.filter(x=>x.estado==='RECHAZADO').length,pe=auditCache.filter(x=>x.estado==='PENDIENTE').length,ha=auditCache.filter(x=>x.hash_sha256).length;
  const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v};set('repTotalArchivos',total);set('repAprobados',ap);set('repRechazados',re);set('repPendientes',pe);set('repHash',ha);
  const states=[['Aprobados',ap,'bg-green-500'],['Pendientes',pe,'bg-amber-500'],['Rechazados',re,'bg-red-500']];const max=Math.max(1,ap,pe,re);const bars=document.getElementById('repBars');if(bars)bars.innerHTML=states.map(([n,v,c])=>`<div><div class="flex justify-between text-xs mb-1"><span>${n}</span><b>${v}</b></div><div class="h-2.5 bg-slate-100 rounded-full overflow-hidden"><div class="h-full ${c}" style="width:${Math.round(v/max*100)}%"></div></div></div>`).join('');
  const st=document.getElementById('repStates');if(st)st.innerHTML=states.map(([n,v,c])=>`<div class="flex items-center gap-3"><span class="h-3 w-3 rounded-full ${c}"></span><span class="text-sm text-slate-600 flex-1">${n}</span><b>${v}</b></div>`).join('');
  const folders={};auditCache.forEach(r=>{const k=dvRoot(r)||'Archivos sueltos';folders[k]=(folders[k]||0)+1;});const rf=document.getElementById('repFolders');if(rf)rf.innerHTML=Object.entries(folders).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<div><div class="flex justify-between text-xs mb-1"><span class="text-slate-600 truncate">${escapeHtml(k)}</span><span class="font-semibold">${v}</span></div><div class="h-2 bg-slate-100 rounded-full"><div class="h-full bg-blue-500 rounded-full" style="width:${total?Math.round(v/total*100):0}%"></div></div></div>`).join('');
};

// Reutilizar el dashboard existente, alimentándolo con la cola derivada de auditoria_custodia.
const dvOriginalUpdateDashboardVisuals = typeof updateDashboardVisuals==='function' ? updateDashboardVisuals : null;
updateDashboardVisuals = function(){
  const aud=Array.isArray(auditCache)?auditCache:[];const pending=aud.filter(x=>x.estado==='PENDIENTE').length,approved=aud.filter(x=>x.estado==='APROBADO').length,rejected=aud.filter(x=>x.estado==='RECHAZADO').length;
  const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v};set('dashTotalSolicitudes',aud.length);set('dashEnCola',pending);set('dashCompletadas',approved);set('dashBloqueadas',rejected);set('dashDonutTotal',aud.length);
  if(dvOriginalUpdateDashboardVisuals){try{dvOriginalUpdateDashboardVisuals();}catch(_){}}
};

window.addEventListener('DOMContentLoaded',()=>{
  // Las operaciones Subir / Mover / Eliminar se ejecutan directamente
  // desde la sección Archivos usando el backend actual.
  renderSelectedFiles();
});


/* datavault-role-v3 */

/* =========================================================
   EXPERIENCIA POR ROL
   - subordinado: Inicio | Archivos | Mis solicitudes
   - jefe/admin: Inicio | Usuarios | Aprobaciones | Archivos | Reglas DLP | Reportes | Auditoría
   IMPORTANTE: esto organiza la interfaz. La seguridad definitiva debe reforzarse con RLS/backend.
   ========================================================= */
(function(){
  const ROLE_ADMIN = 'jefe';
  const ROLE_SUB = 'subordinado';
  let roleAllAudit = [];
  let roleAllRequests = [];
  let adminUsersCache = [];
  let adminUserFilter = '';

  function norm(v){ return String(v ?? '').trim().toLowerCase(); }
  function isAdmin(){ return norm(currentRole) === ROLE_ADMIN; }
  function rowUserId(r){ return String(r?.solicitante_id || '').trim(); }
  function rowEmail(r){ return String(r?.solicitante_correo || r?.correo || '').trim(); }
  function rowName(r){ return String(r?.solicitante_nombre || r?.usuario_solicitante || r?.usuario || 'Usuario').trim(); }
  function belongsToMe(r){
    const uid=String(currentUser?.id||'').trim();
    if(uid && rowUserId(r) && rowUserId(r)===uid) return true;
    if(currentUserEmail && rowEmail(r) && norm(rowEmail(r))===norm(currentUserEmail)) return true;
    return !!currentDisplayName && norm(rowName(r))===norm(currentDisplayName);
  }
  function requestBelongsToMe(r){
    const uid=String(currentUser?.id||'').trim();
    if(uid && String(r?.solicitante_id||'').trim()===uid) return true;
    const mail=String(r?.solicitante_correo||r?.correo||'').trim();
    if(currentUserEmail && mail && norm(mail)===norm(currentUserEmail)) return true;
    const who=String(r?.usuario_solicitante||r?.solicitante_nombre||r?.usuario||'').trim();
    return !!who && (norm(who)===norm(currentDisplayName) || norm(who)===norm(currentUserEmail));
  }
  function roleFromUser(user){
    const raw = user?.app_metadata?.rol || user?.app_metadata?.role || ROLE_SUB;
    const v=norm(raw);
    return ['jefe','admin','administrador'].includes(v) ? ROLE_ADMIN : ROLE_SUB;
  }
  function setNavVisible(name,visible){
    document.querySelectorAll(`[data-nav="${name}"]`).forEach(el=>el.classList.toggle('role-hidden',!visible));
  }
  function renameNav(name,label){
    document.querySelectorAll(`[data-nav="${name}"]`).forEach(el=>{
      const s = el.querySelector(':scope > span.sidebar-full')
        || el.querySelector(':scope > span:not(.dv-svg-icon):not(.top-badge)');
      if(s) s.textContent = label;
    });
  }
  function findCardByTitle(title){
    return [...document.querySelectorAll('#view-inicio .dashboard-card')].find(c=>norm(c.querySelector('h3')?.textContent)===norm(title));
  }

  function ensureAdminFileFilter(){
    const head=document.querySelector('#view-gestor .file-content-head');
    if(!head || document.getElementById('adminFileUserFilterWrap')) return;
    const wrap=document.createElement('div');
    wrap.id='adminFileUserFilterWrap';
    wrap.className='admin-filter-wrap role-hidden';
    wrap.innerHTML='<select id="adminFileUserFilter" class="input-modern"><option value="">Todos los usuarios</option></select>';
    const select=wrap.querySelector('select');
    select.addEventListener('change',()=>{adminUserFilter=select.value;loadFilesView();});
    head.appendChild(wrap);
  }

  function applyRoleExperience(){
    const admin=isAdmin();
    const allowed=admin
      ? new Set(['inicio','usuarios','cola','gestor','reglas','reportes','auditoria'])
      : new Set(['inicio','gestor','cola']);
    ['inicio','gestor','operaciones','reglas','reportes','auditoria','usuarios','cola'].forEach(n=>setNavVisible(n,allowed.has(n)));
    renameNav('cola',admin?'Aprobaciones':'Mis solicitudes');

    const roleText=admin?'Administrador':'Subordinado';
    ['userRoleBadge','profileRolTexto','profileRolBadge','solRoleMini'].forEach(id=>{const e=document.getElementById(id);if(e)e.textContent=roleText;});

    const adminLabel=document.getElementById('adminLabel');
    if(adminLabel) adminLabel.classList.toggle('role-hidden',!admin);

    // El admin supervisa: no necesita controles de carga en su explorador.
    // dropZone ahora es la lista de archivos para conservar arrastrar/soltar sin mostrar un bloque extra.
    ['batchActionBar','selectedFilesList','dvUploadDestinationPanel','dvFileOperationBar','dvDriveNewWrap'].forEach(id=>{const e=document.getElementById(id);if(e && admin)e.classList.add('role-hidden');else if(e)e.classList.remove('role-hidden');});
    document.querySelectorAll('#view-gestor .file-content-head button').forEach(btn=>{
      const click=btn.getAttribute('onclick')||'';
      if(/fileInput|folderInput|seleccionarCarpeta/i.test(click)) btn.classList.toggle('role-hidden',admin);
    });
    ensureAdminFileFilter();
    const af=document.getElementById('adminFileUserFilterWrap');if(af)af.classList.toggle('role-hidden',!admin);

    // Los indicadores DLP de este panel son informativos; el subordinado no los administra.
    const securityPanel=document.getElementById('fileSecurityPanel');
    if(securityPanel) securityPanel.classList.toggle('role-hidden', !admin);
    const managerShell=document.querySelector('#view-gestor .file-manager-shell');
    if(managerShell) managerShell.classList.toggle('subordinate-layout', !admin);

    const panelTitle=document.getElementById('filePanelTitle');
    if(panelTitle) panelTitle.textContent=admin?'Archivos corporativos':'Mis archivos';
    const rootTree=[...document.querySelectorAll('#view-gestor [data-folder=""]')];
    rootTree.forEach(x=>{const t=[...x.childNodes].find(n=>n.nodeType===3);if(t)t.textContent=admin?' Todos los archivos':' Mis archivos';});

    // Home: el subordinado no administra políticas ni ve gráficos corporativos.
    ['Actividad de archivos','Tipos de eventos DLP','Estado de protección'].forEach(title=>{const c=findCardByTitle(title);if(c)c.classList.toggle('role-hidden',!admin);});

    // En subordinado, Actividad reciente ocupa todo el ancho de las 4 tarjetas superiores.
    const recentCard=findCardByTitle('Actividad reciente');
    const recentGrid=recentCard?.parentElement;
    if(recentGrid && !recentGrid.classList.contains('dv-home-layout')){
      recentGrid.style.gridTemplateColumns=admin?'':'minmax(0, 1fr)';
      recentGrid.classList.toggle('subordinate-recent-grid',!admin);
    }

    // En Mis solicitudes del subordinado no se muestra la columna Acciones.
    const colaView=document.getElementById('view-cola');
    if(colaView) colaView.classList.toggle('subordinate-requests',!admin);
    const colaHeadRow=document.querySelector('#view-cola .data-table thead tr');
    if(colaHeadRow){
      let actionsHead=[...colaHeadRow.children].find(th=>norm(th.textContent)==='acciones');
      if(admin && !actionsHead){
        actionsHead=document.createElement('th');
        actionsHead.textContent='Acciones';
        actionsHead.dataset.roleActionsHead='1';
        colaHeadRow.appendChild(actionsHead);
      }else if(!admin && actionsHead){
        actionsHead.classList.add('dv-request-action-column');
      }
    }

    const auditLink=[...document.querySelectorAll('#view-inicio button')].find(b=>/Ver auditoría/i.test(b.textContent||''));
    if(auditLink) auditLink.classList.toggle('role-hidden',!admin);

    const colaTitle=document.querySelector('#view-cola .page-title h2');
    const colaDesc=document.querySelector('#view-cola .page-title p');
    if(colaTitle)colaTitle.textContent=admin?'Aprobaciones':'Mis solicitudes';
    if(colaDesc)colaDesc.textContent=admin?'Revisa las cargas pendientes por usuario. Puedes aprobar o rechazar desde la web o desde Telegram.':'Consulta el estado de tus cargas y operaciones solicitadas.';
    const nueva=document.querySelector('#view-cola .page-title .primary-btn');
    if(nueva){
      nueva.classList.toggle('role-hidden',admin);
      if(!admin){
        nueva.setAttribute('onclick', "showView('gestor')");
        nueva.innerHTML='<i class="fa-solid fa-folder-open"></i>Ir a archivos';
      }
    }

    updateTopbarResponsive?.();
  }

  // Captura final del rol; app_metadata tiene prioridad sobre user_metadata.
  const baseSetSession=setSessionFromUser;
  setSessionFromUser=function(user){
    baseSetSession(user);
    currentRole=roleFromUser(user);
    applyRoleExperience();

    // Al resolver el rol, asegura explícitamente que los módulos del administrador
    // que nacen ocultos en el HTML queden visibles desde el primer ingreso.
    const topUsers = document.getElementById('topNavUsuarios');
    const sideUsers = document.getElementById('navUsuarios');
    if(currentRole === ROLE_ADMIN){
      [topUsers, sideUsers].forEach(el=>{
        if(!el) return;
        el.classList.remove('hidden','role-hidden');
        el.style.removeProperty('display');
      });
    }

    // El rol puede cambiar después del primer cálculo responsive del topbar.
    // Recalculamos una vez, después de mostrar el menú del administrador.
    requestAnimationFrame(()=>{
      if(typeof updateTopbarResponsive === 'function') updateTopbarResponsive();
      if(typeof window.dvRoleNavbarFit === 'function') window.dvRoleNavbarFit();
    });
  };

  // Evita navegación visual a módulos que no corresponden al rol.
  const baseShowView=showView;
  showView=function(name){
    const admin=isAdmin();
    const allowed=admin
      ? ['inicio','usuarios','cola','gestor','reglas','reportes','auditoria']
      : ['inicio','gestor','cola'];
    if(!allowed.includes(name)) name='inicio';
    baseShowView(name);
    applyRoleExperience();
    if(name==='usuarios' && admin) loadAdminUsers();
    if(name==='inicio') setTimeout(loadRoleHome,0);
  };

  function currentAuditRows(){
    let rows=isAdmin()?roleAllAudit:roleAllAudit.filter(belongsToMe);
    if(isAdmin() && adminUserFilter) rows=rows.filter(r=>userKey(r)===adminUserFilter);
    return rows;
  }
  function userKey(r){return rowUserId(r)||norm(rowEmail(r))||norm(rowName(r));}

  // Archivos: subordinado ve solo los suyos; admin puede filtrar por usuario.
  loadFilesView=async function(){
    const body=document.getElementById('filesTableBody');if(!body)return;
    body.innerHTML='<tr><td colspan="5" class="p-6 text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Cargando archivos...</td></tr>';
    const {data,error}=await supabaseClient.from('auditoria_custodia').select('*').order('fecha_solicitud',{ascending:false}).limit(1000);
    if(error){body.innerHTML='<tr><td colspan="5" class="p-6 text-center text-red-400">No se pudo cargar el inventario.</td></tr>';return;}
    roleAllAudit=Array.isArray(data)?data:[];
    populateAdminFileFilter();
    auditCache=currentAuditRows();
    renderFilesTable(auditCache);
  };

  function populateAdminFileFilter(){
    const sel=document.getElementById('adminFileUserFilter');if(!sel||!isAdmin())return;
    const map=new Map();roleAllAudit.forEach(r=>{const k=userKey(r);if(k&&!map.has(k))map.set(k,{name:rowName(r),email:rowEmail(r)});});
    const old=adminUserFilter;
    sel.innerHTML='<option value="">Todos los usuarios</option>'+[...map.entries()].sort((a,b)=>a[1].name.localeCompare(b[1].name)).map(([k,u])=>`<option value="${escapeHtml(k)}">${escapeHtml(u.name)}${u.email?' · '+escapeHtml(u.email):''}</option>`).join('');
    sel.value=old;
  }

  // Solicitudes actuales construidas desde auditoria_custodia, que sí pertenece al backend actual.
  function groupAuditUnits(rows){
    const map=new Map();
    rows.forEach(r=>{
      const lote=String(r.lote_id||'').trim();
      const key=lote?'lote:'+lote:'file:'+String(r.id||Math.random());
      if(!map.has(key))map.set(key,{key,lote_id:lote,rows:[],fecha:r.fecha_solicitud||'',userKey:userKey(r),name:rowName(r),email:rowEmail(r)});
      map.get(key).rows.push(r);
    });
    return [...map.values()].sort((a,b)=>String(b.fecha).localeCompare(String(a.fecha)));
  }
  function unitStatus(u){const s=[...new Set(u.rows.map(r=>String(r.estado||'PENDIENTE').toUpperCase()))];return s.length===1?s[0]:'PARCIAL';}
  function unitName(u){
    if(u.lote_id){const p=String(u.rows[0]?.ruta_relativa||'').replace(/\\/g,'/').split('/').filter(Boolean);return p.length>1?p[0]:(u.rows[0]?.nombre_archivo||'Lote');}
    return u.rows[0]?.nombre_archivo||'Archivo';
  }
  function renderAuditRequests(){
    const tbody=document.getElementById('colaContainer');if(!tbody)return;
    const q=norm(document.getElementById('solSearch')?.value||'');
    const st=document.getElementById('solStateFilter')?.value||'';
    let units=groupAuditUnits(isAdmin()?roleAllAudit:roleAllAudit.filter(belongsToMe));
    units=units.filter(u=>{const state=unitStatus(u);const text=norm([unitName(u),u.name,u.email,u.lote_id].join(' '));return(!q||text.includes(q))&&(!st||state===st);});
    const allFilteredUnits=units;
    if(isAdmin()) units=window.dvSubPage(units,'adminRequests',q+'|'+st,tbody,renderAuditRequests);
    tbody.innerHTML=units.length?units.map((u,i)=>{
      const state=unitStatus(u),name=unitName(u);
      const actionCell=isAdmin()?`<td>${state==='PENDIENTE'?'<span class="text-xs text-blue-600 font-semibold"><i class="fa-brands fa-telegram mr-1"></i>Resolver en Telegram</span>':'—'}</td>`:'';
      return `<tr>
      <td>#${escapeHtml(String(u.lote_id||u.rows[0]?.id||i+1).slice(-8))}</td>
      <td>${u.lote_id?'Carpeta':'Archivo'}<div class="text-[9px] text-slate-400">${u.rows.length} archivo(s)</div></td>
      <td>${escapeHtml(name)}</td><td>Google Drive</td><td>${escapeHtml(u.name)}</td><td>${formatShortDate(u.fecha)}</td><td>${statusPill(state)}</td>${actionCell}
    </tr>`}).join(''):`<tr><td colspan="${isAdmin()?8:7}" class="p-8 text-center text-slate-400">No se encontraron solicitudes.</td></tr>`;
    const pending=allFilteredUnits.filter(u=>unitStatus(u)==='PENDIENTE').length;
    const sum=document.getElementById('solSummary');if(sum)sum.textContent=`${allFilteredUnits.length} unidad(es) · ${pending} pendiente(s)`;
    const mini=document.getElementById('solPendingMini');if(mini)mini.textContent=pending;
    updateKpis({pendientes:pending});
  }
  loadCola=async function(){
    const {data,error}=await supabaseClient.from('auditoria_custodia').select('*').order('fecha_solicitud',{ascending:false}).limit(1000);
    if(error){console.error('COLA DESDE AUDITORÍA:',error);return;}
    roleAllAudit=Array.isArray(data)?data:[];
    renderAuditRequests();
  };
  filterSolicitudesUI=renderAuditRequests;

  // Auditoría: exclusiva del admin.
  loadAudit=async function(){
    const {data,error}=await supabaseClient.from('auditoria_custodia').select('*').order('fecha_solicitud',{ascending:false}).limit(1000);
    if(error){console.error('AUDITORIA:',error);return;}
    roleAllAudit=Array.isArray(data)?data:[];
    const rows=isAdmin()?roleAllAudit:roleAllAudit.filter(belongsToMe);
    auditCache=rows;
    const body=document.getElementById('auditTableBody');
    if(body){
      const paintAudit=()=>{
        const pageRows=window.dvSubPage(rows,'audit','',body,paintAudit);
        body.innerHTML=pageRows.length?pageRows.map(r=>`<tr><td>${escapeHtml(r.nombre_archivo||'Sin nombre')}</td><td>${escapeHtml(rowName(r))}</td><td>${escapeHtml(auditFolderName(r))}</td><td class="font-mono text-[9px]" title="${escapeHtml(r.hash_sha256||'')}">${r.hash_sha256?escapeHtml(r.hash_sha256.slice(0,18))+'…':'N/A'}</td><td>${statusPill(r.estado)}</td></tr>`).join(''):'<tr><td colspan="5" class="p-6 text-center text-slate-400">No existen registros.</td></tr>';
      };
      paintAudit();
    }
    renderRoleRecent(rows);
    loadRoleHome();
    if(document.getElementById('view-gestor')?.classList.contains('active')){populateAdminFileFilter();renderFilesTable(currentAuditRows());}
  };

  function renderRoleRecent(rows){
    const body=document.getElementById('inicioTableBody');if(!body)return;
    const visible=(isAdmin()?rows:rows.filter(belongsToMe)).slice(0,6);
    body.innerHTML=visible.length?visible.map(r=>`<tr><td>${formatShortDate(r.fecha_solicitud)}</td><td>${escapeHtml(rowName(r))}</td><td>${escapeHtml(r.lote_id?'Carga de carpeta':'Carga de archivo')}</td><td>${statusPill(r.estado)}</td></tr>`).join(''):'<tr><td colspan="4" class="p-6 text-center text-slate-400">No existen registros.</td></tr>';
  }

  async function loadRoleHome(){if(typeof window.dvRefreshDashboardInventory==='function'){window.dvRefreshDashboardInventory('legacy-role-home');return;}
    if(!roleAllAudit.length){const {data}=await supabaseClient.from('auditoria_custodia').select('*').order('fecha_solicitud',{ascending:false}).limit(1000);roleAllAudit=Array.isArray(data)?data:[];}
    const rows=isAdmin()?roleAllAudit:roleAllAudit.filter(belongsToMe);
    const approved=rows.filter(r=>r.estado==='APROBADO').length;
    const pending=rows.filter(r=>r.estado==='PENDIENTE').length;
    const rejected=rows.filter(r=>r.estado==='RECHAZADO').length;
    const cards=[...document.querySelectorAll('#view-inicio .grid.grid-cols-2.xl\\:grid-cols-4 .dashboard-card')];
    const vals=isAdmin()?
      [['Archivos protegidos',rows.length,'Registros corporativos'],['Solicitudes pendientes',groupAuditUnits(rows).filter(u=>unitStatus(u)==='PENDIENTE').length,'Requieren revisión'],['Usuarios con actividad',new Set(rows.map(userKey).filter(Boolean)).size,'Con cargas registradas'],['Rechazados',rejected,'Eventos bloqueados']]:
      [['Mis archivos',rows.length,'En custodia'],['Pendientes',pending,'Esperando aprobación'],['Aprobados',approved,'Transferidos'],['Rechazados',rejected,'No autorizados']];
    cards.slice(0,4).forEach((c,i)=>{const label=c.querySelector('.metric-label');const value=c.querySelector('.metric-value');const trend=c.querySelector('.metric-trend');if(label)label.textContent=vals[i][0];if(value)value.textContent=vals[i][1];if(trend)trend.textContent=vals[i][2];});
    const welcome=document.getElementById('dashWelcome');if(welcome)welcome.textContent=currentDisplayName||(isAdmin()?'Administrador':'Usuario');
    renderRoleRecent(rows);
  }

  // Las llamadas administrativas usan authHeaders global.

  function toast(msg){
    const old=document.getElementById('dvOpToast');
    if(old) old.remove();
    const el=document.createElement('div');
    el.id='dvOpToast';
    el.className='dv-op-toast';
    el.textContent=msg;
    document.body.appendChild(el);
    setTimeout(()=>el.remove(),3500);
  }

  // =======================================================
  // CREAR USUARIOS DESDE EL PANEL DEL ADMINISTRADOR
  // =======================================================
  function ensureCreateUserModal(){
    if(document.getElementById('dvUserCreateModal')) return document.getElementById('dvUserCreateModal');
    const modal=document.createElement('div');
    modal.id='dvUserCreateModal';
    modal.className='dv-hidden';
    modal.innerHTML=`<div class="dv-user-modal-card">
      <div class="dv-user-modal-head"><div><p class="text-[10px] uppercase tracking-widest text-slate-400 font-bold">Administración</p><h3 class="text-lg font-extrabold text-slate-800 mt-1">Crear usuario</h3><p class="text-xs text-slate-500 mt-1">Registra una nueva cuenta de acceso para DataVault DLP.</p></div><button type="button" class="icon-btn" onclick="closeCreateUserModal()"><i class="fa-solid fa-xmark"></i></button></div>
      <div class="dv-user-modal-body">
        <form id="dvCreateUserForm" class="dv-user-form-grid" onsubmit="submitCreateUser(event)">
          <div class="dv-user-field full"><label class="field-label" for="dvNewUserName">Nombre completo</label><input id="dvNewUserName" class="input-modern w-full" type="text" maxlength="120" placeholder="Nombre y apellidos" required></div>
          <div class="dv-user-field full"><label class="field-label" for="dvNewUserEmail">Correo electrónico</label><input id="dvNewUserEmail" class="input-modern w-full" type="email" maxlength="180" placeholder="usuario@empresa.com" required></div>
          <div class="dv-user-field"><label class="field-label" for="dvNewUserRole">Rol</label><select id="dvNewUserRole" class="input-modern w-full"><option value="subordinado">Subordinado</option><option value="jefe">Administrador</option></select></div>
          <div class="dv-user-field"><label class="field-label" for="dvNewUserPassword">Contraseña</label><input id="dvNewUserPassword" class="input-modern w-full" type="password" minlength="6" maxlength="128" placeholder="Mínimo 6 caracteres" required></div>
          <div class="dv-user-field full"><label class="field-label" for="dvNewUserPassword2">Confirmar contraseña</label><input id="dvNewUserPassword2" class="input-modern w-full" type="password" minlength="6" maxlength="128" placeholder="Repite la contraseña" required></div>
          <div id="dvCreateUserMessage" class="dv-user-field full hidden"></div>
          <div class="dv-user-field full flex-row justify-end gap-2 pt-1"><button type="button" class="secondary-btn" onclick="closeCreateUserModal()">Cancelar</button><button type="submit" id="dvCreateUserSubmit" class="primary-btn"><i class="fa-solid fa-user-plus"></i>Crear usuario</button></div>
        </form>
      </div>
    </div>`;
    modal.addEventListener('click',e=>{if(e.target===modal)closeCreateUserModal();});
    document.body.appendChild(modal);
    return modal;
  }

  window.openCreateUserModal=function(){
    if(!isAdmin()) return toast('Solo el administrador puede crear usuarios.');
    const modal=ensureCreateUserModal();
    const form=document.getElementById('dvCreateUserForm');
    if(form) form.reset();
    const msg=document.getElementById('dvCreateUserMessage');
    if(msg){msg.className='dv-user-field full hidden';msg.textContent='';}
    modal.classList.remove('dv-hidden');
    setTimeout(()=>document.getElementById('dvNewUserName')?.focus(),50);
  };

  window.closeCreateUserModal=function(){
    document.getElementById('dvUserCreateModal')?.classList.add('dv-hidden');
  };

  window.submitCreateUser=async function(event){
    event?.preventDefault();
    if(!isAdmin()) return;
    const name=document.getElementById('dvNewUserName')?.value.trim();
    const email=document.getElementById('dvNewUserEmail')?.value.trim();
    const role=document.getElementById('dvNewUserRole')?.value || 'subordinado';
    const password=document.getElementById('dvNewUserPassword')?.value || '';
    const password2=document.getElementById('dvNewUserPassword2')?.value || '';
    const msg=document.getElementById('dvCreateUserMessage');
    const submit=document.getElementById('dvCreateUserSubmit');
    const setMessage=(text,ok=false)=>{if(!msg)return;msg.className=`dv-user-field full ${ok?'dv-user-success':'dv-user-error'}`;msg.textContent=text;};
    if(!name||!email||!password){setMessage('Completa todos los campos.');return;}
    if(password.length<6){setMessage('La contraseña debe tener al menos 6 caracteres.');return;}
    if(password!==password2){setMessage('Las contraseñas no coinciden.');return;}
    if(!['jefe','subordinado'].includes(role)){setMessage('Rol inválido.');return;}
    try{
      if(submit) {submit.disabled=true;submit.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i>Creando...';}
      const headers=await authHeaders(true);
      const res=await fetch(`${API_URL}/admin/users`,{method:'POST',headers,body:JSON.stringify({nombre:name,email,rol:role,password})});
      const data=await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(data?.detail || 'No se pudo crear el usuario.');
      setMessage(`Usuario creado correctamente: ${data?.usuario?.email || email}.`,true);
      toast('Usuario creado correctamente.');
      document.getElementById('dvCreateUserForm')?.reset();
      if(typeof loadAdminUsers==='function') await loadAdminUsers();
      setTimeout(closeCreateUserModal,1200);
    }catch(error){
      console.error('CREAR USUARIO:',error);
      setMessage(error?.message || 'No se pudo crear el usuario.');
    }finally{
      if(submit){submit.disabled=false;submit.innerHTML='<i class="fa-solid fa-user-plus"></i>Crear usuario';}
    }
  };

  // Usuarios del admin: primero carga las cuentas Auth y las muestra de inmediato.
  // La actividad de custodia se completa en segundo plano para que la tabla no espere
  // a una consulta pesada de auditoría.
  window.loadAdminUsers=async function(){
    if(!isAdmin())return;
    const body=document.getElementById('adminUsersBody');
    try{
      const headers=await authHeaders(true);
      const authRes=await fetch(`${API_URL}/admin/users`,{headers});
      const authData=await authRes.json().catch(()=>({}));
      if(!authRes.ok) throw new Error(authData?.detail || 'No se pudo cargar la lista de usuarios.');

      const authUsers=Array.isArray(authData?.usuarios)?authData.usuarios:[];
      window.dispatchEvent(new CustomEvent('dv:users-data', {detail: {users: authUsers}}));
      adminUsersCache=authUsers.map(u=>({
        key:String(u.id||'').trim(),
        id:String(u.id||'').trim(),
        name:String(u.nombre||u.email||'Usuario'),
        email:String(u.email||''),
        rol:String(u.rol||'subordinado'),
        driveFolderCount:Number(u.drive_folder_count||0),
        rows:[],
        last:u.last_sign_in_at||u.created_at||''
      })).filter(u=>u.id);

      document.getElementById('admUsersTotal').textContent=adminUsersCache.length;
      document.getElementById('admFilesTotal').textContent='—';
      document.getElementById('admPendingTotal').textContent='—';
      document.getElementById('admRejectedTotal').textContent='—';
      renderAdminUsers();
      populateAdminFileFilter();

      // La actividad se carga después de mostrar las cuentas.
      const {data,error}=await supabaseClient
        .from('auditoria_custodia')
        .select('solicitante_id,solicitante_correo,solicitante_nombre,usuario_solicitante,nombre_archivo,ruta_relativa,lote_id,hash_sha256,estado,fecha_solicitud')
        .order('fecha_solicitud',{ascending:false})
        .limit(2000);

      if(error) throw error;
      roleAllAudit=Array.isArray(data)?data:[];

      const activityMap=new Map();
      roleAllAudit.forEach(r=>{
        const k=userKey(r);
        if(!k)return;
        if(!activityMap.has(k))activityMap.set(k,{rows:[],last:r.fecha_solicitud||''});
        const u=activityMap.get(k);
        u.rows.push(r);
        if(String(r.fecha_solicitud||'')>String(u.last||''))u.last=r.fecha_solicitud;
      });

      const merged=adminUsersCache.map(u=>{
        const a=activityMap.get(u.id)||activityMap.get(norm(u.email))||{rows:[],last:''};
        return {...u,rows:a.rows,last:a.last||u.last};
      });
      adminUsersCache=merged;
      document.getElementById('admFilesTotal').textContent=roleAllAudit.length;
      document.getElementById('admPendingTotal').textContent=roleAllAudit.filter(r=>r.estado==='PENDIENTE').length;
      document.getElementById('admRejectedTotal').textContent=roleAllAudit.filter(r=>r.estado==='RECHAZADO').length;
      renderAdminUsers();
      populateAdminFileFilter();
    }catch(error){
      console.error('USUARIOS ADMIN:',error);
      const errorMessage = error?.message || 'No se pudo cargar la lista de usuarios.';
      if(body && !adminUsersCache.length){
        body.innerHTML=`<tr><td colspan="8" class="p-8 text-center text-red-400">${escapeHtml(errorMessage)}</td></tr>`;
      }else{
        toast(errorMessage);
      }
    }
  };
  window.renderAdminUsers=function(){
    const body=document.getElementById('adminUsersBody');if(!body)return;const q=norm(document.getElementById('adminUserSearch')?.value||'');
    const rows=adminUsersCache.filter(u=>!q||norm(u.name+' '+u.email).includes(q));
    body.innerHTML=rows.length?rows.map(u=>{const a=u.rows.filter(r=>r.estado==='APROBADO').length,p=u.rows.filter(r=>r.estado==='PENDIENTE').length,x=u.rows.filter(r=>r.estado==='RECHAZADO').length;const activityBtn=u.rows.length?`<button class="secondary-btn" onclick="openAdminUserDetail('${escapeHtml(u.key)}')">Ver actividad</button>`:'<button class="secondary-btn" disabled>Sin actividad</button>';return `<tr>
      <td><div class="flex items-center gap-2"><span class="admin-user-avatar">${escapeHtml((u.name||'?').slice(0,1).toUpperCase())}</span><div><span class="admin-user-name">${escapeHtml(u.name)}</span><div class="text-[10px] text-slate-400 uppercase tracking-wide">${escapeHtml(u.rol||'subordinado')}</div></div></div></td><td>${escapeHtml(u.email||'—')}</td><td><b>${u.rows.length}</b></td><td><span class="text-emerald-600 font-bold">${a}</span></td><td><span class="text-amber-600 font-bold">${p}</span></td><td><span class="text-red-500 font-bold">${x}</span></td><td>${formatShortDate(u.last)}</td><td><div class="flex items-center justify-end gap-2">${activityBtn}<button type="button" class="secondary-btn" data-dv-drive-permission-user="${escapeHtml(u.id)}"><i class="fa-solid fa-folder-closed"></i> Carpetas Drive (${u.driveFolderCount||0}/5)</button><button class="danger-btn" onclick="deleteAdminUser('${escapeHtml(u.id)}')"><i class="fa-solid fa-trash"></i>Eliminar</button></div></td>
    </tr>`}).join(''):'<tr><td colspan="8" class="p-8 text-center text-slate-400">No se encontraron usuarios registrados.</td></tr>';
  };
  // Editor exclusivo del administrador: hasta 5 enlaces completos por usuario.
  // Si la lectura falla, NO se puede sobrescribir una configuración desconocida.
  let dvFolderEditorUserId='';
  let dvFolderEditorEntries=[];
  let dvFolderEditorLoading=false;
  // Estilos autosuficientes: la ventana debe visualizarse incluso cuando el
  // CSS del repositorio todavía no se ha desplegado o está en caché.
  function dvEnsureDrivePermissionsStyles(){
    if(document.getElementById('dvDrivePermissionsRuntimeStyles'))return;
    const style=document.createElement('style');
    style.id='dvDrivePermissionsRuntimeStyles';
    style.textContent=`
      .dv-drive-permissions-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.66);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
      .dv-drive-permissions-overlay.dv-hidden{display:none!important}
      .dv-drive-permissions-card{width:min(100%,620px);max-height:92vh;overflow:auto;background:#fff;border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.25);padding:22px;color:#1e293b;box-sizing:border-box}
      .dv-drive-permissions-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;border-bottom:1px solid #e2e8f0;padding-bottom:14px;margin-bottom:14px}
      .dv-drive-permissions-head h3{font-size:19px;font-weight:800}
      .dv-drive-permissions-note{font-size:13px;line-height:1.5;color:#475569;margin-bottom:16px}
      .dv-drive-permissions-rows{display:grid;gap:12px;margin-bottom:14px}
      .dv-drive-permissions-row{border:1px solid #e2e8f0;padding:12px;border-radius:10px;background:#f8fafc}
      .dv-drive-permissions-input{display:flex;gap:8px;align-items:center;margin-top:5px}
      .dv-drive-permissions-input input{min-width:0;flex:1;font-size:12px}
      .dv-drive-permissions-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:18px;flex-wrap:wrap}
      #dvDrivePermissionsFeedback{color:#b45309;margin-top:10px;min-height:16px;white-space:pre-wrap;overflow-wrap:anywhere}
      @media(max-width:480px){.dv-drive-permissions-card{padding:14px}.dv-drive-permissions-actions button{flex:1}}
    `;
    (document.head||document.body).appendChild(style);
  }
  // Delegación de eventos: las filas de usuarios se recrean tras cargar auditoría.
  document.addEventListener('click',function(event){
    const btn=event.target.closest?.('[data-dv-drive-permission-user]');
    if(!btn)return;
    event.preventDefault();
    const uid=btn.getAttribute('data-dv-drive-permission-user');
    if(!uid)return;
    try{window.dvOpenUserDriveFolders(uid);}catch(error){
      console.error('[CARPETAS DRIVE] No se pudo abrir el editor',error);
      alert('No se pudo abrir Carpetas Drive: '+(error?.message||String(error)));
    }
  });
  function dvEnsureFolderEditor(){
    dvEnsureDrivePermissionsStyles();
    let modal=document.getElementById('dvUserDriveFoldersModal');
    if(modal)return modal;
    modal=document.createElement('div');
    modal.id='dvUserDriveFoldersModal';
    modal.className='dv-drive-permissions-overlay dv-hidden';
    modal.setAttribute('role','dialog');
    modal.setAttribute('aria-modal','true');
    modal.setAttribute('aria-labelledby','dvDrivePermissionsTitle');
    modal.innerHTML=`<div class="dv-drive-permissions-card">
      <div class="dv-drive-permissions-head"><div><p class="text-xs text-slate-500">ADMINISTRACIÓN · GOOGLE DRIVE</p><h3 id="dvDrivePermissionsTitle">Carpetas autorizadas</h3><p id="dvDrivePermissionsSubtitle" class="text-xs text-slate-500">Solo el administrador puede modificarlas.</p></div><button type="button" class="icon-btn" onclick="dvCloseUserDriveFolders()" aria-label="Cerrar"><i class="fa-solid fa-xmark"></i></button></div>
      <form id="dvDrivePermissionsForm" onsubmit="dvSaveUserDriveFolders(event)">
      <p class="dv-drive-permissions-note">Asigna hasta 5 enlaces de carpetas de Google Drive. Cada subordinado podrá navegar por esas carpetas y sus subcarpetas, sin entrar al ROOT general.</p>
      <div id="dvDrivePermissionsRows" class="dv-drive-permissions-rows"></div>
      <button type="button" class="secondary-btn" id="dvAddDrivePermission" onclick="dvAddUserDriveFolder()"><i class="fa-solid fa-plus"></i> Añadir enlace</button>
      <p id="dvDrivePermissionsFeedback" role="alert" aria-live="polite" class="text-xs"></p>
      <button type="button" class="secondary-btn dv-hidden" id="dvRetryDrivePermissions" onclick="dvReloadUserDriveFolders()"><i class="fa-solid fa-rotate-right"></i> Reintentar carga</button>
      <div class="dv-drive-permissions-actions"><button type="button" class="secondary-btn" onclick="dvCloseUserDriveFolders()">Cancelar</button><button type="submit" class="primary-btn" id="dvSaveDrivePermissions"><i class="fa-solid fa-floppy-disk"></i> Guardar permisos</button></div>
      </form></div>`;
    modal.addEventListener('click',event=>{if(event.target===modal)dvCloseUserDriveFolders();});
    document.body.appendChild(modal);
    return modal;
  }
  function dvDrawDrivePermissionRows(){
    const rows=document.getElementById('dvDrivePermissionsRows');if(!rows)return;
    rows.innerHTML=dvFolderEditorEntries.map((f,i)=>`<div class="dv-drive-permissions-row"><label class="field-label" for="dvDriveLink${i}">Carpeta ${i+1}${f.name?' · '+escapeHtml(f.name):''}</label><div class="dv-drive-permissions-input"><input id="dvDriveLink${i}" class="input-modern" type="url" required placeholder="https://drive.google.com/drive/folders/ID" value="${escapeHtml(f.url||'')}" oninput="dvUpdateUserDriveFolder(${i},this.value)"/><button type="button" class="icon-btn" title="Quitar" aria-label="Quitar carpeta ${i+1}" onclick="dvRemoveUserDriveFolder(${i})"><i class="fa-solid fa-trash-can"></i></button></div></div>`).join('')||'<p class="text-sm text-slate-500">Este usuario todavía no tiene carpetas asignadas.</p>';
    const add=document.getElementById('dvAddDrivePermission');
    if(add)add.disabled=dvFolderEditorLoading||dvFolderEditorEntries.length>=5;
  }
  function dvFolderEditorError(response,data){
    const detail=dvHttpErrorMessage(response,data,'No se pudo cargar o guardar la asignación.');
    const status=Number(response?.status||0);
    if(status===401)return 'Sesión expirada (401). Cierra sesión e ingresa de nuevo.';
    if(status===403)return 'Acceso denegado (403). Verifica que la cuenta administradora tenga app_metadata.rol = jefe en Supabase Auth.';
    if(status===404)return 'Función no disponible (404). Railway aún no está utilizando el main.py actualizado.';
    if(status===503)return `Servicio no disponible (503). ${detail} Comprueba la tabla public.user_drive_permissions y SUPABASE_SERVICE_ROLE_KEY.`;
    if(status===400)return `Enlace rechazado (400). ${detail} Usa la URL de una carpeta a la que acceda la cuenta de Drive conectada.`;
    return `Error HTTP ${status||'de conexión'}. ${detail}`;
  }
  window.dvCloseUserDriveFolders=function(){
    document.getElementById('dvUserDriveFoldersModal')?.classList.add('dv-hidden');
    dvFolderEditorUserId='';dvFolderEditorEntries=[];
  };
  window.dvAddUserDriveFolder=function(){
    if(dvFolderEditorLoading||dvFolderEditorEntries.length>=5)return;
    dvFolderEditorEntries.push({url:'',name:''});dvDrawDrivePermissionRows();
    document.getElementById('dvDriveLink'+(dvFolderEditorEntries.length-1))?.focus();
  };
  window.dvUpdateUserDriveFolder=function(i,value){if(dvFolderEditorEntries[i])dvFolderEditorEntries[i].url=value;};
  window.dvRemoveUserDriveFolder=function(i){
    if(dvFolderEditorLoading)return;
    dvFolderEditorEntries.splice(i,1);dvDrawDrivePermissionRows();
  };
  window.dvReloadUserDriveFolders=async function(){
    const id=dvFolderEditorUserId;if(!id)return;
    dvFolderEditorLoading=true;
    const add=document.getElementById('dvAddDrivePermission');
    const save=document.getElementById('dvSaveDrivePermissions');
    const retry=document.getElementById('dvRetryDrivePermissions');
    const feedback=document.getElementById('dvDrivePermissionsFeedback');
    if(add)add.disabled=true;
    if(save)save.disabled=true;
    if(retry)retry.classList.add('dv-hidden');
    if(feedback)feedback.textContent='Consultando carpetas asignadas…';
    const rows=document.getElementById('dvDrivePermissionsRows');
    if(rows)rows.innerHTML='<p class="text-xs text-slate-500">Cargando permisos…</p>';
    try{
      const res=await fetch(`${API_URL}/admin/users/${encodeURIComponent(id)}/drive-folders`,{headers:await authHeaders(false)});
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(dvFolderEditorError(res,data));
      if(dvFolderEditorUserId!==id)return;
      dvFolderEditorEntries=(Array.isArray(data.folders)?data.folders:[]).map(f=>({url:String(f.url||''),name:String(f.name||'')}));
      if(feedback)feedback.textContent=`Permisos cargados: ${dvFolderEditorEntries.length} de 5 carpetas.`;
      if(save)save.disabled=false;
    }catch(error){
      if(dvFolderEditorUserId!==id)return;
      dvFolderEditorEntries=[];
      if(rows)rows.innerHTML='';
      if(feedback)feedback.textContent=error?.message||'No se pudo consultar las carpetas.';
      if(retry)retry.classList.remove('dv-hidden');
    }finally{
      dvFolderEditorLoading=false;
      if(dvFolderEditorUserId===id && add && save && !save.disabled)dvDrawDrivePermissionRows();
    }
  };
  window.dvOpenUserDriveFolders=function(userId){
    if(!isAdmin()){toast('Solo un administrador puede modificar las carpetas.');return;}
    const u=adminUsersCache.find(x=>String(x.id)===String(userId));
    if(!u){toast('El usuario seleccionado no está en la lista. Actualiza Usuarios.');return;}
    dvFolderEditorUserId=String(userId);dvFolderEditorEntries=[];
    const modal=dvEnsureFolderEditor();modal.classList.remove('dv-hidden');
    document.getElementById('dvDrivePermissionsTitle').textContent='Carpetas de '+u.name;
    document.getElementById('dvDrivePermissionsSubtitle').textContent=u.email||'';
    dvReloadUserDriveFolders();
  };
  window.dvSaveUserDriveFolders=async function(event){
    event?.preventDefault();if(!dvFolderEditorUserId||!isAdmin()||dvFolderEditorLoading)return;
    const btn=document.getElementById('dvSaveDrivePermissions');
    const feedback=document.getElementById('dvDrivePermissionsFeedback');
    const id=dvFolderEditorUserId;
    const enlaces=dvFolderEditorEntries.map(f=>String(f.url||'').trim());
    if(enlaces.length>5||enlaces.some(v=>!v)){
      feedback.textContent='Ingresa enlaces válidos (máximo 5), o quita las filas vacías.';return;
    }
    try{
      for(const value of enlaces){
        const parsed=new URL(value);
        if(parsed.protocol!=='https:'||parsed.hostname!=='drive.google.com'){
          feedback.textContent='Debes pegar enlaces HTTPS de carpetas de Google Drive.';return;
        }
      }
    }catch(_){feedback.textContent='Hay un enlace mal escrito. Verifícalo antes de guardar.';return;}
    try{
      btn.disabled=true;feedback.textContent='Validando enlaces con Google Drive y guardando permisos…';
      const res=await fetch(`${API_URL}/admin/users/${encodeURIComponent(id)}/drive-folders`,{
        method:'PUT',headers:await authHeaders(true),body:JSON.stringify({folders:enlaces.map(url=>({url}))})
      });
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(dvFolderEditorError(res,data));
      const user=adminUsersCache.find(u=>u.id===id);
      if(user)user.driveFolderCount=(data.folders||[]).length;
      renderAdminUsers();dvCloseUserDriveFolders();toast('Carpetas autorizadas guardadas correctamente.');
    }catch(error){feedback.textContent=error?.message||'Error al guardar permisos.';}
    finally{if(btn)btn.disabled=false;}
  };

  window.deleteAdminUser=async function(userId){
    if(!isAdmin()||!userId)return;
    const user=adminUsersCache.find(u=>u.id===userId);
    if(!user)return;
    if(String(user.id)===String(currentUser?.id||'')){toast('No puedes eliminar tu propia cuenta.');return;}
    const label=user.name||user.email||'este usuario';
    if(!confirm(`¿Deseas eliminar definitivamente la cuenta de ${label}?\n\nEsta acción no se puede deshacer. Sus registros de auditoría se conservarán.`))return;
    try{
      const headers=await authHeaders(true);
      const res=await fetch(`${API_URL}/admin/users/${encodeURIComponent(userId)}`,{method:'DELETE',headers});
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(data?.detail || 'No se pudo eliminar el usuario.');
      document.getElementById('adminUserDetail')?.classList.add('hidden');
      toast('Usuario eliminado correctamente.');
      await loadAdminUsers();
    }catch(error){
      console.error('ELIMINAR USUARIO:',error);
      toast(error?.message || 'No se pudo eliminar el usuario.');
    }
  };
  window.openAdminUserDetail=function(key){
    const u=adminUsersCache.find(x=>x.key===key);if(!u)return;
    const box=document.getElementById('adminUserDetail');box.classList.remove('hidden');
    document.getElementById('adminUserDetailName').textContent=u.name;document.getElementById('adminUserDetailEmail').textContent=u.email||u.id||'—';
    document.getElementById('audUserTotal').textContent=u.rows.length;document.getElementById('audUserApproved').textContent=u.rows.filter(r=>r.estado==='APROBADO').length;document.getElementById('audUserPending').textContent=u.rows.filter(r=>r.estado==='PENDIENTE').length;document.getElementById('audUserRejected').textContent=u.rows.filter(r=>r.estado==='RECHAZADO').length;
    const body=document.getElementById('adminUserFilesBody');body.innerHTML=u.rows.slice(0,100).map(r=>`<tr><td>${escapeHtml(r.nombre_archivo||'Archivo')}</td><td>${escapeHtml(r.ruta_relativa||auditFolderName(r))}</td><td class="font-mono text-[9px]">${r.hash_sha256?escapeHtml(r.hash_sha256.slice(0,14))+'…':'N/A'}</td><td>${statusPill(r.estado)}</td><td>${formatShortDate(r.fecha_solicitud)}</td></tr>`).join('');
    adminUserFilter=key;
    box.scrollIntoView({behavior:'smooth',block:'start'});
  };
  window.closeAdminUserDetail=function(){document.getElementById('adminUserDetail')?.classList.add('hidden');};
  window.openAdminUserFiles=function(key){adminUserFilter=key;showView('gestor');setTimeout(()=>{const s=document.getElementById('adminFileUserFilter');if(s)s.value=key;loadFilesView();},0);};

  // =======================================================
  // REALTIME UNIFICADO
  // Una sola suscripción para auditoria_custodia.
  // Refresca Archivos, Mis solicitudes/Aprobaciones, Inicio y Usuarios
  // sin F5 ni cambiar de vista.
  // =======================================================
  let dvRealtimeTimer = null;
  let dvRealtimeBusy = false;
  let dvRealtimePending = false;

  async function refrescarSistemaRealtime(){
    // Agrupa INSERT/UPDATE múltiples del mismo lote en una sola actualización.
    clearTimeout(dvRealtimeTimer);
    dvRealtimeTimer = setTimeout(async()=>{
      if(dvRealtimeBusy){
        dvRealtimePending = true;
        return;
      }

      dvRealtimeBusy = true;
      try{
        // 1. Base común: auditoría + dashboard + datos del usuario actual.
        await loadAudit();

        // 2. Mis solicitudes / Aprobaciones.
        await loadCola();

        // 3. Si el explorador está abierto, reconstruir inventario y árbol.
        if(document.getElementById('view-gestor')?.classList.contains('active')){
          await loadFilesView();
          if(typeof dvRenderDynamicFolders === 'function') dvRenderDynamicFolders();
          if(typeof filterFiles === 'function') filterFiles();
        }

        // 4. Dashboard del rol actual.
        if(document.getElementById('view-inicio')?.classList.contains('active')){
          await loadRoleHome();
        }

        // 5. Panel de usuarios del administrador.
        if(isAdmin() && document.getElementById('view-usuarios')?.classList.contains('active')){
          await loadAdminUsers();
        }

        console.log('[DATAVAULT REALTIME] interfaz actualizada');
      }catch(err){
        console.error('[DATAVAULT REALTIME ERROR]', err);
      }finally{
        dvRealtimeBusy = false;
        if(dvRealtimePending){
          dvRealtimePending = false;
          refrescarSistemaRealtime();
        }
      }
    }, 250);
  }

  listenRealtime=function(){
    // Elimina canales viejos que otras versiones del HTML hayan creado.
    if(auditRealtimeChannel){
      try{supabaseClient.removeChannel(auditRealtimeChannel);}catch(_){}
      auditRealtimeChannel = null;
    }
    if(colaRealtimeChannel){
      try{supabaseClient.removeChannel(colaRealtimeChannel);}catch(_){}
      colaRealtimeChannel = null;
    }
    if(window.__dvRoleAuditChannel){
      try{supabaseClient.removeChannel(window.__dvRoleAuditChannel);}catch(_){}
      window.__dvRoleAuditChannel = null;
    }
    if(window.__dvRealtimeMainChannel) return;

    window.__dvRealtimeMainChannel = supabaseClient
      .channel('datavault_auditoria_realtime_v1')
      .on(
        'postgres_changes',
        {
          event:'*',
          schema:'public',
          table:'auditoria_custodia'
        },
        payload=>{
          console.log('[DATAVAULT REALTIME]', payload.eventType, payload.new || payload.old || '');
          refrescarSistemaRealtime();
        }
      )
      .subscribe(status=>{
        console.log('[DATAVAULT REALTIME STATUS]', status);
        // Estados normales: SUBSCRIBED, CHANNEL_ERROR, TIMED_OUT, CLOSED.
      });
  };

  // Refresco posterior al ingreso/sesión restaurada.
  const baseEnter=enterApp;
  enterApp=function(){
    baseEnter();
    applyRoleExperience();
    // baseEnter puede haber creado un canal anterior; aquí dejamos solo el unificado.
    setTimeout(async()=>{
      listenRealtime();
      await loadAudit();
      await loadCola();
      if(document.getElementById('view-gestor')?.classList.contains('active')) await loadFilesView();
      if(isAdmin()) await loadAdminUsers();
    },80);
  };

  // Limpieza correcta al cerrar sesión para que al volver a entrar no queden
  // suscripciones duplicadas.
  const roleLogoutBase=handleLogout;
  handleLogout=async function(){
    clearTimeout(dvRealtimeTimer);
    if(window.__dvRealtimeMainChannel){
      try{await supabaseClient.removeChannel(window.__dvRealtimeMainChannel);}catch(_){}
      window.__dvRealtimeMainChannel = null;
    }
    if(window.__dvRoleAuditChannel){
      try{await supabaseClient.removeChannel(window.__dvRoleAuditChannel);}catch(_){}
      window.__dvRoleAuditChannel = null;
    }
    return roleLogoutBase();
  };

  document.addEventListener('DOMContentLoaded',()=>{ensureAdminFileFilter();applyRoleExperience();});
  window.addEventListener('load',()=>setTimeout(applyRoleExperience,100));
})();


/* datavault-initial-hydration-fix */

/* =========================================================
   CARGA INICIAL ROBUSTA
   Realtime solo escucha CAMBIOS nuevos. Al abrir la app hay
   que hidratar primero los datos existentes de Supabase.
   Este bloque evita que Inicio se quede en 0 / "Cargando..."
   hasta cambiar de vista.
   ========================================================= */
(function(){
  const enterAnterior = window.enterApp || enterApp;
  let secuenciaEntrada = 0;
  let hidratando = false;

  function marcarInicioCargando(){
    document.querySelectorAll('#view-inicio .metric-value').forEach(el=>{
      el.textContent = '…';
    });
    const body=document.getElementById('inicioTableBody');
    if(body){
      body.innerHTML='<tr><td colspan="4" class="p-6 text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Cargando registros...</td></tr>';
    }
  }

  function inicioSigueCargando(){
    const body=document.getElementById('inicioTableBody');
    return !!body && /Cargando registros/i.test(body.textContent||'');
  }

  async function esperarSesionLista(){
    // getSession asegura que el cliente de Supabase ya tenga disponible
    // el JWT antes de consultar auditoria_custodia.
    for(let intento=0; intento<4; intento++){
      const {data,error}=await supabaseClient.auth.getSession();
      if(error) throw error;
      if(data?.session?.user){
        const usuario=data.session.user;
        if(!currentUser || currentUser.id!==usuario.id){
          setSessionFromUser(usuario);
        }
        if(typeof window.dvRoleNavbarFit === 'function') requestAnimationFrame(()=>window.dvRoleNavbarFit());
        return usuario;
      }
      await new Promise(r=>setTimeout(r,120));
    }
    throw new Error('No se encontró una sesión activa de Supabase.');
  }

  async function cargarEstadoInicial(seq){
    if(hidratando) return;
    hidratando=true;
    try{
      // Esperamos dos frames para que la vista Inicio y los KPIs ya existan
      // y estén visibles antes de escribir sus valores.
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      if(seq!==secuenciaEntrada) return;

      await esperarSesionLista();
      if(seq!==secuenciaEntrada) return;

      // IMPORTANTE: primero cargamos datos históricos.
      // loadAudit() también actualiza el dashboard del rol actual.
      await loadAudit();
      if(seq!==secuenciaEntrada) return;

      // Después construimos Mis solicitudes / Aprobaciones.
      await loadCola();
      if(seq!==secuenciaEntrada) return;

      // Si por alguna razón el usuario entró directamente al explorador.
      if(document.getElementById('view-gestor')?.classList.contains('active')){
        await loadFilesView();
      }

      // Realtime queda para los cambios que ocurran DESPUÉS de esta carga.
      if(typeof listenRealtime==='function') listenRealtime();

      console.log('[DATAVAULT INICIO] carga inicial completada');
    }catch(err){
      console.error('[DATAVAULT INICIO ERROR]',err);
      const body=document.getElementById('inicioTableBody');
      if(body && inicioSigueCargando()){
        body.innerHTML='<tr><td colspan="4" class="p-6 text-center text-red-400">No se pudieron cargar los datos iniciales.</td></tr>';
      }
    }finally{
      hidratando=false;
    }
  }

  // Sustituimos la entrada final, pero conservamos todo lo que ya hacía
  // el HTML (mostrar app, roles, navegación, etc.).
  window.enterApp = enterApp = function(){
    const seq=++secuenciaEntrada;

    // Ejecuta la lógica existente de entrada.
    enterAnterior();

    // En vez de mostrar 0 mientras llegan los datos, mostramos estado de carga.
    marcarInicioCargando();

    // Carga inmediata y ordenada.
    cargarEstadoInicial(seq);

    // Respaldo: si una consulta inicial fue interrumpida por el arranque de
    // sesión o por otra llamada simultánea, se reintenta una sola vez.
    setTimeout(()=>{
      if(seq===secuenciaEntrada && inicioSigueCargando()){
        cargarEstadoInicial(seq);
      }
    },900);
  };
})();


/* datavault-operations-v1 */

/* =========================================================
   OPERACIONES INTEGRADAS EN ARCHIVOS
   - Mover / Eliminar se solicitan desde Archivos.
   - El custodio aprueba por Telegram.
   - Google Drive ejecuta la operación.
   - Supabase actualiza y Realtime refresca la web.
   - Cambios manuales en Drive se reconcilian cada 10 s.
   ========================================================= */
(function(){
  let dvOpsRequestCache=[];
  let dvOpsUploadUnits=[];
  let dvOpsSyncTimer=null;
  let dvOpsSyncBusy=false;
  let dvCurrentMove=null;
  let dvMoveFolders=[];
  let dvMoveSelectedId='';
  let dvSourceOperationType='';
  let dvSourceOperationUnits=[];
  let dvDragSource=null;
  let dvDragFolders=[];
  let dvDragFoldersPromise=null;
  let dvDragMoveBusy=false;

  const norm=v=>String(v??'').trim().toLowerCase();
  const isAdmin=()=>['jefe','admin','administrador'].includes(norm(currentRole));
  const myUid=()=>String(currentUser?.id||'').trim();
  const rowMine=r=>{
    if(myUid() && String(r?.solicitante_id||'').trim()===myUid()) return true;
    if(currentUserEmail && norm(r?.solicitante_correo)===norm(currentUserEmail)) return true;
    return !!currentDisplayName && norm(r?.solicitante_nombre||r?.usuario_solicitante)===norm(currentDisplayName);
  };
  const deleted=r=>/^ELIMINADO/.test(String(r?.estado_archivo||'').toUpperCase());
  const rowState=r=>deleted(r)?'ELIMINADO':String(r?.estado||'PENDIENTE').toUpperCase();
  const groupState=rows=>{
    if(rows.some(deleted)) return rows.every(deleted)?'ELIMINADO':'PARCIAL';
    return typeof dvGroupState==='function'?dvGroupState(rows):String(rows?.[0]?.estado||'PENDIENTE').toUpperCase();
  };
  const stateClass=s=>{
    s=String(s||'').toUpperCase();
    if(s==='APROBADO')return 'status-approved';
    if(s==='PENDIENTE')return 'status-pending';
    return 'status-rejected';
  };
  // authHeaders global compartido por todos los módulos del frontend.

  function toast(msg){
    const old=document.getElementById('dvOpToast');if(old)old.remove();
    const el=document.createElement('div');el.id='dvOpToast';el.className='dv-op-toast';el.textContent=msg;document.body.appendChild(el);
    setTimeout(()=>el.remove(),3500);
  }

  function ensureTableHeader(){
    const tr=document.querySelector('#view-gestor .file-table-wrap thead tr');
    if(tr && !tr.querySelector('[data-dv-op-head]')){
      const th=document.createElement('th');th.dataset.dvOpHead='1';th.textContent='Acciones';tr.appendChild(th);
    }
    const loading=document.querySelector('#filesTableBody td[colspan="5"]');if(loading)loading.colSpan=6;
  }

  function ensureModal(){
    if(document.getElementById('dvOperationModal'))return;
    const modal=document.createElement('div');
    modal.id='dvOperationModal';modal.className='dv-hidden';
    modal.innerHTML=`<div class="dv-op-modal-card">
      <div class="dv-op-modal-head"><div><p class="text-[10px] uppercase tracking-widest text-slate-400 font-bold">Solicitud de movimiento</p><h3 class="text-lg font-extrabold text-slate-800 mt-1" id="dvMoveTitle">Mover elemento</h3><p class="text-xs text-slate-500 mt-1">Busca y selecciona una carpeta ya existente en Google Drive. El custodio deberá aprobar la operación.</p></div><button type="button" class="icon-btn" onclick="dvCloseMoveModal()"><i class="fa-solid fa-xmark"></i></button></div>
      <div class="dv-op-modal-body space-y-4">
        <div>
          <label class="field-label">Buscar carpeta destino</label>
          <div class="dv-folder-search"><i class="fa-solid fa-magnifying-glass"></i><input id="dvMoveSearch" class="input-modern w-full" placeholder="Ej. contratos, cliente A, proyectos..." autocomplete="off" oninput="dvFilterMoveFolders()"></div>
        </div>
        <div id="dvMoveFolderList" class="dv-folder-tree"><div class="p-4 text-center text-xs text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Cargando carpetas...</div></div>
        <div id="dvMoveSelection" class="dv-move-selection">Selecciona una carpeta de destino.</div>
        <div id="dvMoveMessage" class="text-xs text-slate-500"></div>
        <div class="flex justify-end gap-2"><button type="button" class="secondary-btn" onclick="dvCloseMoveModal()">Cancelar</button><button type="button" class="primary-btn" id="dvMoveSubmit" onclick="dvSubmitMoveRequest()" disabled><i class="fa-solid fa-paper-plane"></i>Solicitar movimiento</button></div>
      </div>
    </div>`;
    modal.addEventListener('click',e=>{if(e.target===modal)dvCloseMoveModal();});
    document.body.appendChild(modal);
  }

  window.dvCloseMoveModal=function(){
    document.getElementById('dvOperationModal')?.classList.add('dv-hidden');
    dvCurrentMove=null;dvMoveFolders=[];dvMoveSelectedId='';
  };

  function pendingOperation(kind,id){
    const target=String(id||'');
    return (dvOpsRequestCache||[]).find(r=>{
      if(String(r?.estado||'').toUpperCase()!=='PENDIENTE')return false;
      return kind==='CARPETA'
        ? String(r?.lote_id||'')===target
        : String(r?.auditoria_id||'')===target;
    })||null;
  }

  function ensureSourceOperationModal(){
    if(document.getElementById('dvSourceOperationModal'))return;
    const modal=document.createElement('div');
    modal.id='dvSourceOperationModal';modal.className='dv-hidden';
    modal.innerHTML=`<div class="dv-op-modal-card">
      <div class="dv-op-modal-head"><div><p class="text-[10px] uppercase tracking-widest text-slate-400 font-bold" id="dvSourceOperationKicker">Operación de archivo</p><h3 class="text-lg font-extrabold text-slate-800 mt-1" id="dvSourceOperationTitle">Seleccionar elemento</h3><p class="text-xs text-slate-500 mt-1" id="dvSourceOperationHelp">Selecciona un archivo o carpeta aprobada que ya exista en Google Drive.</p></div><button type="button" class="icon-btn" onclick="dvCloseSourceOperationModal()"><i class="fa-solid fa-xmark"></i></button></div>
      <div class="dv-op-modal-body space-y-4">
        <div><label class="field-label">Buscar archivo o carpeta</label><div class="dv-folder-search"><i class="fa-solid fa-magnifying-glass"></i><input id="dvSourceOperationSearch" class="input-modern w-full" placeholder="Buscar por nombre o ubicación..." autocomplete="off" oninput="dvFilterSourceOperations()"></div></div>
        <div id="dvSourceOperationList" class="dv-source-list"><div class="p-4 text-center text-xs text-slate-400">Cargando elementos...</div></div>
        <div class="text-[9px] text-slate-400"><i class="fa-solid fa-shield-halved mr-1"></i>Solo se muestran elementos aprobados y vinculados a Google Drive. La operación se ejecutará únicamente después de la aprobación del custodio.</div>
      </div>
    </div>`;
    modal.addEventListener('click',e=>{if(e.target===modal)dvCloseSourceOperationModal();});
    document.body.appendChild(modal);
  }

  window.dvCloseSourceOperationModal=function(){
    document.getElementById('dvSourceOperationModal')?.classList.add('dv-hidden');
    dvSourceOperationType='';dvSourceOperationUnits=[];
  };

  function dvBuildSourceOperationUnits(){
    const all=(auditCache||[]).filter(rowMine);
    return dvGroupedUnits(all).map(u=>{
      if(u.type==='folder'){
        const rows=u.rows||[];const r=rows[0]||{};
        const approved=rows.length>0&&rows.every(x=>String(x?.estado||'').toUpperCase()==='APROBADO')&&!rows.some(deleted);
        const linked=!!String(r?.drive_folder_id||'').trim();
        return {kind:'CARPETA',id:String(u.id||''),name:dvRoot(r)||'Carpeta',location:r?.ubicacion_drive||'DRIVE PROYECTO',count:rows.length,approved,linked,pending:pendingOperation('CARPETA',u.id)};
      }
      const r=u.row||{};
      const approved=String(r?.estado||'').toUpperCase()==='APROBADO'&&!deleted(r);
      const linked=!!String(r?.drive_file_id||'').trim();
      return {kind:'ARCHIVO',id:String(r?.id||''),name:r?.nombre_archivo||'Archivo',location:r?.ubicacion_drive||'DRIVE PROYECTO',count:1,approved,linked,pending:pendingOperation('ARCHIVO',r?.id)};
    }).filter(u=>u.approved&&u.linked);
  }

  function dvRenderSourceOperationUnits(){
    const list=document.getElementById('dvSourceOperationList');if(!list)return;
    const q=norm(document.getElementById('dvSourceOperationSearch')?.value||'');
    const units=(dvSourceOperationUnits||[]).map((u,index)=>({u,index})).filter(item=>!q||norm(`${item.u.name} ${item.u.location}`).includes(q));
    if(!units.length){list.innerHTML='<div class="p-5 text-center text-xs text-slate-400"><i class="fa-solid fa-box-open mr-2"></i>No hay archivos o carpetas aprobadas disponibles.</div>';return;}
    list.innerHTML=units.map(item=>{
      const u=item.u;const i=item.index;
      const blocked=!!u.pending;
      const pendingText=blocked?(String(u.pending?.tipo_operacion||'').toUpperCase()==='MOVER'?'Movimiento pendiente':'Eliminación pendiente'):'';
      return `<button type="button" class="dv-source-option" data-dv-source-index="${i}" ${blocked?'disabled':''}>
        <span class="source-icon"><i class="fa-solid ${u.kind==='CARPETA'?'fa-folder text-amber-500':dvIconFor(u.name)+' text-blue-400'}"></i></span>
        <span class="source-main"><span class="source-name">${escapeHtml(u.name)}</span><span class="source-meta">${escapeHtml(u.location)}${u.kind==='CARPETA'?` · ${u.count} archivo(s)`:''}</span></span>
        ${blocked?`<span class="source-note"><i class="fa-solid fa-clock mr-1"></i>${escapeHtml(pendingText)}</span>`:`<i class="fa-solid fa-chevron-right text-slate-300"></i>`}
      </button>`;
    }).join('');
    list.querySelectorAll('[data-dv-source-index]:not(:disabled)').forEach(btn=>btn.addEventListener('click',()=>dvChooseSourceOperation(Number(btn.dataset.dvSourceIndex))));
  }

  window.dvFilterSourceOperations=function(){dvRenderSourceOperationUnits();};

  window.dvChooseSourceOperation=async function(index){
    const u=dvSourceOperationUnits[index];if(!u||u.pending)return;
    const op=dvSourceOperationType;
    dvCloseSourceOperationModal();
    if(op==='MOVER')return dvRequestMove(u.kind,u.id);
    if(op==='ELIMINAR')return dvRequestDelete(u.kind,u.id);
  };

  window.dvOpenSourceOperation=async function(type){
    if(isAdmin())return;
    const op=String(type||'').toUpperCase();
    if(!['MOVER','ELIMINAR'].includes(op))return;
    try{
      if(typeof loadFilesView==='function')await loadFilesView();
      ensureSourceOperationModal();
      dvSourceOperationType=op;
      dvSourceOperationUnits=dvBuildSourceOperationUnits();
      const modal=document.getElementById('dvSourceOperationModal');modal.classList.remove('dv-hidden');
      const search=document.getElementById('dvSourceOperationSearch');if(search)search.value='';
      document.getElementById('dvSourceOperationKicker').textContent=op==='MOVER'?'Solicitud de movimiento':'Solicitud de eliminación';
      document.getElementById('dvSourceOperationTitle').textContent=op==='MOVER'?'¿Qué quieres mover?':'¿Qué quieres eliminar?';
      document.getElementById('dvSourceOperationHelp').textContent=op==='MOVER'?'Selecciona un archivo o carpeta aprobada; después elegirás la carpeta destino.':'Selecciona el archivo o carpeta aprobada que quieres enviar a la papelera de Google Drive.';
      dvRenderSourceOperationUnits();
    }catch(err){alert('No se pudieron cargar tus archivos: '+(err?.message||err));}
  };

  window.dvActivateFileOperation=function(type){
    if(isAdmin())return;
    const op=String(type||'').toUpperCase();
    if(op==='SUBIR'){
      const zone=document.getElementById('dropZone');
      if(zone)zone.scrollIntoView({behavior:'smooth',block:'center'});
      return;
    }
    return dvOpenSourceOperation(op);
  };

  function dvCanDragMove(kind,id,rowsOrRow){
    if(isAdmin())return false;
    const rows=Array.isArray(rowsOrRow)?rowsOrRow:[rowsOrRow];
    const approved=rows.length>0 && rows.every(r=>String(r?.estado||'').toUpperCase()==='APROBADO') && !rows.some(deleted);
    const linked=kind==='CARPETA' ? !!String(rows[0]?.drive_folder_id||'').trim() : !!String(rows[0]?.drive_file_id||'').trim();
    return approved && linked && !pendingOperation(kind,id);
  }

  function dvDragAttrs(kind,id,rowsOrRow){
    if(!dvCanDragMove(kind,id,rowsOrRow))return '';
    return `draggable="true" data-dv-drag-kind="${kind}" data-dv-drag-id="${escapeHtml(String(id||''))}" title="Arrastra para mover"`;
  }

  function operationButtons(kind, id, rowsOrRow){
    if(isAdmin()) return '<span class="dv-op-legacy">Supervisión</span>';
    const rows=Array.isArray(rowsOrRow)?rowsOrRow:[rowsOrRow];
    const approved=rows.every(r=>String(r?.estado||'').toUpperCase()==='APROBADO') && !rows.some(deleted);
    const linked=kind==='CARPETA' ? !!String(rows[0]?.drive_folder_id||'').trim() : !!String(rows[0]?.drive_file_id||'').trim();
    const pending=pendingOperation(kind,id);
    if(pending){
      const label=String(pending.tipo_operacion||'').toUpperCase()==='MOVER'?'Movimiento pendiente':'Eliminación pendiente';
      return `<span class="dv-op-pending"><i class="fa-solid fa-clock"></i>${escapeHtml(label)}</span>`;
    }
    if(rows.some(deleted)) return '<span class="dv-op-legacy">Eliminación aprobada</span>';
    if(!approved) return '<span class="dv-op-legacy">'+(rows.some(r=>String(r.estado).toUpperCase()==='RECHAZADO')?'Solicitud rechazada':'Pendiente de aprobación')+'</span>';
    if(!linked) return '<span class="dv-op-legacy" title="Registro histórico sin ID de Drive">Sin vínculo Drive</span>';
    const safe=escapeHtml(String(id));
    return `<div class="dv-op-actions"><button type="button" class="dv-op-btn" title="Mover" aria-label="Mover" onclick="event.stopPropagation();dvRequestMove('${kind}','${safe}')"><i class="fa-solid fa-folder-tree"></i><span>Mover</span></button><button type="button" class="dv-op-btn delete" title="Eliminar" aria-label="Eliminar" onclick="event.stopPropagation();dvRequestDelete('${kind}','${safe}')"><i class="fa-solid fa-trash-can"></i><span>Eliminar</span></button></div>`;
  }

  function opsLooseRow(r){
    const display=rowState(r);
    return `<tr class="${dvCanDragMove('ARCHIVO',r.id,r)?'dv-draggable-row':''}" ${dvDragAttrs('ARCHIVO',r.id,r)}><td><div class="flex items-center gap-2"><div class="h-7 w-7 rounded-md bg-[#edf3f5] text-[#6c8698] flex items-center justify-center"><i class="fa-solid ${dvIconFor(r.nombre_archivo)} text-[10px]"></i></div><div><p class="font-semibold text-[#1f2b31] text-[9px]">${escapeHtml(r.nombre_archivo||'Sin nombre')}</p><p class="dv-unit-sub">${escapeHtml(r.solicitante_nombre||r.usuario_solicitante||'—')}</p></div></div></td><td class="text-[8px] text-slate-500">${escapeHtml(r.ubicacion_drive||'Archivo suelto')}</td><td><span class="integrity-ok"><i class="fa-solid fa-fingerprint"></i> Verificado</span></td><td><span class="status-pill ${stateClass(display)}">${escapeHtml(display)}</span></td><td class="text-[8px] text-slate-400">${dvDate(r.fecha_ultima_operacion||r.fecha_solicitud)}</td><td>${operationButtons('ARCHIVO',r.id,r)}</td></tr>`;
  }

  function opsFolderRows(rows,loteId){
    const root=dvRoot(rows[0])||'Carpeta';const total=rows.reduce((s,r)=>s+Number(r.tamano_bytes||0),0);const state=groupState(rows);const id=dvFolderDetailId(loteId);const tree=dvBuildTree(rows);const last=rows.map(r=>r.fecha_ultima_operacion||r.fecha_solicitud||'').sort().reverse()[0];
    const driveFolderId=String(rows[0]?.drive_folder_id||'').trim();
    const dropAttrs=driveFolderId?`data-dv-drop-folder-id="${escapeHtml(driveFolderId)}" data-dv-drop-folder-path="${escapeHtml(rows[0]?.ubicacion_drive||root)}"`:'';
    return `<tr class="dv-folder-summary${dvCanDragMove('CARPETA',loteId,rows)?' dv-draggable-row':''}" ${dvDragAttrs('CARPETA',loteId,rows)} ${dropAttrs}><td><button class="dv-folder-toggle" onclick="toggleDvFolder('${escapeHtml(String(loteId))}')"><span class="dv-caret" id="${id}-icon">▶</span><i class="fa-solid fa-folder text-amber-500"></i><span>${escapeHtml(root)}</span><span class="dv-folder-chip">${rows.length} archivo(s)</span></button></td><td class="text-[8px] text-slate-500">${escapeHtml(rows[0]?.ubicacion_drive||'Carpeta / lote')}</td><td><span class="integrity-ok"><i class="fa-solid fa-fingerprint"></i> ${formatBytes(total)}</span></td><td><span class="status-pill ${stateClass(state)}">${escapeHtml(state)}</span></td><td class="text-[8px] text-slate-400">${dvDate(last)}</td><td>${operationButtons('CARPETA',loteId,rows)}</td></tr><tr id="${id}" class="hidden dv-folder-detail"><td colspan="6"><div class="dv-folder-panel"><div class="flex flex-wrap justify-between gap-2 mb-2"><div><b class="text-[11px] text-slate-700"><i class="fa-solid fa-folder-open mr-2 text-amber-500"></i>${escapeHtml(root)}</b><div class="text-[8px] text-slate-400 mt-1">Lote ${escapeHtml(String(loteId))}</div></div><span class="text-[9px] text-slate-500">${rows.length} archivo(s) · ${formatBytes(total)}</span></div><div class="dv-tree">${dvRenderTree(tree)}</div></div></td></tr>`;
  }

  // Inventario del subordinado y del administrador: 10 unidades por página.
  // La paginación se aplica DESPUÉS de agrupar para no dividir las carpetas.
  renderFilesTable=function(rows){
    ensureTableHeader();
    const body=document.getElementById('filesTableBody');if(!body)return;
    const allUnits=dvGroupedUnits(rows||[]);
    const count=document.getElementById('fileCountLabel');
    if(count)count.textContent=`${allUnits.length} unidad${allUnits.length===1?'':'es'} visuales · ${(rows||[]).length} archivo(s)`;
    const pagerKey=isAdmin()?'adminFiles':'files';
    // Al cerrar sesión y entrar con otro rol, no dejar visible su paginación.
    document.getElementById(`dv-pages-${isAdmin()?'files':'adminFiles'}`)?.remove();
    const previousPager=document.getElementById(`dv-pages-${pagerKey}`);
    if(!allUnits.length){
      previousPager?.remove();
      body.innerHTML='<tr><td colspan="6" class="p-8 text-center text-slate-400">No hay archivos registrados.</td></tr>';
      return;
    }
    let visibleUnits=allUnits;
    if(typeof window.dvSubPage==='function'){
      const search=(document.getElementById('fileSearch')?.value||'').trim().toLowerCase();
      const selected=(document.getElementById('fileFolderFilter')?.value||'');
      // Reiniciar a la primera página al cambiar carpeta, búsqueda o usuario filtrado.
      // El filtro del administrador pertenece a otro módulo: leer su valor del DOM.
      const adminSelection=isAdmin()?(document.getElementById('adminFileUserFilter')?.value||''):'';
      const filterSignature=[dvExplorerFolder||'',selected,search,adminSelection].join('|');
      visibleUnits=window.dvSubPage(allUnits,pagerKey,filterSignature,body,()=>renderFilesTable(rows));
      document.getElementById(`dv-pages-${pagerKey}`)?.setAttribute('aria-label',
        isAdmin()?'Páginas del explorador de archivos':'Páginas de mis archivos');
    }else{
      // Conservar la tabla disponible incluso si el script de paginación no cargó.
      previousPager?.remove();
    }
    body.innerHTML=visibleUnits.map(u=>u.type==='folder'?opsFolderRows(u.rows,u.id):opsLooseRow(u.row)).join('');
  };

  // Papelera muestra eliminados. El resto del explorador oculta eliminados.
  filterFiles=function(){
    const q=(document.getElementById('fileSearch')?.value||'').toLowerCase().trim();
    let rows=(auditCache||[]).filter(r=>!q||[r.nombre_archivo,r.solicitante_nombre,r.usuario_solicitante,r.hash_sha256,r.ruta_relativa,r.ubicacion_drive].some(v=>String(v||'').toLowerCase().includes(q)));
    if(dvExplorerFolder==='__TRASH__') rows=rows.filter(deleted);
    else {
      rows=rows.filter(r=>!deleted(r));
      if(dvExplorerFolder==='__SHARED__' && typeof isSharedFile==='function')rows=rows.filter(isSharedFile);
      else if(dvExplorerFolder)rows=rows.filter(r=>dvRoot(r)===dvExplorerFolder);
    }
    renderFilesTable(rows);
  };

  function dvFindDragFolder(folderId){
    return (dvDragFolders||[]).find(f=>String(f?.id||'')===String(folderId||''))||null;
  }

  async function dvEnsureDragFolders(){
    if(dvDragFolders.length)return dvDragFolders;
    if(dvDragFoldersPromise)return dvDragFoldersPromise;
    dvDragFoldersPromise=(async()=>{
      const data=await window.DVDriveBrowser.fetchFolder('root',false);
      const current=data?.current||data?.root||{};
      const rootPath=String(current?.path||current?.name||'Mi unidad');
      const rootFolder={
        id:String(current?.id||''),
        name:String(current?.name||'Mi unidad'),
        path:rootPath,
        parent_id:current?.parent_id||null,
        depth:0,
        ancestors:[],
        root:true
      };
      const children=(Array.isArray(data?.folders)?data.folders:[]).map(folder=>({
        ...folder,
        path:`${rootPath} / ${String(folder?.name||'Carpeta')}`,
        depth:1,
        ancestors:[String(current?.id||'')],
        root:false
      }));
      dvDragFolders=[rootFolder,...children].filter(f=>f.id);
      return dvDragFolders;
    })().finally(()=>{dvDragFoldersPromise=null;});
    return dvDragFoldersPromise;
  }

  function dvDragRestriction(source,folder){
    if(!source||!folder)return 'Destino no disponible';
    const folderId=String(folder?.id||'');
    if(!folderId)return 'Destino no disponible';
    if(source.currentParent && folderId===String(source.currentParent))return 'Ya está en esta carpeta';
    if(source.kind==='CARPETA'){
      if(source.driveId && folderId===String(source.driveId))return 'No puedes mover una carpeta dentro de sí misma';
      const ancestors=Array.isArray(folder?.ancestors)?folder.ancestors.map(String):[];
      if(source.driveId && ancestors.includes(String(source.driveId)))return 'No puedes moverla dentro de una subcarpeta propia';
    }
    return '';
  }

  function dvClearDropHighlights(){
    document.querySelectorAll('#view-gestor .dv-drop-target-active,#view-gestor .dv-drop-target-blocked').forEach(el=>el.classList.remove('dv-drop-target-active','dv-drop-target-blocked'));
  }

  function dvRestoreDragSidebar(){
    const rootBtn=document.querySelector('#view-gestor [data-folder=""]');
    if(rootBtn){rootBtn.removeAttribute('data-dv-drop-folder-id');rootBtn.removeAttribute('data-dv-drop-folder-path');}
    const label=document.querySelector('#view-gestor .tree-folder span');
    if(label)label.textContent='Carpetas';
    if(typeof dvRenderDynamicFolders==='function')dvRenderDynamicFolders();
  }

  function dvRenderDragDestinations(){
    if(!dvDragSource)return;
    const box=document.getElementById('dynamicFolderTree');
    if(!box)return;
    const rootFolder=(dvDragFolders||[]).find(f=>f?.root || Number(f?.depth||0)===0);
    const rootBtn=document.querySelector('#view-gestor [data-folder=""]');
    if(rootBtn && rootFolder){
      rootBtn.dataset.dvDropFolderId=String(rootFolder.id||'');
      rootBtn.dataset.dvDropFolderPath=String(rootFolder.path||rootFolder.name||'DRIVE PROYECTO');
    }
    const label=document.querySelector('#view-gestor .tree-folder span');
    if(label)label.textContent='Suelta en una carpeta';
    const folders=(dvDragFolders||[]).filter(f=>!(f?.root || Number(f?.depth||0)===0));
    const rows=folders.map(f=>{
      const depth=Math.min(Math.max(Number(f?.depth||1)-1,0),7);
      const restriction=dvDragRestriction(dvDragSource,f);
      return `<button type="button" class="tree-subitem${restriction?' dv-drop-target-blocked':''}" data-dv-drop-folder-id="${escapeHtml(String(f?.id||''))}" data-dv-drop-folder-path="${escapeHtml(String(f?.path||f?.name||'Carpeta'))}" style="padding-left:${14+(depth*15)}px!important" title="${escapeHtml(restriction||('Mover a '+String(f?.path||f?.name||'Carpeta')))}"><i class="fa-solid fa-folder"></i><span class="truncate">${escapeHtml(f?.name||'Carpeta')}</span></button>`;
    }).join('');
    box.innerHTML=`<div class="dv-drag-destination-note"><i class="fa-solid fa-hand-pointer mr-1"></i>Suelta el elemento sobre el destino</div>${rows||'<p class="tree-subitem text-slate-400">No hay carpetas destino</p>'}`;
  }

  async function dvSubmitDraggedMove(source,folder){
    if(dvDragMoveBusy||!source||!folder)return;
    const restriction=dvDragRestriction(source,folder);
    if(restriction){toast(restriction);return;}
    dvDragMoveBusy=true;
    try{
      const payload={tipo_operacion:'MOVER',objeto_tipo:source.kind,carpeta_destino_id:String(folder.id)};
      if(source.kind==='CARPETA')payload.lote_id=source.id;else payload.auditoria_id=source.id;
      const res=await fetch(`${API_URL}/operations/request`,{method:'POST',headers:await authHeaders(),body:JSON.stringify(payload)});
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(dvHttpErrorMessage(res,data));
      toast(`Solicitud para mover “${source.name}” a “${folder.path||folder.name||'carpeta'}” enviada al custodio.`);
      await loadCola();
      if(typeof loadFilesView==='function')await loadFilesView();
    }catch(err){
      alert('No se pudo solicitar el movimiento: '+(err?.message||err));
    }finally{
      dvDragMoveBusy=false;
    }
  }

  document.addEventListener('dragstart',e=>{
    const row=e.target.closest?.('#view-gestor [data-dv-drag-kind][data-dv-drag-id]');
    if(!row)return;
    if(e.target.closest?.('button,a,input,select,textarea')){e.preventDefault();return;}
    if(isAdmin()){e.preventDefault();return;}
    const source=dvMoveContext(row.dataset.dvDragKind,row.dataset.dvDragId);
    if(!source?.driveId){e.preventDefault();return;}
    dvDragSource=source;
    row.classList.add('dv-dragging');
    document.getElementById('view-gestor')?.classList.add('dv-drag-mode');
    try{
      e.dataTransfer.effectAllowed='move';
      e.dataTransfer.setData('application/x-datavault-item',JSON.stringify({kind:source.kind,id:source.id}));
      e.dataTransfer.setData('text/plain',source.name||'DataVault');
    }catch(_){ }
    dvEnsureDragFolders().then(()=>{if(dvDragSource)dvRenderDragDestinations();}).catch(err=>{console.warn('[DRAG MOVE DESTINATIONS]',err);toast('No se pudieron cargar las carpetas destino.');});
  });

  document.addEventListener('dragover',e=>{
    if(!dvDragSource)return;
    const target=e.target.closest?.('#view-gestor [data-dv-drop-folder-id]');
    if(!target)return;
    const folderId=target.dataset.dvDropFolderId;
    const folder=dvFindDragFolder(folderId)||{id:folderId,path:target.dataset.dvDropFolderPath||'Carpeta',name:target.dataset.dvDropFolderPath||'Carpeta',ancestors:[]};
    dvClearDropHighlights();
    const restriction=dvDragRestriction(dvDragSource,folder);
    if(restriction){target.classList.add('dv-drop-target-blocked');if(e.dataTransfer)e.dataTransfer.dropEffect='none';return;}
    e.preventDefault();
    target.classList.add('dv-drop-target-active');
    if(e.dataTransfer)e.dataTransfer.dropEffect='move';
  });

  document.addEventListener('dragleave',e=>{
    if(!dvDragSource)return;
    const target=e.target.closest?.('#view-gestor [data-dv-drop-folder-id]');
    if(!target)return;
    if(e.relatedTarget && target.contains(e.relatedTarget))return;
    target.classList.remove('dv-drop-target-active');
  });

  document.addEventListener('drop',async e=>{
    if(!dvDragSource)return;
    const target=e.target.closest?.('#view-gestor [data-dv-drop-folder-id]');
    if(!target)return;
    e.preventDefault();
    e.stopPropagation();
    const source=dvDragSource;
    try{await dvEnsureDragFolders();}catch(err){toast('No se pudieron validar las carpetas destino.');return;}
    const folderId=target.dataset.dvDropFolderId;
    const folder=dvFindDragFolder(folderId)||{id:folderId,path:target.dataset.dvDropFolderPath||'Carpeta',name:target.dataset.dvDropFolderPath||'Carpeta',ancestors:[]};
    const restriction=dvDragRestriction(source,folder);
    if(restriction){toast(restriction);return;}
    dvClearDropHighlights();
    await dvSubmitDraggedMove(source,folder);
  });

  document.addEventListener('dragend',e=>{
    const row=e.target.closest?.('#view-gestor [data-dv-drag-kind][data-dv-drag-id]');
    if(row)row.classList.remove('dv-dragging');
    if(!dvDragSource)return;
    dvDragSource=null;
    dvClearDropHighlights();
    document.getElementById('view-gestor')?.classList.remove('dv-drag-mode');
    dvRestoreDragSidebar();
  });

  function dvMoveContext(kind,id){
    const target=String(id||'');
    if(kind==='CARPETA'){
      const rows=(auditCache||[]).filter(r=>String(r?.lote_id||'')===target);
      const r=rows[0]||{};
      return {
        kind,id:target,
        name:dvRoot(r)||'Carpeta',
        driveId:String(r?.drive_folder_id||''),
        currentParent:String(r?.drive_parent_id||'')
      };
    }
    const r=(auditCache||[]).find(x=>String(x?.id||'')===target)||{};
    return {
      kind,id:target,
      name:r?.nombre_archivo||'Archivo',
      driveId:String(r?.drive_file_id||''),
      currentParent:String(r?.drive_parent_id||'')
    };
  }

  function dvMoveFolderRestriction(folder){
    if(!dvCurrentMove)return '';
    const folderId=String(folder?.id||'');
    if(folderId && dvCurrentMove.currentParent && folderId===dvCurrentMove.currentParent)return 'Ubicación actual';
    if(dvCurrentMove.kind==='CARPETA'){
      if(folderId && folderId===dvCurrentMove.driveId)return 'Es la misma carpeta';
      const ancestors=Array.isArray(folder?.ancestors)?folder.ancestors.map(String):[];
      if(dvCurrentMove.driveId && ancestors.includes(dvCurrentMove.driveId))return 'Está dentro de la carpeta que mueves';
    }
    return '';
  }

  function dvRenderMoveFolders(){
    const list=document.getElementById('dvMoveFolderList');if(!list)return;
    const q=norm(document.getElementById('dvMoveSearch')?.value||'');
    const folders=(dvMoveFolders||[]).filter(f=>!q||norm(`${f?.name||''} ${f?.path||''}`).includes(q));
    if(!folders.length){
      list.innerHTML='<div class="p-5 text-center text-xs text-slate-400"><i class="fa-solid fa-folder-open mr-2"></i>No se encontraron carpetas.</div>';
      return;
    }
    list.innerHTML=folders.map(f=>{
      const restriction=dvMoveFolderRestriction(f);
      const selected=String(f?.id||'')===String(dvMoveSelectedId||'');
      const depth=Math.min(Number(f?.depth||0),8);
      const path=String(f?.path||f?.name||'Carpeta');
      const pathSecondary=Number(f?.depth||0)>0?path:'Carpeta raíz autorizada';
      return `<button type="button" class="dv-folder-option${selected?' selected':''}${restriction?' disabled':''}" data-dv-folder-id="${escapeHtml(String(f?.id||''))}" ${restriction?'disabled':''} style="padding-left:${9+(depth*15)}px" title="${escapeHtml(restriction||path)}">
        <i class="fa-solid ${Number(f?.depth||0)===0?'fa-hard-drive':'fa-folder'} text-amber-500"></i>
        <span class="folder-main"><span class="folder-name">${escapeHtml(f?.name||'Carpeta')}</span><span class="folder-path">${escapeHtml(pathSecondary)}</span></span>
        ${restriction?`<span class="folder-note">${escapeHtml(restriction)}</span>`:''}
      </button>`;
    }).join('');
    list.querySelectorAll('[data-dv-folder-id]:not(:disabled)').forEach(btn=>btn.addEventListener('click',()=>dvSelectMoveFolder(btn.dataset.dvFolderId)));
  }

  window.dvFilterMoveFolders=function(){dvRenderMoveFolders();};

  window.dvSelectMoveFolder=function(folderId){
    const folder=(dvMoveFolders||[]).find(f=>String(f?.id||'')===String(folderId||''));
    if(!folder || dvMoveFolderRestriction(folder))return;
    dvMoveSelectedId=String(folder.id||'');
    dvRenderMoveFolders();
    const box=document.getElementById('dvMoveSelection');
    if(box)box.innerHTML=`Destino seleccionado:<br><strong><i class="fa-solid fa-folder mr-1 text-amber-500"></i>${escapeHtml(folder.path||folder.name||'Carpeta')}</strong>`;
    const btn=document.getElementById('dvMoveSubmit');if(btn)btn.disabled=false;
  };

  window.dvRequestMove=async function(kind,id){
    try{
      ensureModal();
      dvCurrentMove=dvMoveContext(kind,id);dvMoveFolders=[];dvMoveSelectedId='';
      const modal=document.getElementById('dvOperationModal');modal.classList.remove('dv-hidden');
      document.getElementById('dvMoveTitle').textContent=`Mover ${kind==='CARPETA'?'carpeta':'archivo'}: ${dvCurrentMove.name}`;
      const search=document.getElementById('dvMoveSearch');if(search)search.value='';
      const list=document.getElementById('dvMoveFolderList');if(list)list.innerHTML='<div class="p-4 text-center text-xs text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Cargando carpetas...</div>';
      const selection=document.getElementById('dvMoveSelection');if(selection)selection.textContent='Selecciona una carpeta de destino.';
      const submit=document.getElementById('dvMoveSubmit');if(submit)submit.disabled=true;
      document.getElementById('dvMoveMessage').textContent='Consultando carpetas y subcarpetas disponibles en Drive...';
      const res=await fetch(`${API_URL}/drive-folders`,{headers:await authHeaders(false)});
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(data.detail||`Error HTTP ${res.status}`);
      dvMoveFolders=(Array.isArray(data.folders)?data.folders:[]).slice().sort((a,b)=>{
        if(Boolean(a?.root)!==Boolean(b?.root))return a?.root?-1:1;
        return String(a?.path||a?.name||'').localeCompare(String(b?.path||b?.name||''),'es',{numeric:true,sensitivity:'base'});
      });
      dvRenderMoveFolders();
      document.getElementById('dvMoveMessage').textContent='Solo se enviará la solicitud. Google Drive cambiará cuando el custodio la apruebe por Telegram.';
    }catch(err){dvCloseMoveModal();alert('No se pudieron cargar los destinos: '+(err.message||err));}
  };

  window.dvSubmitMoveRequest=async function(){
    if(!dvCurrentMove)return;
    const btn=document.getElementById('dvMoveSubmit');
    if(!dvMoveSelectedId){toast('Selecciona primero una carpeta de destino.');return;}
    try{
      btn.disabled=true;btn.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i> Enviando...';
      const payload={tipo_operacion:'MOVER',objeto_tipo:dvCurrentMove.kind,carpeta_destino_id:dvMoveSelectedId};
      if(dvCurrentMove.kind==='CARPETA')payload.lote_id=dvCurrentMove.id;else payload.auditoria_id=dvCurrentMove.id;
      const res=await fetch(`${API_URL}/operations/request`,{method:'POST',headers:await authHeaders(),body:JSON.stringify(payload)});
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(dvHttpErrorMessage(res,data));
      dvCloseMoveModal();toast('Solicitud de movimiento enviada al custodio.');await loadCola();
      if(typeof loadFilesView==='function')await loadFilesView();
    }catch(err){alert('No se pudo solicitar el movimiento: '+(err.message||err));}
    finally{if(btn){btn.disabled=!dvMoveSelectedId;btn.innerHTML='<i class="fa-solid fa-paper-plane"></i>Solicitar movimiento';}}
  };

  window.dvRequestDelete=async function(kind,id){
    const item=dvMoveContext(kind,id);
    const esCarpeta=kind==='CARPETA';
    const titulo=esCarpeta?'Solicitar eliminación de carpeta':'Solicitar eliminación de archivo';
    const nombre=item?.name|| (esCarpeta?'Carpeta seleccionada':'Archivo seleccionado');
    const origen=item?.location||item?.currentPath||'DRIVE PROYECTO';

    const confirmado=await dvShowDecisionModal({
      mode:'reject',
      title:titulo,
      subtitle:'Solicitud de eliminación',
      message:`¿Deseas solicitar la eliminación de ${esCarpeta?'esta carpeta':'este archivo'}?`,
      detail:`${esCarpeta?'📁 Carpeta':'📄 Archivo'}: ${nombre}
📂 Ubicación actual: ${origen}
ℹ️ El custodio deberá aprobar la operación antes de enviarla a la papelera de Google Drive.`,
      confirmText:'Solicitar eliminación',
      cancelText:'Cancelar'
    });

    if(!confirmado)return;

    try{
      const payload={tipo_operacion:'ELIMINAR',objeto_tipo:kind};
      if(kind==='CARPETA')payload.lote_id=id;else payload.auditoria_id=id;
      const res=await fetch(`${API_URL}/operations/request`,{method:'POST',headers:await authHeaders(),body:JSON.stringify(payload)});
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(dvHttpErrorMessage(res,data));
      await dvShowMessageModal({
        type:'success',
        title:'Solicitud enviada',
        message:'La solicitud de eliminación fue enviada correctamente al custodio.',
        detail:`${esCarpeta?'📁 Carpeta':'📄 Archivo'}: ${nombre}
📂 Ubicación actual: ${origen}`,
        buttonText:'Entendido'
      });
      await loadCola();
      if(typeof loadFilesView==='function')await loadFilesView();
    }catch(err){
      await dvShowMessageModal({
        type:'error',
        title:'No se pudo solicitar la eliminación',
        message:'Ocurrió un problema al registrar la solicitud.',
        detail:String(err?.message||err||'Error desconocido'),
        buttonText:'Cerrar'
      });
    }
  };

  window.resolvePendingOperation=async function(id,decision,buttonEl=null){
    if(!isAdmin())return;
    const aprobar=String(decision||'').toUpperCase()==='APROBAR';
    const row=(dvOpsRequestCache||[]).find(r=>String(r?.id||'')===String(id||''));
    const tipo=String(row?.tipo_operacion||'OPERACIÓN').toUpperCase();
    const nombre=row?.nombre_objeto||'este elemento';
    const esMover=tipo==='MOVER';

    const confirmado=await dvShowDecisionModal({
      mode:aprobar?'approve':'reject',
      title:aprobar
        ? (esMover?'Aprobar movimiento':'Aprobar eliminación')
        : (esMover?'Rechazar movimiento':'Rechazar eliminación'),
      subtitle:`${tipo==='MOVER'?'Movimiento':'Eliminación'} solicitado por ${row?.solicitante_nombre||'el usuario'}`,
      message:`¿${aprobar?'Aprobar':'Rechazar'} la solicitud sobre ${nombre}?`,
      detail:aprobar
        ? (esMover
            ? `Google Drive moverá el elemento a ${row?.carpeta_destino_nombre||'la carpeta seleccionada'}.`
            : 'El elemento se enviará a la papelera de Google Drive.')
        : 'La solicitud quedará rechazada y Google Drive no será modificado.',
      confirmText:aprobar?'Sí, aprobar':'Sí, rechazar',
      cancelText:'Cancelar'
    });

    if(!confirmado)return;

    const originalHtml=buttonEl?.innerHTML;
    try{
      if(buttonEl){
        buttonEl.disabled=true;
        buttonEl.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i> Procesando...';
      }

      const res=await fetch(`${API_URL}/operations/decision`,{
        method:'POST',
        headers:await authHeaders(),
        body:JSON.stringify({
          solicitud_id:id,
          decision:aprobar?'APROBAR':'RECHAZAR'
        })
      });
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(dvHttpErrorMessage(res,data));

      await loadCola();
      if(typeof loadRoleHome==='function')await loadRoleHome();
      if(typeof loadFilesView==='function' && document.getElementById('view-gestor')?.classList.contains('active'))await loadFilesView();
      if(typeof loadAudit==='function')await loadAudit();

      const finalState=String(data?.estado||'').toUpperCase();
      await dvShowMessageModal({
        type:finalState==='RECHAZADO'?'success':'success',
        title:data?.status==='already_processed'
          ? 'Solicitud ya procesada'
          : (aprobar?'Solicitud aprobada':'Solicitud rechazada'),
        message:data?.status==='already_processed'
          ? `La solicitud ya tenía estado ${finalState||'resuelto'}.`
          : (aprobar
              ? (esMover?'El movimiento fue aprobado y ejecutado en Google Drive.':'La eliminación fue aprobada y el elemento fue enviado a la papelera de Google Drive.')
              : 'La solicitud fue rechazada. Google Drive no fue modificado.'),
        buttonText:'Entendido'
      });
    }catch(err){
      await dvShowMessageModal({
        type:'error',
        title:aprobar?'No se pudo aprobar':'No se pudo rechazar',
        message:String(err?.message||err||'Ocurrió un error inesperado.'),
        buttonText:'Cerrar'
      });
    }finally{
      if(buttonEl && document.body.contains(buttonEl)){
        buttonEl.disabled=false;
        if(originalHtml!=null)buttonEl.innerHTML=originalHtml;
      }
    }
  };

  function operationDecisionButtons(id){
    if(!isAdmin()||!id)return '—';
    const safeId=escapeHtml(String(id));
    return `<div class="flex flex-wrap items-center gap-1.5">
      <button type="button" class="secondary-btn approve-outline !px-2 !py-1 !text-[9px]" onclick="resolvePendingOperation('${safeId}','APROBAR',this)"><i class="fa-solid fa-check"></i> Aprobar</button>
      <button type="button" class="secondary-btn danger-outline !px-2 !py-1 !text-[9px]" onclick="resolvePendingOperation('${safeId}','RECHAZAR',this)"><i class="fa-solid fa-xmark"></i> Rechazar</button>
    </div>`;
  }

  function requestMine(r){return !myUid() || String(r?.solicitante_id||'')===myUid();}
  function opLabel(r){return String(r.tipo_operacion||'').toUpperCase()==='MOVER'?'Mover':'Eliminar';}

  window.resolvePendingUpload=async function(id,kind,decision,buttonEl=null){
    if(!isAdmin())return;
    const esCarpeta=String(kind||'').toUpperCase()==='CARPETA';
    const aprobar=String(decision||'').toUpperCase()==='APROBAR';
    const objeto=esCarpeta?'esta carpeta y todos sus archivos pendientes':'este archivo pendiente';
    const verbo=aprobar?'Aprobar':'Rechazar';
    const efecto=aprobar
      ? 'Se transferirá a Google Drive y quedará marcado como aprobado.'
      : 'Quedará marcado como rechazado y ya no se enviará a Google Drive.';

    const confirmado=await dvShowDecisionModal({
      mode:aprobar?'approve':'reject',
      title:aprobar
        ? (esCarpeta?'Aprobar carpeta':'Aprobar archivo')
        : (esCarpeta?'Rechazar carpeta':'Rechazar archivo'),
      subtitle:esCarpeta
        ? 'Decisión sobre los archivos pendientes de la carpeta'
        : 'Decisión de custodia del archivo',
      message:`¿${verbo} ${objeto}?`,
      detail:efecto,
      confirmText:aprobar?'Sí, aprobar':'Sí, rechazar',
      cancelText:'Cancelar'
    });

    if(!confirmado)return;

    const originalHtml=buttonEl?.innerHTML;
    try{
      if(buttonEl){
        buttonEl.disabled=true;
        buttonEl.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i> Procesando...';
      }

      const payload={
        objeto_tipo:esCarpeta?'CARPETA':'ARCHIVO',
        decision:aprobar?'APROBAR':'RECHAZAR'
      };
      if(esCarpeta)payload.lote_id=id;else payload.auditoria_id=id;

      const res=await fetch(`${API_URL}/custody/decision`,{
        method:'POST',
        headers:await authHeaders(),
        body:JSON.stringify(payload)
      });
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(dvHttpErrorMessage(res,data));

      const cantidad=Number(data.procesados||0);

      await loadCola();
      if(typeof loadRoleHome==='function')await loadRoleHome();
      if(typeof loadFilesView==='function' && document.getElementById('view-gestor')?.classList.contains('active'))await loadFilesView();
      if(typeof loadAudit==='function')await loadAudit();

      await dvShowMessageModal({
        type:'success',
        title:aprobar
          ? (esCarpeta?'Carpeta aprobada':'Archivo aprobado')
          : (esCarpeta?'Carpeta rechazada':'Archivo rechazado'),
        message:esCarpeta
          ? `${aprobar?'Se aprobaron':'Se rechazaron'} ${cantidad} archivo(s) pendiente(s) de la carpeta.`
          : (aprobar
              ? 'El archivo fue aprobado y transferido correctamente a Google Drive.'
              : 'El archivo fue rechazado y ya no será enviado a Google Drive.'),
        buttonText:'Entendido'
      });
    }catch(err){
      await dvShowMessageModal({
        type:'error',
        title:aprobar?'No se pudo aprobar':'No se pudo rechazar',
        message:String(err?.message||err||'Ocurrió un error inesperado.'),
        buttonText:'Cerrar'
      });
    }finally{
      if(buttonEl && document.body.contains(buttonEl)){
        buttonEl.disabled=false;
        if(originalHtml!=null)buttonEl.innerHTML=originalHtml;
      }
    }
  };

  // Compatibilidad con botones antiguos que aún puedan llamar esta función.
  window.cancelPendingUpload=function(id,kind,buttonEl=null){
    return window.resolvePendingUpload(id,kind,'RECHAZAR',buttonEl);
  };

  function custodyDecisionButtons(id,kind,{folder=false}={}){
    if(!isAdmin()||!id)return '—';
    const safeId=escapeHtml(String(id));
    const safeKind=String(kind||'ARCHIVO').toUpperCase()==='CARPETA'?'CARPETA':'ARCHIVO';
    const approveLabel=folder?'Aprobar pendientes':'Aprobar';
    const rejectLabel=folder?'Rechazar pendientes':'Rechazar';
    return `<div class="flex flex-wrap items-center gap-1.5">
      <button type="button" class="secondary-btn approve-outline !px-2 !py-1 !text-[9px]" onclick="resolvePendingUpload('${safeId}','${safeKind}','APROBAR',this)"><i class="fa-solid fa-check"></i> ${approveLabel}</button>
      <button type="button" class="secondary-btn danger-outline !px-2 !py-1 !text-[9px]" onclick="resolvePendingUpload('${safeId}','${safeKind}','RECHAZAR',this)"><i class="fa-solid fa-xmark"></i> ${rejectLabel}</button>
    </div>`;
  };


  async function queryRequests(){
    try{
      const res=await fetch(`${API_URL}/operations/requests`,{headers:await authHeaders(false)});
      const body=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(body?.detail||`Error HTTP ${res.status}`);
      dvOpsRequestCache=Array.isArray(body?.solicitudes)?body.solicitudes:[];
    }catch(err){
      console.warn('[DATAVAULT OPERACIONES] solicitudes_operacion no disponible:',err);
      dvOpsRequestCache=[];
    }
  }

  function uploadUnitMine(u){const r=u.type==='folder'?u.rows[0]:u.row;return rowMine(r);}
  function dvQueueFolderDetailId(id){return 'dv-queue-folder-'+String(id||'').replace(/[^a-zA-Z0-9_-]/g,'');}
  window.toggleDvQueueFolder=function(id){const row=document.getElementById(dvQueueFolderDetailId(id));const icon=document.getElementById(dvQueueFolderDetailId(id)+'-icon');if(!row)return;const hidden=row.classList.toggle('hidden');if(icon)icon.textContent=hidden?'▶':'▼';};
  function dvQueueFolderPendingCount(rows){return (rows||[]).filter(r=>String(r?.estado||'PENDIENTE').toUpperCase()==='PENDIENTE').length;}
  function dvQueueFolderRow(rows,loteId){
    const root=dvRoot(rows[0])||'Carpeta';
    const id=dvQueueFolderDetailId(loteId);
    const pendingRows=(rows||[]).filter(r=>String(r?.estado||'PENDIENTE').toUpperCase()==='PENDIENTE');
    const totalBytes=(rows||[]).reduce((s,r)=>s+Number(r?.tamano_bytes||0),0);
    const parts=(rows||[]).map(r=>String(r?.ruta_relativa||r?.nombre_archivo||'')).filter(Boolean);
    const state=groupState(rows);
    const pendingText=pendingRows.length?`${pendingRows.length} pendiente${pendingRows.length===1?'':'s'}`:'Sin pendientes';
    const detailRows=(rows||[]).slice().sort((a,b)=>String(a?.ruta_relativa||a?.nombre_archivo||'').localeCompare(String(b?.ruta_relativa||b?.nombre_archivo||''))).map(r=>{
      const rowState=String(r?.estado||'PENDIENTE').toUpperCase();
      const name=dvPath(r)||r?.nombre_archivo||'Archivo';
      const childActions=r?.id&&rowState==='PENDIENTE'&&isAdmin()
        ? custodyDecisionButtons(r.id,'ARCHIVO')
        : '<span class="text-[9px] text-slate-400">—</span>';
      return `<div class="flex flex-wrap items-center gap-2 border-b border-slate-100 py-2 last:border-b-0">
        <div class="min-w-0 flex-1"><p class="font-semibold text-[9px] text-slate-700 truncate" title="${escapeHtml(name)}"><i class="fa-solid ${dvIconFor(r?.nombre_archivo||name)} mr-2 text-blue-400"></i>${escapeHtml(name)}</p></div>
        <span class="text-[8px] text-slate-400">${formatBytes(Number(r?.tamano_bytes||0))}</span>
        <span class="status-pill ${dvStatusClass(rowState)}">${escapeHtml(rowState)}</span>
        ${childActions}
      </div>`;
    }).join('');
    const cancelAll=pendingRows.length&&isAdmin()
      ? custodyDecisionButtons(loteId,'CARPETA',{folder:true})
      : '';
    return `<tr class="dv-folder-summary">
      <td>
        <button type="button" class="dv-folder-toggle" onclick="toggleDvQueueFolder('${escapeHtml(String(loteId))}')">
          <span class="dv-caret" id="${id}-icon">▶</span><i class="fa-solid fa-folder text-amber-500"></i><span>${escapeHtml(root)}</span><span class="dv-folder-chip">${rows.length} archivo(s)</span>
        </button>
      </td>
      <td>Carpeta / lote</td>
      <td>${escapeHtml(root)}</td>
      <td>${escapeHtml(rows[0]?.ubicacion_drive||'DRIVE PROYECTO')}</td>
      <td>${escapeHtml(rows[0]?.solicitante_nombre||rows[0]?.usuario_solicitante||'—')}</td>
      <td>${formatShortDate(rows.map(r=>r?.fecha_solicitud||'').sort().reverse()[0])}</td>
      <td><span class="status-pill ${dvStatusClass(state)}">${escapeHtml(state)}</span></td>
      <td>${isAdmin()&&pendingRows.length?cancelAll:'—'}</td>
    </tr>
    <tr id="${id}" class="hidden">
      <td colspan="8" class="p-0 bg-slate-50/70">
        <div class="mx-2 my-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
          <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
            <div><div class="font-semibold text-[10px] text-slate-700"><i class="fa-solid fa-folder-open mr-2 text-amber-500"></i>Contenido de ${escapeHtml(root)}</div><div class="text-[8px] text-slate-400 mt-1">${rows.length} archivo(s) · ${escapeHtml(pendingText)} · ${formatBytes(totalBytes)}</div></div>
            <div>${cancelAll}</div>
          </div>
          <div class="rounded-md border border-slate-100 bg-slate-50/60 px-3">${detailRows||'<div class="py-3 text-[9px] text-slate-400">No hay archivos en este lote.</div>'}</div>
        </div>
      </td>
    </tr>`;
  }

  const dvApprovalExpandedUsers=window.__dvApprovalExpandedUsers instanceof Set
    ? window.__dvApprovalExpandedUsers
    : new Set();
  window.__dvApprovalExpandedUsers=dvApprovalExpandedUsers;

  function dvApprovalUserDomId(key){
    return 'dv-approval-user-'+String(key||'sin-usuario').replace(/[^a-zA-Z0-9_-]/g,'_');
  }

  window.toggleDvApprovalUser=function(key){
    const id=dvApprovalUserDomId(key);
    const open=dvApprovalExpandedUsers.has(String(key));
    if(open)dvApprovalExpandedUsers.delete(String(key));
    else dvApprovalExpandedUsers.add(String(key));
    document.querySelectorAll(`[data-dv-user-group="${id}"]`).forEach(row=>row.classList.toggle('dv-user-collapsed',open));
    const caret=document.getElementById(id+'-caret');if(caret)caret.textContent=open?'▶':'▼';
  };

  function dvRequestCategory(row){
    if(row.kind==='UPLOAD')return 'SUBIDA';
    return String(row.opType||'').toUpperCase()==='MOVER'?'MOVER':'ELIMINAR';
  }

  function dvApprovalUserSummary(key,userRows){
    const first=userRows[0]||{};
    const name=first.user||'Usuario';
    const email=first.email||'';
    const pending=userRows.filter(r=>r.state==='PENDIENTE'||(r.kind==='UPLOAD'&&r.type==='Carga de carpeta'&&r.pendingChildren>0)).length;
    const uploads=userRows.filter(r=>dvRequestCategory(r)==='SUBIDA').length;
    const moves=userRows.filter(r=>dvRequestCategory(r)==='MOVER').length;
    const deletes=userRows.filter(r=>dvRequestCategory(r)==='ELIMINAR').length;
    const id=dvApprovalUserDomId(key);
    const expanded=dvApprovalExpandedUsers.has(String(key));
    return `<tr class="dv-approval-user-summary"><td colspan="8">
      <button type="button" class="dv-approval-user-toggle" onclick="toggleDvApprovalUser('${escapeHtml(String(key))}')">
        <span class="dv-approval-user-caret" id="${id}-caret">${expanded?'▼':'▶'}</span>
        <span class="dv-approval-user-avatar"><i class="fa-solid fa-user"></i></span>
        <span class="dv-approval-user-main"><strong>${escapeHtml(name)}</strong>${email?`<small>${escapeHtml(email)}</small>`:''}</span>
        <span class="dv-approval-chip dv-chip-upload"><i class="fa-solid fa-upload"></i> ${uploads} subida${uploads===1?'':'s'}</span>
        <span class="dv-approval-chip dv-chip-move"><i class="fa-solid fa-arrow-right-arrow-left"></i> ${moves} movimiento${moves===1?'':'s'}</span>
        <span class="dv-approval-chip dv-chip-delete"><i class="fa-solid fa-trash"></i> ${deletes} eliminación${deletes===1?'':'es'}</span>
        <span class="dv-approval-user-pending">${pending} pendiente${pending===1?'':'s'}</span>
      </button>
    </td></tr>`;
  }

  function renderUnifiedRequests(){
    const tbody=document.getElementById('colaContainer');if(!tbody)return;
    const q=norm(document.getElementById('solSearch')?.value||'');
    const stateFilter=String(document.getElementById('solStateFilter')?.value||'').toUpperCase();
    let uploads=dvOpsUploadUnits.filter(u=>isAdmin()||uploadUnitMine(u));
    let ops=dvOpsRequestCache.filter(r=>isAdmin()||requestMine(r));

    const rows=[];
    uploads.forEach((u,i)=>{
      const isF=u.type==='folder',r=isF?u.rows[0]:u.row,state=groupState(isF?u.rows:[r]);
      const name=isF?(dvRoot(r)||'Carpeta'):(r.nombre_archivo||'Archivo');
      const pendingChildren=isF?dvQueueFolderPendingCount(u.rows):state==='PENDIENTE'?1:0;
      rows.push({
        kind:'UPLOAD',unit:u,id:isF?u.id:r.id,
        type:isF?'Subida de carpeta':'Subida de archivo',
        origin:name,dest:r.ubicacion_drive||r.carpeta_destino_nombre||'DRIVE PROYECTO',
        user:r.solicitante_nombre||r.usuario_solicitante||'—',
        email:r.solicitante_correo||'',userId:r.solicitante_id||'',
        date:u.date,state,pendingChildren,
        action:isAdmin()&&state==='PENDIENTE'?'Resolver en Telegram':'—'
      });
    });
    ops.forEach(r=>rows.push({
      kind:'OP',id:r.id,opType:String(r.tipo_operacion||'').toUpperCase(),
      type:String(r.tipo_operacion||'').toUpperCase()==='MOVER'?'Movimiento':'Eliminación',
      origin:r.nombre_objeto||r.carpeta_origen||'—',
      dest:String(r.tipo_operacion||'').toUpperCase()==='MOVER'?(r.carpeta_destino_nombre||'—'):'Papelera',
      user:r.solicitante_nombre||'—',email:r.solicitante_correo||'',userId:r.solicitante_id||'',
      date:r.fecha_solicitud,state:String(r.estado||'PENDIENTE').toUpperCase(),pendingChildren:0,
      action:isAdmin()&&String(r.estado||'').toUpperCase()==='PENDIENTE'?'WEB_DECISION':'—'
    }));

    rows.sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
    const filtered=rows.filter(r=>{
      const matchesQ=!q||norm([r.id,r.type,r.origin,r.dest,r.user,r.email].join(' ')).includes(q);
      const matchesState=!stateFilter||(r.state===stateFilter)||(r.kind==='UPLOAD'&&r.type==='Subida de carpeta'&&stateFilter==='PENDIENTE'&&r.pendingChildren>0);
      return matchesQ&&matchesState;
    });

    const renderDetailRow=(r,groupId='')=>{
      const groupAttrs=groupId?` data-dv-user-group="${groupId}" class="${dvApprovalExpandedUsers.has(groupId.replace('dv-approval-user-',''))?'':'dv-user-collapsed'}"`:'';
      const actionHtml=isAdmin()&&r.kind==='UPLOAD'&&r.state==='PENDIENTE'
        ? (r.type==='Subida de carpeta'
            ? custodyDecisionButtons(r.id,'CARPETA',{folder:true})
            : custodyDecisionButtons(r.id,'ARCHIVO'))
        : (isAdmin()&&r.kind==='OP'&&r.state==='PENDIENTE'
            ? operationDecisionButtons(r.id)
            : '—');
      return `<tr${groupAttrs}><td>#${escapeHtml(String(r.id||'').slice(-8))}</td><td>${escapeHtml(r.type)}</td><td>${escapeHtml(r.origin)}</td><td>${escapeHtml(r.dest)}</td><td>${escapeHtml(r.user)}</td><td>${formatShortDate(r.date)}</td><td>${statusPill(r.state)}</td><td>${actionHtml}</td></tr>`;
    };

    if(isAdmin()){
      const groups=new Map();
      filtered.forEach(r=>{
        const key=String(r.userId||norm(r.email)||norm(r.user)||'sin-usuario');
        if(!groups.has(key))groups.set(key,[]);
        groups.get(key).push(r);
      });
      const html=[];
      for(const [key,userRows] of groups.entries()){
        html.push(dvApprovalUserSummary(key,userRows));
        const groupId=dvApprovalUserDomId(key);
        const expanded=dvApprovalExpandedUsers.has(String(key));
        userRows.forEach(r=>{
          const actionHtml=r.kind==='UPLOAD'&&r.state==='PENDIENTE'
            ? (r.type==='Subida de carpeta'
                ? custodyDecisionButtons(r.id,'CARPETA',{folder:true})
                : custodyDecisionButtons(r.id,'ARCHIVO'))
            : (r.kind==='OP'&&r.state==='PENDIENTE'
                ? operationDecisionButtons(r.id)
                : '—');
          html.push(`<tr data-dv-user-group="${groupId}" class="${expanded?'':'dv-user-collapsed'}"><td>#${escapeHtml(String(r.id||'').slice(-8))}</td><td>${escapeHtml(r.type)}</td><td>${escapeHtml(r.origin)}</td><td>${escapeHtml(r.dest)}</td><td>${escapeHtml(r.user)}</td><td>${formatShortDate(r.date)}</td><td>${statusPill(r.state)}</td><td>${actionHtml}</td></tr>`);
        });
      }
      tbody.innerHTML=html.length?html.join(''):'<tr><td colspan="8" class="p-8 text-center text-slate-400">No se encontraron solicitudes.</td></tr>';
    }else{
      const pageRows=window.dvSubPage(filtered,'requests',q+'|'+stateFilter,tbody,renderUnifiedRequests);
      tbody.innerHTML=filtered.length?pageRows.map(r=>renderDetailRow(r)).join(''):'<tr><td colspan="8" class="p-8 text-center text-slate-400">No se encontraron solicitudes.</td></tr>';
    }

    window.dispatchEvent(new CustomEvent('dv:requests-data', {detail: {requests: rows}}));
    const pending=rows.filter(r=>r.state==='PENDIENTE'||(r.kind==='UPLOAD'&&r.type==='Subida de carpeta'&&r.pendingChildren>0)).length;
    const sum=document.getElementById('solSummary');
    if(sum)sum.textContent=isAdmin()?`${new Set(rows.map(r=>String(r.userId||norm(r.email)||norm(r.user)||'sin-usuario'))).size} usuario(s) · ${rows.length} solicitud(es) · ${pending} pendiente(s)`:`${rows.length} solicitud(es) · ${pending} pendiente(s)`;
    const mini=document.getElementById('solPendingMini');if(mini)mini.textContent=pending;
    updateKpis({pendientes:pending});

    if(!isAdmin()){
      const cards=[...document.querySelectorAll('#view-inicio .grid.grid-cols-2.xl\\:grid-cols-4 .dashboard-card')];
      const pendingCard=cards.find(c=>/Pendientes/i.test(c.querySelector('.metric-label')?.textContent||''));
      const value=pendingCard?.querySelector('.metric-value');if(value)value.textContent=pending;
    }
  }

  loadCola=async function(){
    const [{data,error}]=await Promise.all([supabaseClient.from('auditoria_custodia').select('*').order('fecha_solicitud',{ascending:false}).limit(1000),queryRequests()]);
    if(error){console.error('[DATAVAULT SOLICITUDES] auditoria:',error);return;}
    const rows=Array.isArray(data)?data:[];dvOpsUploadUnits=dvGroupedUnits(rows);renderUnifiedRequests();
  };
  filterSolicitudesUI=renderUnifiedRequests;

  // Realtime para las dos tablas que cambian la interfaz.
  let refreshTimer=null;
  async function refreshAll(){
    clearTimeout(refreshTimer);

    refreshTimer=setTimeout(async()=>{
      try{
        // loadAudit() actualiza auditCache y repinta el explorador abierto
        // mediante dvRenderDynamicFolders()/filterFiles(), sin poner spinner.
        await loadAudit();

        // Actualiza solicitudes/aprobaciones.
        await loadCola();

        // El dashboard reutiliza este mismo evento Realtime; no abre otro canal.
        if(typeof window.dvRefreshDashboardInventory === 'function'){
          window.dvRefreshDashboardInventory('main-realtime');
        }

        // IMPORTANTE: no llamar loadFilesView() aquí.
        // loadFilesView() muestra "Cargando archivos..." y provocaba el
        // parpadeo visual en cada evento Realtime.

        if(
          isAdmin() &&
          typeof loadAdminUsers==='function' &&
          document.getElementById('view-usuarios')?.classList.contains('active')
        ){
          await loadAdminUsers();
        }
      }catch(err){
        console.error('[DATAVAULT REALTIME REFRESH]',err);
      }
    },250);
  }

  listenRealtime=function(){
    const olds=[auditRealtimeChannel,colaRealtimeChannel,window.__dvRoleAuditChannel,window.__dvRealtimeMainChannel,window.__dvOpsRealtime];
    olds.forEach(ch=>{if(ch){try{supabaseClient.removeChannel(ch);}catch(_){}}});
    auditRealtimeChannel=null;colaRealtimeChannel=null;window.__dvRoleAuditChannel=null;window.__dvRealtimeMainChannel=null;window.__dvOpsRealtime=null;
    window.__dvOpsRealtime=supabaseClient.channel('datavault_operaciones_realtime_v1')
      .on('postgres_changes',{event:'*',schema:'public',table:'auditoria_custodia'},refreshAll)
      .on('postgres_changes',{event:'*',schema:'public',table:'solicitudes_operacion'},refreshAll)
      .subscribe(status=>{if(['CHANNEL_ERROR','TIMED_OUT','CLOSED'].includes(status))console.warn('[DATAVAULT REALTIME]',status);});
  };

  async function backfillLegacyDriveIds(){
    if(!currentUser || !isAdmin() || sessionStorage.getItem('dv_legacy_backfill_done')==='1') return;
    try{
      const res=await fetch(`${API_URL}/drive/backfill-legacy`,{method:'POST',headers:await authHeaders(false)});
      if(res.ok){
        const data=await res.json().catch(()=>({}));
        sessionStorage.setItem('dv_legacy_backfill_done','1');
        if(Number(data.vinculados||0)>0) console.log('[DRIVE LEGACY LINK]',data);
      }
    }catch(err){console.warn('[DRIVE LEGACY LINK]',err.message||err);}
  }

  async function reconcileDrive(){
    if(dvOpsSyncBusy || !currentUser || !isAdmin())return;
    dvOpsSyncBusy=true;
    try{
      const res=await fetch(`${API_URL}/drive/reconcile`,{method:'POST',headers:await authHeaders(false)});
      if(!res.ok)return;
      const data=await res.json().catch(()=>({}));
      if(Number(data.cambios||0)>0){console.log('[DRIVE SYNC]',data);await refreshAll();}
    }catch(err){console.warn('[DRIVE SYNC]',err.message||err);}
    finally{dvOpsSyncBusy=false;}
  }

  function startDriveSync(){
    // Sin polling cada 10 segundos.
    // Solo hacemos una reconciliación inicial; después los cambios normales
    // llegan por Realtime y el usuario puede usar el botón Actualizar.
    clearInterval(dvOpsSyncTimer);
    dvOpsSyncTimer = null;

    setTimeout(async()=>{
      try{
        await backfillLegacyDriveIds();
        await reconcileDrive();
      }catch(err){
        console.warn('[DRIVE SYNC INICIAL]', err?.message || err);
      }
    },1200);
  }

  const finalEnter=enterApp;
  enterApp=function(){
    finalEnter();
    ensureTableHeader();ensureModal();
    setTimeout(()=>{listenRealtime();startDriveSync();loadCola();},500);
  };

  const finalLogout=handleLogout;
  handleLogout=async function(){
    clearInterval(dvOpsSyncTimer);dvOpsSyncTimer=null;
    if(window.__dvOpsRealtime){try{await supabaseClient.removeChannel(window.__dvOpsRealtime);}catch(_){}window.__dvOpsRealtime=null;}
    return finalLogout();
  };

  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&currentUser)reconcileDrive();});
  document.addEventListener('DOMContentLoaded',()=>{ensureTableHeader();ensureModal();});
})();


/* datavault-initial-hydration-v2 */

/* =========================================================
   FIX V2 · CARGA INICIAL INDEPENDIENTE
   Evita que Inicio quede en 0 / "Cargando registros..."
   hasta navegar a otra vista.
   ========================================================= */
(function(){
  let dvHydrationSeq = 0;
  let dvHydrationBusy = false;
  let dvHydrationQueued = false;
  let dvHydrationChannel = null;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = v => String(v ?? '').trim().toLowerCase();

  function isAdminRole(){
    return ['jefe','admin','administrador'].includes(norm(currentRole));
  }

  function rowBelongsToCurrentUser(r, user){
    const uid = String(user?.id || '').trim();
    const mail = norm(user?.email || currentUserEmail);
    const name = norm(user?.user_metadata?.full_name || currentDisplayName);

    if(uid && String(r?.solicitante_id || '').trim() === uid) return true;
    if(mail && norm(r?.solicitante_correo || r?.correo) === mail) return true;

    const rowName = norm(r?.solicitante_nombre || r?.usuario_solicitante || r?.usuario);
    return !!name && rowName === name;
  }

  function setHomeLoading(){
    document.querySelectorAll('#view-inicio .metric-value').forEach(el => {
      if(el.textContent === '0' || el.textContent === '—' || el.textContent === '') el.textContent = '…';
    });
    const body = document.getElementById('inicioTableBody');
    if(body && (!body.children.length || /Cargando registros/i.test(body.textContent || ''))){
      body.innerHTML = '<tr><td colspan="4" class="p-6 text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Cargando registros...</td></tr>';
    }
  }

  function setHomeError(message){
    const body = document.getElementById('inicioTableBody');
    if(body){
      body.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-red-500">No se pudieron cargar los datos: ${escapeHtml(message || 'error desconocido')}</td></tr>`;
    }
  }

  function renderHomeDirect(rows){
    const approved = rows.filter(r => String(r.estado || '').toUpperCase() === 'APROBADO').length;
    const pending  = rows.filter(r => String(r.estado || '').toUpperCase() === 'PENDIENTE').length;
    const rejected = rows.filter(r => String(r.estado || '').toUpperCase() === 'RECHAZADO').length;

    const cards = [...document.querySelectorAll('#view-inicio .grid.grid-cols-2.xl\\:grid-cols-4 .dashboard-card')];
    const values = isAdminRole()
      ? [
          ['Archivos protegidos', rows.length, 'Registros corporativos'],
          ['Solicitudes pendientes', pending, 'Requieren revisión'],
          ['Usuarios con actividad', new Set(rows.map(r => r.solicitante_id || r.solicitante_correo || r.solicitante_nombre).filter(Boolean)).size, 'Con cargas registradas'],
          ['Rechazados', rejected, 'Eventos bloqueados']
        ]
      : [
          ['Mis archivos', rows.length, 'En custodia'],
          ['Pendientes', pending, 'Esperando aprobación'],
          ['Aprobados', approved, 'Transferidos'],
          ['Rechazados', rejected, 'No autorizados']
        ];

    cards.slice(0,4).forEach((card, i) => {
      const label = card.querySelector('.metric-label');
      const value = card.querySelector('.metric-value');
      const trend = card.querySelector('.metric-trend');
      if(label) label.textContent = values[i][0];
      if(value) value.textContent = values[i][1];
      if(trend) trend.textContent = values[i][2];
    });

    const recent = document.getElementById('inicioTableBody');
    if(recent){
      const visible = rows.slice(0,6);
      recent.innerHTML = visible.length
        ? visible.map(r => {
            const user = r.solicitante_nombre || r.usuario_solicitante || currentDisplayName || 'Usuario';
            const action = r.lote_id ? 'Carga de carpeta' : 'Carga de archivo';
            return `<tr><td>${formatShortDate(r.fecha_solicitud)}</td><td>${escapeHtml(user)}</td><td>${escapeHtml(action)}</td><td>${statusPill(r.estado || 'PENDIENTE')}</td></tr>`;
          }).join('')
        : '<tr><td colspan="4" class="p-6 text-center text-slate-400">No existen registros.</td></tr>';
    }

    const welcome = document.getElementById('dashWelcome');
    if(welcome) welcome.textContent = currentDisplayName || (isAdminRole() ? 'Administrador' : 'Usuario');
  }

  async function fetchInitialRows(){
    const { data: sessionData, error: sessionError } = await supabaseClient.auth.getSession();
    if(sessionError) throw sessionError;
    const session = sessionData?.session;
    if(!session?.user) throw new Error('No hay sesión activa de Supabase.');

    const user = session.user;
    if(!currentUser || currentUser.id !== user.id){
      setSessionFromUser(user);
    }

    const { data, error } = await supabaseClient
      .from('auditoria_custodia')
      .select('*')
      .order('fecha_solicitud', { ascending:false })
      .limit(1000);

    if(error) throw error;
    const all = Array.isArray(data) ? data : [];
    return isAdminRole() ? all : all.filter(r => rowBelongsToCurrentUser(r, user));
  }

  async function hydrateNow(reason='manual'){
    // No ejecutar consultas protegidas hasta que Supabase confirme una sesión.
    // Esto evita la carrera de arranque que antes producía errores falsos
    // "No hay sesión activa" justo antes del evento SIGNED_IN/INITIAL_SESSION.
    const { data: sessionData, error: sessionError } = await supabaseClient.auth.getSession();
    if(sessionError){
      console.warn('[DATAVAULT HYDRATION V2] sesión no disponible todavía:', sessionError.message || sessionError);
      return;
    }
    if(!sessionData?.session?.user) return;

    const seq = ++dvHydrationSeq;
    if(dvHydrationBusy){
      dvHydrationQueued = true;
      return;
    }

    dvHydrationBusy = true;
    setHomeLoading();

    try{
      const rows = await fetchInitialRows();
      if(seq !== dvHydrationSeq) return;

      renderHomeDirect(rows);

      // Actualiza también las vistas existentes sin depender de que el usuario navegue.
      try{ if(typeof loadCola === 'function') await loadCola(); }catch(e){ console.warn('[HYDRATION loadCola]', e); }
      // El explorador no se recarga desde la hidratación del dashboard.
      // Realtime general actualiza auditCache de forma silenciosa y el botón
      // Actualizar conserva la recarga manual completa.

      console.log('[DATAVAULT HYDRATION V2] OK', reason, rows.length);
    }catch(err){
      console.error('[DATAVAULT HYDRATION V2 ERROR]', reason, err);
      setHomeError(err?.message || String(err));
    }finally{
      dvHydrationBusy = false;
      if(dvHydrationQueued){
        dvHydrationQueued = false;
        setTimeout(() => hydrateNow('queued'), 60);
      }
    }
  }

  function connectHydrationRealtime(){
    // Este bloque antes abría una segunda suscripción Realtime para las mismas
    // tablas. La actualización general ya la gestiona listenRealtime(), por lo
    // que mantener ambos canales duplicaba consultas y refrescos visuales.
    if(dvHydrationChannel){
      try{supabaseClient.removeChannel(dvHydrationChannel);}catch(_){}
      dvHydrationChannel = null;
    }
  }

  async function boot(){
    // En el arranque solo hidratamos si Supabase ya restauró/confirmó la sesión.
    // Si todavía no existe, onAuthStateChange hará la carga cuando llegue SIGNED_IN
    // o INITIAL_SESSION. No hacemos reintentos protegidos a ciegas.
    const { data, error } = await supabaseClient.auth.getSession();
    if(error){
      console.warn('[DATAVAULT HYDRATION V2] no se pudo leer la sesión inicial:', error.message || error);
      return;
    }
    if(!data?.session?.user) return;

    setHomeLoading();
    await hydrateNow('boot-session-ready');
    connectHydrationRealtime();
  }

  // Sesión restaurada al recargar la página.
  document.addEventListener('DOMContentLoaded', boot);

  // Login nuevo / refresh del token.
  supabaseClient.auth.onAuthStateChange((event, session) => {
    if(session?.user && ['SIGNED_IN','INITIAL_SESSION','TOKEN_REFRESHED','USER_UPDATED'].includes(event)){
      setTimeout(() => hydrateNow('auth-'+event), 50);
      setTimeout(connectHydrationRealtime, 120);
    }
    if(event === 'SIGNED_OUT'){
      if(dvHydrationChannel){
        try{supabaseClient.removeChannel(dvHydrationChannel);}catch(_){}
        dvHydrationChannel = null;
      }
    }
  });

  // Cuando se vuelve a Inicio, refresca inmediatamente, sin depender de otra vista.
  const baseShow = window.showView || showView;
  window.showView = showView = function(name){
    const result = baseShow(name);
    if(name === 'inicio') setTimeout(() => hydrateNow('show-inicio'), 20);
    return result;
  };

  window.dvForceInitialHydration = hydrateNow;
})();


/* datavault-dashboard-inventory-v3 */

/* =========================================================
   DASHBOARD V3 · INVENTARIO ACTUAL + AUDITORÍA HISTÓRICA

   SUBORDINADO
   - Mis archivos = archivos APROBADOS que siguen activos en Drive.
   - Pendientes = cargas + operaciones pendientes del usuario.
   - Aprobados / Rechazados = historial del usuario.
   - Actividad reciente = historial del usuario.

   ADMIN
   - Archivos protegidos = inventario activo global.
   - Solicitudes pendientes = cargas + operaciones pendientes globales.
   - Usuarios con actividad = usuarios con registros.
   - Rechazados = historial global.
   - Actividad reciente = historial global.

   La auditoría NO se borra al eliminar un archivo.
   ========================================================= */
(function(){
  let dvDashChannel = null;
  let dvDashTimer = null;
  let dvDashBusy = false;
  let dvDashQueued = false;

  const norm = v => String(v ?? '').trim().toLowerCase();
  const upper = v => String(v ?? '').trim().toUpperCase();

  function isAdmin(){
    return ['jefe','admin','administrador'].includes(norm(currentRole));
  }

  function rowMine(r){
    const uid = String(currentUser?.id || '').trim();
    const email = norm(currentUserEmail || currentUser?.email);
    const name = norm(currentDisplayName || currentUser?.user_metadata?.full_name);

    if(uid && String(r?.solicitante_id || '').trim() === uid) return true;
    if(email && norm(r?.solicitante_correo) === email) return true;

    const rowName = norm(
      r?.solicitante_nombre ||
      r?.usuario_solicitante ||
      r?.usuario
    );

    return !!name && rowName === name;
  }

  function isDeleted(r){
    const estadoArchivo = upper(r?.estado_archivo);
    return (
      r?.en_drive === false ||
      estadoArchivo.startsWith('ELIMINADO') ||
      !!r?.fecha_eliminacion
    );
  }

  function isActiveInventory(r){
    // Un registro rechazado o pendiente nunca forma parte del inventario.
    if(upper(r?.estado) !== 'APROBADO') return false;

    // Si Drive/Supabase confirmó eliminación, sale del inventario.
    if(isDeleted(r)) return false;

    // Compatibilidad con aprobaciones antiguas:
    // en_drive puede ser NULL hasta que /drive/backfill-legacy o
    // /drive/reconcile termine de enlazarlas.
    return r?.en_drive !== false;
  }

  function rowUserKey(r){
    return String(
      r?.solicitante_id ||
      r?.solicitante_correo ||
      r?.solicitante_nombre ||
      r?.usuario_solicitante ||
      ''
    ).trim();
  }

  function pendingUploadUnits(rows){
    const seenLots = new Set();
    let total = 0;

    for(const r of rows){
      if(upper(r?.estado) !== 'PENDIENTE') continue;

      const lote = String(r?.lote_id || '').trim();

      if(lote){
        if(!seenLots.has(lote)){
          seenLots.add(lote);
          total++;
        }
      }else{
        total++;
      }
    }

    return total;
  }

  function pendingOperationCount(rows){
    return rows.filter(r => upper(r?.estado) === 'PENDIENTE').length;
  }

  function setCard(card, labelText, valueText, trendText){
    if(!card) return;

    const label = card.querySelector('.metric-label');
    const value = card.querySelector('.metric-value');
    const trend = card.querySelector('.metric-trend');

    if(label) label.textContent = labelText;
    if(value) value.textContent = valueText;
    if(trend) trend.textContent = trendText;
  }

  function actionForAudit(r){
    if(r?.fecha_eliminacion || upper(r?.estado_archivo).startsWith('ELIMINADO')){
      return 'Eliminación';
    }

    if(r?.lote_id) return 'Carga de carpeta';
    return 'Carga de archivo';
  }

  function resultPillForAudit(r){
    if(isDeleted(r)){
      return '<span class="status-pill status-rejected">Eliminado</span>';
    }

    const estado = upper(r?.estado || 'PENDIENTE');
    return statusPill(estado);
  }

  function homeRecentFolderDetailId(id){
    return 'home-recent-folder-' + String(id||'').replace(/[^a-zA-Z0-9_-]/g,'');
  }

  window.toggleHomeRecentFolder=function(id){
    const row=document.getElementById(homeRecentFolderDetailId(id));
    const icon=document.getElementById(homeRecentFolderDetailId(id)+'-icon');
    if(!row)return;
    const hidden=row.classList.toggle('hidden');
    if(icon)icon.textContent=hidden?'▶':'▼';
  };

  function homeRecentLooseRow(r){
    return `<tr>
      <td><div class="flex items-center gap-2"><div class="h-7 w-7 rounded-md bg-[#edf3f5] text-[#6c8698] flex items-center justify-center"><i class="fa-solid ${dvIconFor(r.nombre_archivo)} text-[10px]"></i></div><div><p class="font-semibold text-[#1f2b31] text-[9px]">${escapeHtml(r.nombre_archivo||'Sin nombre')}</p><p class="dv-unit-sub">${escapeHtml(r.solicitante_nombre||r.usuario_solicitante||'—')}</p></div></div></td>
      <td class="text-[8px] text-slate-500">Archivo suelto</td>
      <td><span class="integrity-ok"><i class="fa-solid fa-fingerprint"></i> Verificado</span></td>
      <td><span class="status-pill ${dvStatusClass(r.estado)}">${escapeHtml(r.estado||'PENDIENTE')}</span></td>
      <td class="text-[8px] text-slate-400">${dvDate(r.fecha_ultima_operacion||r.fecha_solicitud)}</td>
    </tr>`;
  }

  function homeRecentFolderRow(rows,loteId){
    const root=dvRoot(rows[0])||'Carpeta';
    const total=rows.reduce((s,r)=>s+Number(r.tamano_bytes||0),0);
    const state=dvGroupState(rows);
    const id=homeRecentFolderDetailId(loteId);
    const tree=dvBuildTree(rows);
    const last=rows.map(r=>r.fecha_ultima_operacion||r.fecha_solicitud||'').sort().reverse()[0];
    return `<tr class="dv-folder-summary">
      <td><button class="dv-folder-toggle" onclick="toggleHomeRecentFolder('${escapeHtml(String(loteId))}')"><span class="dv-caret" id="${id}-icon">▶</span><i class="fa-solid fa-folder text-amber-500"></i><span>${escapeHtml(root)}</span><span class="dv-folder-chip">${rows.length} archivo(s)</span></button></td>
      <td class="text-[8px] text-slate-500">Carpeta / lote</td>
      <td><span class="integrity-ok"><i class="fa-solid fa-fingerprint"></i> ${formatBytes(total)}</span></td>
      <td><span class="status-pill ${dvStatusClass(state)}">${escapeHtml(state)}</span></td>
      <td class="text-[8px] text-slate-400">${dvDate(last)}</td>
    </tr>
    <tr id="${id}" class="hidden dv-folder-detail"><td colspan="5"><div class="dv-folder-panel"><div class="flex flex-wrap justify-between gap-2 mb-2"><div><b class="text-[11px] text-slate-700"><i class="fa-solid fa-folder-open mr-2 text-amber-500"></i>${escapeHtml(root)}</b><div class="text-[8px] text-slate-400 mt-1">Lote ${escapeHtml(String(loteId))}</div></div><span class="text-[9px] text-slate-500">${rows.length} archivo(s) · ${formatBytes(total)}</span></div><div class="dv-tree">${dvRenderTree(tree)}</div></div></td></tr>`;
  }

  function renderRecent(rows){
    const body=document.getElementById('inicioRecentFilesBody');
    if(!body)return;

    const units=dvGroupedUnits(rows||[])
      .sort((a,b)=>String(b.date).localeCompare(String(a.date)))
      .slice(0,6);

    if(!units.length){
      body.innerHTML='<tr><td colspan="5" class="p-6 text-center text-slate-400">No hay archivos registrados.</td></tr>';
      return;
    }

    body.innerHTML=units.map(u=>u.type==='folder'
      ? homeRecentFolderRow(u.rows,u.id)
      : homeRecentLooseRow(u.row)
    ).join('');
  }

  async function fetchDashboardData(){
    const auditReq = supabaseClient
      .from('auditoria_custodia')
      .select('*')
      .order('fecha_solicitud', {ascending:false})
      .limit(2000);

    const opsReq = (async()=>{
      try{
        const res=await fetch(`${API_URL}/operations/requests`,{headers:await authHeaders(false)});
        const body=await res.json().catch(()=>({}));
        if(!res.ok)throw new Error(body?.detail||`Error HTTP ${res.status}`);
        return Array.isArray(body?.solicitudes)?body.solicitudes:[];
      }catch(err){
        console.warn('[DASHBOARD operaciones]',err);
        return [];
      }
    })();

    const [auditResult, opsData] = await Promise.all([auditReq, opsReq]);
    const {data:auditData, error:auditError}=auditResult;

    if(auditError) throw auditError;

    let audit = Array.isArray(auditData) ? auditData : [];
    let ops = Array.isArray(opsData) ? opsData : [];

    if(!isAdmin()){
      audit = audit.filter(rowMine);
      ops = ops.filter(r =>
        !currentUser?.id ||
        String(r?.solicitante_id || '') === String(currentUser.id)
      );
    }

    return {audit, ops};
  }

  function renderDashboard(audit, ops){
    auditCache = audit;
    window.dispatchEvent(new CustomEvent('dv:dashboard-data', {
      detail: {audit, ops, refreshedAt: new Date().toISOString()}
    }));
  }

  async function refreshDashboard(reason='manual'){
    clearTimeout(dvDashTimer);

    dvDashTimer = setTimeout(async () => {
      // No consultar endpoints protegidos antes de que Supabase tenga sesión.
      const { data: sessionData, error: sessionError } = await supabaseClient.auth.getSession();
      if(sessionError){
        console.warn('[DATAVAULT DASHBOARD V3] sesión no disponible todavía:', sessionError.message || sessionError);
        return;
      }
      if(!sessionData?.session?.user) return;

      if(dvDashBusy){
        dvDashQueued = true;
        return;
      }

      dvDashBusy = true;

      try{
        const {audit, ops} = await fetchDashboardData();
        renderDashboard(audit, ops);

        console.log(
          '[DATAVAULT DASHBOARD V3]',
          reason,
          {
            audit:audit.length,
            operaciones:ops.length,
            activos:audit.filter(isActiveInventory).length
          }
        );
      }catch(err){
        console.error('[DATAVAULT DASHBOARD V3 ERROR]', err);

        const body = document.getElementById('inicioRecentFilesBody');
        if(body && /Cargando/i.test(body.textContent || '')){
          body.innerHTML = `
            <tr>
              <td colspan="4" class="p-6 text-center text-red-500">
                No se pudieron cargar los datos: ${escapeHtml(err?.message || String(err))}
              </td>
            </tr>
          `;
        }
      }finally{
        dvDashBusy = false;

        if(dvDashQueued){
          dvDashQueued = false;
          refreshDashboard('queued');
        }
      }
    }, 80);
  }

  function connectRealtime(){
    // La actualización Realtime del dashboard se dispara desde el canal
    // principal de DataVault. Evitamos una segunda suscripción a las mismas tablas.
    if(dvDashChannel){
      try{ supabaseClient.removeChannel(dvDashChannel); }catch(_){}
      dvDashChannel = null;
    }
  }

  async function boot(){
    // Igual que Hydration: el Dashboard espera una sesión real antes de pedir
    // operaciones protegidas. El evento de Auth se encarga del login posterior.
    const { data, error } = await supabaseClient.auth.getSession();
    if(error){
      console.warn('[DATAVAULT DASHBOARD V3] no se pudo leer la sesión inicial:', error.message || error);
      return;
    }
    if(!data?.session?.user) return;

    refreshDashboard('boot-session-ready');
    setTimeout(connectRealtime, 200);
  }

  document.addEventListener('DOMContentLoaded', boot);

  supabaseClient.auth.onAuthStateChange((event, session) => {
    if(session?.user && [
      'SIGNED_IN',
      'INITIAL_SESSION',
      'TOKEN_REFRESHED',
      'USER_UPDATED'
    ].includes(event)){
      setTimeout(
        () => refreshDashboard('auth-'+event),
        80
      );
      setTimeout(connectRealtime, 200);
    }

    if(event === 'SIGNED_OUT' && dvDashChannel){
      try{
        supabaseClient.removeChannel(dvDashChannel);
      }catch(_){}
      dvDashChannel = null;
    }
  });

  // Cuando el usuario vuelve a Inicio, consultar de inmediato.
  const previousShowView = window.showView || showView;
  window.showView = showView = function(name){
    const result = previousShowView(name);

    if(name === 'inicio'){
      refreshDashboard('show-inicio');
    }

    return result;
  };

  // Exponer para pruebas desde consola.
  window.dvRefreshDashboardInventory = refreshDashboard;
})();


/* datavault-decision-modal-v2-script */

(function(){
  let dvModalResolver=null;
  let dvModalKeyHandler=null;
  let dvModalPreviousFocus=null;

  function modalEls(){
    return {
      modal:document.getElementById('dvDecisionModal'),
      card:document.querySelector('#dvDecisionModal .dv-decision-card'),
      icon:document.getElementById('dvDecisionIcon'),
      title:document.getElementById('dvDecisionTitle'),
      subtitle:document.getElementById('dvDecisionSubtitle'),
      message:document.getElementById('dvDecisionMessage'),
      detail:document.getElementById('dvDecisionDetail'),
      cancel:document.getElementById('dvDecisionCancel'),
      confirm:document.getElementById('dvDecisionConfirm')
    };
  }

  function closeModal(result){
    const e=modalEls();
    if(!e.modal)return;

    e.modal.classList.add('dv-hidden');
    document.body.classList.remove('dv-modal-open');

    if(dvModalKeyHandler){
      document.removeEventListener('keydown',dvModalKeyHandler);
      dvModalKeyHandler=null;
    }

    const resolve=dvModalResolver;
    dvModalResolver=null;

    setTimeout(()=>{
      if(dvModalPreviousFocus && typeof dvModalPreviousFocus.focus==='function'){
        try{dvModalPreviousFocus.focus();}catch(_){}
      }
      dvModalPreviousFocus=null;
    },0);

    if(resolve)resolve(Boolean(result));
  }

  function configureIcon(iconEl,mode){
    const safe=['approve','reject','success','error','info'].includes(mode)?mode:'info';
    iconEl.className=`dv-decision-icon ${safe}`;

    if(safe==='approve'||safe==='success'){
      iconEl.innerHTML='<i class="fa-solid fa-check"></i>';
    }else if(safe==='reject'||safe==='error'){
      iconEl.innerHTML='<i class="fa-solid fa-xmark"></i>';
    }else{
      iconEl.innerHTML='<i class="fa-solid fa-circle-info"></i>';
    }
  }

  window.dvShowDecisionModal=function({
    mode='approve',
    title='Confirmar acción',
    subtitle='DataVault DLP',
    message='¿Deseas continuar?',
    detail='',
    confirmText='Confirmar',
    cancelText='Cancelar'
  }={}){
    return new Promise(resolve=>{
      const e=modalEls();

      if(!e.modal||!e.card||!e.icon||!e.title||!e.subtitle||!e.message||!e.detail||!e.cancel||!e.confirm){
        resolve(false);
        return;
      }

      // Si por alguna razón hubiera otro modal de decisión abierto,
      // lo cerramos antes de abrir el nuevo.
      if(dvModalResolver){
        const previous=dvModalResolver;
        dvModalResolver=null;
        previous(false);
      }

      dvModalResolver=resolve;
      dvModalPreviousFocus=document.activeElement;

      configureIcon(e.icon,mode);
      e.title.textContent=title;
      e.subtitle.textContent=subtitle;
      e.message.textContent=message;
      e.detail.textContent=detail||'';
      e.detail.style.display=detail?'block':'none';

      e.cancel.style.display='inline-flex';
      e.cancel.querySelector('.dv-decision-btn-label').textContent=cancelText;

      e.confirm.className=`dv-decision-btn confirm ${mode==='reject'?'reject':'approve'}`;
      e.confirm.innerHTML=`<i class="fa-solid ${mode==='reject'?'fa-xmark':'fa-check'}"></i><span>${escapeHtml(confirmText)}</span>`;

      e.cancel.onclick=()=>closeModal(false);
      e.confirm.onclick=()=>closeModal(true);
      e.modal.onclick=event=>{
        if(event.target===e.modal)closeModal(false);
      };

      dvModalKeyHandler=event=>{
        if(event.key==='Escape'){
          event.preventDefault();
          closeModal(false);
        }else if(event.key==='Enter'){
          event.preventDefault();
          e.confirm.click();
        }
      };
      document.addEventListener('keydown',dvModalKeyHandler);

      document.body.classList.add('dv-modal-open');
      e.modal.classList.remove('dv-hidden');

      requestAnimationFrame(()=>{
        try{e.confirm.focus();}catch(_){}
      });
    });
  };

  window.dvShowMessageModal=function({
    type='info',
    title='DataVault DLP',
    message='',
    detail='',
    buttonText='Entendido'
  }={}){
    return new Promise(resolve=>{
      const e=modalEls();

      if(!e.modal||!e.card||!e.icon||!e.title||!e.subtitle||!e.message||!e.detail||!e.cancel||!e.confirm){
        resolve(true);
        return;
      }

      if(dvModalResolver){
        const previous=dvModalResolver;
        dvModalResolver=null;
        previous(false);
      }

      dvModalResolver=resolve;
      dvModalPreviousFocus=document.activeElement;

      configureIcon(e.icon,type);
      e.title.textContent=title;
      e.subtitle.textContent=type==='error'?'Se produjo un inconveniente':'Operación completada';
      e.message.textContent=message;
      e.detail.textContent=detail||'';
      e.detail.style.display=detail?'block':'none';

      e.cancel.style.display='none';

      const buttonMode=type==='error'?'error':'success';
      e.confirm.className=`dv-decision-btn confirm ${buttonMode}`;
      e.confirm.innerHTML=`<i class="fa-solid ${type==='error'?'fa-xmark':'fa-check'}"></i><span>${escapeHtml(buttonText)}</span>`;
      e.confirm.onclick=()=>closeModal(true);

      e.modal.onclick=event=>{
        if(event.target===e.modal)closeModal(true);
      };

      dvModalKeyHandler=event=>{
        if(event.key==='Escape'||event.key==='Enter'){
          event.preventDefault();
          closeModal(true);
        }
      };
      document.addEventListener('keydown',dvModalKeyHandler);

      document.body.classList.add('dv-modal-open');
      e.modal.classList.remove('dv-hidden');

      requestAnimationFrame(()=>{
        try{e.confirm.focus();}catch(_){}
      });
    });
  };
})();


/* datavault-backend-22-38-adapter-v1 */

/* =========================================================
   FRONTEND ADAPTER · BACKEND 22–38
   - Drive por niveles: /drive/browse
   - Breadcrumb del backend
   - Un único authHeaders global
   - Loading/error/retry por nivel
   - Reporte: /reports/audit.xlsx
   ========================================================= */
(function(){
  const contexts={
    upload:{folderId:'root',data:null,error:null,loading:false,seq:0},
    move:{folderId:'root',data:null,error:null,loading:false,seq:0}
  };
  let moveSource=null;
  let moveSelected=null;

  // Memoria de navegación por usuario y por carpeta. Nunca persiste en el
  // navegador; el servidor sigue verificando permisos en cada operación.
  const folderMemory=new Map();
  const folderPending=new Map();
  const FOLDER_MEMORY_TTL_MS=30000;
  let folderCacheEpoch=0;
  let rootWarmupKey='';
  // Solo precargamos la primera capa de cada carpeta autorizada, con dos
  // peticiones simultáneas como máximo. No rastrea recursivamente Drive.
  function warmAssignedFolders(data,userId){
    if(currentRole==='jefe' || !userId)return;
    const roots=(Array.isArray(data?.folders)?data.folders:[])
      .map(f=>String(f?.id||'').trim()).filter(id=>id && id!=='root').slice(0,5);
    const signature=userId+':'+roots.join('|');
    if(rootWarmupKey===signature)return;
    rootWarmupKey=signature;
    const epoch=folderCacheEpoch;
    let next=0;
    async function worker(){
      while(next<roots.length && epoch===folderCacheEpoch && activeUserId()===userId){
        const id=roots[next++];
        try{await fetchFolder(id,false);}catch(_){ /* sin bloquear login ni selector */ }
      }
    }
    // La pantalla presenta "Mis carpetas" primero; la precarga es paralela.
    Promise.resolve().then(()=>Promise.all([worker(),worker()])).catch(()=>{});
  }
  function activeUserId(){return String(currentUser?.id||'');}
  function cacheKey(userId,id,files){return `${userId}:${files?'files':'folders'}:${id}`;}
  function clearFolderMemory(){
    folderCacheEpoch++;
    rootWarmupKey='';
    folderMemory.clear();
    folderPending.clear();
    for(const ctx of Object.values(contexts)){
      ctx.seq++;
      ctx.folderId='root';ctx.data=null;ctx.error=null;ctx.loading=false;
    }
  }

  const esc=v=>typeof escapeHtml==='function'?escapeHtml(v):String(v??'');
  const norm=v=>String(v??'').trim().toLowerCase();

  function context(name){return contexts[name];}

  async function fetchFolder(folderId='root',includeFiles=false,force=false){
    const id=String(folderId||'root').trim()||'root';
    const userId=activeUserId();
    if(!userId)throw new Error('Inicia sesión para consultar tus carpetas.');
    const key=cacheKey(userId,id,includeFiles);
    if(force)folderMemory.delete(key);
    const remembered=folderMemory.get(key);
    if(!force && remembered && remembered.expiresAt>Date.now())return remembered.data;
    if(!force && folderPending.has(key))return folderPending.get(key);
    const epoch=folderCacheEpoch;
    const request=(async()=>{
      const headers=await authHeaders(false);
      const url=`${API_URL}/drive/browse?folder_id=${encodeURIComponent(id)}&include_files=${includeFiles?'true':'false'}`;
      const response=await fetch(url,{method:'GET',headers,cache:'no-store'});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(dvHttpErrorMessage(response,data,'No se pudo cargar Google Drive.'));
      // No reutilizar datos recibidos después del cierre de sesión ni los
      // resultados de una consulta desplazada por una actualización forzada.
      if(epoch===folderCacheEpoch && activeUserId()===userId && folderPending.get(key)===request){
        folderMemory.set(key,{data,expiresAt:Date.now()+FOLDER_MEMORY_TTL_MS});
        if(id==='root' && !includeFiles && !force)warmAssignedFolders(data,userId);
      }
      return data;
    })();
    folderPending.set(key,request);
    try{return await request;}
    finally{if(folderPending.get(key)===request)folderPending.delete(key);}
  }

  // Se inicia después del login, sin bloquear la pantalla. El selector reutiliza
  // la misma promesa si el usuario elige un archivo mientras aún está cargando.
  function prefetchAllowedFolders(){
    if(currentRole==='jefe'||!activeUserId())return;
    fetchFolder('root',false).catch(()=>{});
  }

  function listElement(name){
    return document.getElementById(name==='upload'?'dvUploadDestinationList':'dvMoveFolderList');
  }

  function searchValue(name){
    const id=name==='upload'?'dvUploadDestinationSearch':'dvMoveSearch';
    return norm(document.getElementById(id)?.value||'');
  }

  function browseActionName(name){return name==='upload'?'dvBrowseUploadFolder':'dvBrowseMoveFolder';}
  function selectActionName(name){return name==='upload'?'dvSelectUploadCurrentFolder':'dvSelectMoveCurrentFolder';}
  function retryActionName(name){return name==='upload'?'dvRetryUploadDriveFolder':'dvRetryMoveDriveFolder';}

  function normalizeFolderId(value,{allowRoot=true}={}){
    const id=String(value??'').trim();
    if(id)return id;
    return allowRoot?'root':'';
  }

  function browseDataAttrs(name,folderId,kind='folder'){
    const id=normalizeFolderId(folderId,{allowRoot:kind==='root'});
    return `data-dv-browse-context="${esc(name)}" data-dv-browse-kind="${esc(kind)}" data-dv-folder-id="${esc(id)}"`;
  }

  function breadcrumbHtml(name,data){
    const crumbs=Array.isArray(data?.breadcrumb)?data.breadcrumb.filter(Boolean):[];
    if(!crumbs.length){
      return `<div class="dv-browse-breadcrumb"><button type="button" ${browseDataAttrs(name,'root','root')}>Mi unidad</button></div>`;
    }
    const html=crumbs.map((item,index)=>{
      const rawId=String(item?.id??'').trim();
      const id=rawId || (index===0?'root':'');
      const label=item?.name||(index===0?'Mi unidad':`Nivel ${index+1}`);
      const sep=index?'<i class="fa-solid fa-chevron-right"></i>':'';
      if(!id)return `${sep}<span class="text-slate-400">${esc(label)}</span>`;
      return `${sep}<button type="button" ${browseDataAttrs(name,id,index===0&&id==='root'?'root':'breadcrumb')}>${esc(label)}</button>`;
    }).join('');
    return `<div class="dv-browse-breadcrumb">${html}</div>`;
  }

  function visualPath(data){
    const path=String(data?.current?.path||'').trim();
    if(path)return path;
    const crumbs=Array.isArray(data?.breadcrumb)?data.breadcrumb:[];
    const joined=crumbs.map(x=>String(x?.name||'').trim()).filter(Boolean).join(' / ');
    return joined||String(data?.current?.name||'Mi unidad').trim()||'Mi unidad';
  }

  function moveRestriction(current){
    if(!moveSource||!current)return '';
    const currentId=String(current?.id||'');
    if(moveSource.currentParent && currentId===String(moveSource.currentParent))return 'Esta es la ubicación actual.';
    if(moveSource.kind==='CARPETA'){
      if(moveSource.driveId && currentId===String(moveSource.driveId))return 'No puedes mover una carpeta dentro de sí misma.';
      const ids=(Array.isArray(current?.breadcrumb)?current.breadcrumb:[]).map(x=>String(x?.id||''));
      if(moveSource.driveId && ids.includes(String(moveSource.driveId)) && currentId!==String(moveSource.driveId)){
        return 'No puedes moverla dentro de una subcarpeta propia.';
      }
    }
    return '';
  }

  function render(name){
    const ctx=context(name);
    const list=listElement(name);
    if(!ctx||!list)return;

    if(ctx.loading){
      list.innerHTML='<div class="dv-browse-loading"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Cargando carpetas...</div>';
      return;
    }
    if(ctx.error){
      list.innerHTML=`<div class="dv-browse-error"><i class="fa-solid fa-triangle-exclamation"></i><b>No se pudo cargar Google Drive.</b><span>${esc(ctx.error.message||String(ctx.error))}</span><button type="button" class="dv-browse-retry" onclick="${retryActionName(name)}()"><i class="fa-solid fa-rotate mr-1"></i>Reintentar</button></div>`;
      return;
    }
    const data=ctx.data;
    if(!data){list.innerHTML='<div class="dv-browse-empty">Selecciona una ubicación.</div>';return;}

    const q=searchValue(name);
    const folders=(Array.isArray(data.folders)?data.folders:[]).filter(f=>!q||norm(f?.name).includes(q));
    const current=data.current||{};
    const restriction=current?.selectable===false?'Selecciona una carpeta autorizada.':(name==='move'?moveRestriction(current):'');
    const isSelected=name==='upload'
      ? String(dvUploadDestinationSelectedId||'')===String(current?.id||'')
      : String(moveSelected?.id||'')===String(current?.id||'');

    const selectButton=restriction
      ? `<button type="button" class="dv-browse-select-current" disabled title="${esc(restriction)}">No disponible</button>`
      : `<button type="button" class="dv-browse-select-current" onclick="${selectActionName(name)}()"><i class="fa-solid fa-check mr-1"></i>${isSelected?'Seleccionada':'Seleccionar esta carpeta'}</button>`;

    const currentCard=`<div class="dv-browse-current"><div class="dv-browse-current-main"><div class="dv-browse-current-icon"><i class="fa-solid fa-folder-open"></i></div><div class="dv-browse-current-text"><b>${esc(current?.name||'Mi unidad')}</b><small>${esc(visualPath(data))}</small></div></div><div class="flex items-center gap-2">${isSelected?'<span class="dv-browse-selected-badge"><i class="fa-solid fa-circle-check"></i>Destino</span>':''}${selectButton}</div></div>`;

    const validFolders=folders.filter(folder=>normalizeFolderId(folder?.id,{allowRoot:false}));
    const missingIdCount=folders.length-validFolders.length;
    if(missingIdCount){
      console.warn('[DRIVE BROWSE] Se ignoraron carpetas sin id:',missingIdCount);
    }
    const folderRows=validFolders.length
      ? `<div class="dv-browse-folder-list">${validFolders.map(folder=>`<button type="button" class="dv-browse-folder" ${browseDataAttrs(name,folder.id,'folder')}><i class="fa-solid fa-folder"></i><span>${esc(folder?.name||'Carpeta')}</span>${folder?.modifiedTime?`<small>${esc(new Date(folder.modifiedTime).toLocaleDateString('es-PE'))}</small>`:''}<i class="fa-solid fa-chevron-right text-slate-300 text-[8px]"></i></button>`).join('')}</div>`
      : `<div class="dv-browse-empty"><i class="fa-solid fa-folder-open mr-1"></i>${q?'No hay carpetas que coincidan en este nivel.':'Esta carpeta no contiene subcarpetas.'}</div>`;

    list.innerHTML=`<div class="dv-browse-shell">${breadcrumbHtml(name,data)}${currentCard}${folderRows}</div>`;
  }

  async function load(name,folderId,force=false){
    const ctx=context(name);if(!ctx)return;
    const requested=normalizeFolderId(folderId??ctx.folderId,{allowRoot:true});
    if(!requested)return;

    // Evita que dos handlers disparen la misma navegación al mismo tiempo.
    if(!force && ctx.loading && String(ctx.folderId||'')===requested)return;

    // Si ya estamos mostrando exactamente este nivel, no repetir la consulta
    // salvo que el usuario haya pulsado Actualizar/Reintentar.
    const visibleId=normalizeFolderId(ctx.data?.current?.id,{allowRoot:false});
    if(!force && ctx.data && String(ctx.folderId||'')===requested && visibleId===requested){
      render(name);
      return;
    }

    const seq=++ctx.seq;
    ctx.folderId=requested;
    ctx.loading=true;ctx.error=null;
    render(name);
    try{
      const data=await fetchFolder(requested,false,force);
      if(seq!==ctx.seq)return;
      ctx.data=data;
      ctx.folderId=normalizeFolderId(data?.current?.id??requested,{allowRoot:true});
    }catch(error){
      if(seq!==ctx.seq)return;
      ctx.error=error;
    }finally{
      if(seq===ctx.seq){ctx.loading=false;render(name);}
    }
  }

  function sourceForMove(kind,id){
    const target=String(id||'');
    if(kind==='CARPETA'){
      const rows=(auditCache||[]).filter(r=>String(r?.lote_id||'')===target);
      const row=rows[0]||{};
      return {kind:'CARPETA',id:target,name:(typeof dvRoot==='function'?dvRoot(row):'')||'Carpeta',driveId:String(row?.drive_folder_id||''),currentParent:String(row?.drive_parent_id||'')};
    }
    const row=(auditCache||[]).find(r=>String(r?.id||'')===target)||{};
    return {kind:'ARCHIVO',id:target,name:row?.nombre_archivo||'Archivo',driveId:String(row?.drive_file_id||''),currentParent:String(row?.drive_parent_id||'')};
  }

  function ensureMoveModal(){
    if(document.getElementById('dvOperationModal'))return;
    const modal=document.createElement('div');
    modal.id='dvOperationModal';modal.className='dv-hidden';
    modal.innerHTML=`<div class="dv-op-modal-card"><div class="dv-op-modal-head"><div><p class="text-[10px] uppercase tracking-widest text-slate-400 font-bold">Solicitud de movimiento</p><h3 class="text-lg font-extrabold text-slate-800 mt-1" id="dvMoveTitle">Mover elemento</h3><p class="text-xs text-slate-500 mt-1">Navega por Google Drive por niveles y selecciona la carpeta destino.</p></div><button type="button" class="icon-btn" onclick="dvCloseMoveModal()"><i class="fa-solid fa-xmark"></i></button></div><div class="dv-op-modal-body space-y-4"><div><label class="field-label">Buscar en esta carpeta</label><div class="dv-folder-search"><i class="fa-solid fa-magnifying-glass"></i><input id="dvMoveSearch" class="input-modern w-full" placeholder="Buscar en esta carpeta..." autocomplete="off" oninput="dvFilterMoveFolders()"></div></div><div id="dvMoveFolderList" class="dv-folder-tree"><div class="dv-browse-loading"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Cargando carpetas...</div></div><div id="dvMoveSelection" class="dv-move-selection">Navega hasta la carpeta destino y pulsa <b>Seleccionar esta carpeta</b>.</div><div id="dvMoveMessage" class="text-xs text-slate-500"></div><div class="flex justify-end gap-2"><button type="button" class="secondary-btn" onclick="dvCloseMoveModal()">Cancelar</button><button type="button" class="primary-btn" id="dvMoveSubmit" onclick="dvSubmitMoveRequest()" disabled><i class="fa-solid fa-paper-plane"></i>Solicitar movimiento</button></div></div></div>`;
    modal.addEventListener('click',event=>{if(event.target===modal)window.dvCloseMoveModal();});
    document.body.appendChild(modal);
  }

  window.dvBrowseUploadFolder=function(folderId){
    const id=normalizeFolderId(folderId,{allowRoot:false});
    if(!id){console.warn('[DRIVE BROWSE] Carpeta de subida sin id; navegación cancelada.');return;}
    const search=document.getElementById('dvUploadDestinationSearch');if(search)search.value='';
    return load('upload',id);
  };
  window.dvRetryUploadDriveFolder=function(){return load('upload',contexts.upload.folderId||'root',true);};
  window.dvFilterUploadDestinations=function(){render('upload');};
  window.dvSelectUploadCurrentFolder=function(){
    const current=contexts.upload.data?.current;if(!current?.id||current.selectable===false)return;
    dvUploadDestinationSelectedId=String(current.id);
    dvUploadDestinationSelectedPath=visualPath(contexts.upload.data);
    const selection=document.getElementById('dvUploadDestinationSelection');
    if(selection)selection.innerHTML=`Destino seleccionado:<br><strong><i class="fa-solid fa-folder mr-1 text-amber-500"></i>${esc(dvUploadDestinationSelectedPath)}</strong>`;
    if(typeof dvRefreshUploadButtonState==='function')dvRefreshUploadButtonState();
    render('upload');
  };
  // Compatibilidad: el selector nuevo selecciona la carpeta actual; no construye jerarquías en frontend.
  window.dvSelectUploadDestination=function(folderId){return window.dvBrowseUploadFolder(folderId);};

  window.dvEnsureUploadDestinationFolders=async function(force=false){
    const panel=document.getElementById('dvUploadDestinationPanel');
    if(typeof dvSelectedEntries!=='undefined' && !dvSelectedEntries.length){if(panel)panel.classList.add('hidden');return;}
    if(panel)panel.classList.remove('hidden');
    const currentId=contexts.upload.folderId||'root';
    if(!contexts.upload.data || force)return load('upload',force?'root':currentId,force);
    render('upload');
  };
  // Rebind global identifier used by existing code/onclick handlers.
  try{dvEnsureUploadDestinationFolders=window.dvEnsureUploadDestinationFolders;}catch(_){}
  try{dvFilterUploadDestinations=window.dvFilterUploadDestinations;}catch(_){}
  try{dvSelectUploadDestination=window.dvSelectUploadDestination;}catch(_){}

  const oldReset=typeof dvResetUploadDestination==='function'?dvResetUploadDestination:null;
  window.dvResetUploadDestination=function(){
    dvUploadDestinationSelectedId='';dvUploadDestinationSelectedPath='';
    contexts.upload={folderId:'root',data:null,error:null,loading:false,seq:contexts.upload.seq+1};
    const search=document.getElementById('dvUploadDestinationSearch');if(search)search.value='';
    const selection=document.getElementById('dvUploadDestinationSelection');
    if(selection)selection.innerHTML='Elige una carpeta autorizada y, si deseas, entra a una de sus subcarpetas.';
    if(typeof dvRefreshUploadButtonState==='function')dvRefreshUploadButtonState();
  };
  try{dvResetUploadDestination=window.dvResetUploadDestination;}catch(_){}

  window.dvBrowseMoveFolder=function(folderId){
    const id=normalizeFolderId(folderId,{allowRoot:false});
    if(!id){console.warn('[DRIVE BROWSE] Carpeta de movimiento sin id; navegación cancelada.');return;}
    const search=document.getElementById('dvMoveSearch');if(search)search.value='';
    return load('move',id);
  };
  window.dvRetryMoveDriveFolder=function(){return load('move',contexts.move.folderId||'root',true);};
  window.dvFilterMoveFolders=function(){render('move');};
  window.dvSelectMoveCurrentFolder=function(){
    const data=contexts.move.data;const current=data?.current;if(!current?.id||current.selectable===false)return;
    const restriction=moveRestriction(current);
    if(restriction){if(typeof dvShowMessageModal==='function')dvShowMessageModal({type:'error',title:'Destino no válido',message:restriction});return;}
    moveSelected={id:String(current.id),path:visualPath(data),name:current.name||'Carpeta'};
    const selection=document.getElementById('dvMoveSelection');
    if(selection)selection.innerHTML=`Destino seleccionado:<br><strong><i class="fa-solid fa-folder mr-1 text-amber-500"></i>${esc(moveSelected.path)}</strong>`;
    const btn=document.getElementById('dvMoveSubmit');if(btn)btn.disabled=false;
    render('move');
  };

  window.dvCloseMoveModal=function(){
    document.getElementById('dvOperationModal')?.classList.add('dv-hidden');
    moveSource=null;moveSelected=null;
    contexts.move={folderId:'root',data:null,error:null,loading:false,seq:contexts.move.seq+1};
  };

  window.dvRequestMove=async function(kind,id){
    ensureMoveModal();
    moveSource=sourceForMove(kind,id);moveSelected=null;
    const modal=document.getElementById('dvOperationModal');if(!modal)return;
    modal.classList.remove('dv-hidden');
    const title=document.getElementById('dvMoveTitle');if(title)title.textContent=`Mover ${kind==='CARPETA'?'carpeta':'archivo'}: ${moveSource.name}`;
    const selection=document.getElementById('dvMoveSelection');if(selection)selection.innerHTML='Navega hasta la carpeta destino y pulsa <b>Seleccionar esta carpeta</b>.';
    const submit=document.getElementById('dvMoveSubmit');if(submit){submit.disabled=true;submit.innerHTML='<i class="fa-solid fa-paper-plane"></i>Solicitar movimiento';}
    const msg=document.getElementById('dvMoveMessage');if(msg)msg.textContent='Solo se registra la solicitud. El backend ejecutará el movimiento después de la aprobación del custodio.';
    await load('move','root');
  };

  window.dvSubmitMoveRequest=async function(){
    if(!moveSource||!moveSelected?.id)return;
    const btn=document.getElementById('dvMoveSubmit');
    try{
      if(btn){btn.disabled=true;btn.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i> Enviando...';}
      const payload={tipo_operacion:'MOVER',objeto_tipo:moveSource.kind,carpeta_destino_id:String(moveSelected.id)};
      if(moveSource.kind==='CARPETA')payload.lote_id=moveSource.id;else payload.auditoria_id=moveSource.id;
      const response=await fetch(`${API_URL}/operations/request`,{method:'POST',headers:await authHeaders(true),body:JSON.stringify(payload)});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(dvHttpErrorMessage(response,data,'No se pudo solicitar el movimiento.'));
      const selectedPath=moveSelected?.path||'';
      window.dvCloseMoveModal();
      if(typeof dvShowMessageModal==='function')await dvShowMessageModal({type:'success',title:'Solicitud enviada',message:'La solicitud de movimiento fue enviada al custodio.',detail:`Destino: ${selectedPath}`});
      if(typeof loadCola==='function')await loadCola();
      if(typeof loadFilesView==='function')await loadFilesView();
    }catch(error){
      if(typeof dvShowMessageModal==='function')await dvShowMessageModal({type:'error',title:'No se pudo solicitar el movimiento',message:error?.message||String(error)});
      else alert(error?.message||String(error));
    }finally{
      if(btn){btn.disabled=!moveSelected?.id;btn.innerHTML='<i class="fa-solid fa-paper-plane"></i>Solicitar movimiento';}
    }
  };

  function handleBrowseClick(event){
    const button=event.target.closest?.('[data-dv-browse-context][data-dv-folder-id]');
    if(!button)return;
    const list=button.closest?.('#dvUploadDestinationList,#dvMoveFolderList');
    if(!list)return;
    const name=button.dataset.dvBrowseContext;
    const kind=button.dataset.dvBrowseKind||'folder';
    const allowRoot=kind==='root';
    const id=normalizeFolderId(button.dataset.dvFolderId,{allowRoot});
    if(!id){
      console.warn('[DRIVE BROWSE] Click ignorado: carpeta sin id.',button);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const search=document.getElementById(name==='upload'?'dvUploadDestinationSearch':'dvMoveSearch');
    if(search)search.value='';
    load(name,id);
  }

  document.addEventListener('click',handleBrowseClick);
  let browseHoverTimer=null;
  document.addEventListener('pointerover',event=>{
    if(currentRole==='jefe' || event.pointerType==='touch')return;
    const button=event.target.closest?.('[data-dv-browse-kind="folder"][data-dv-folder-id]');
    if(!button || !button.closest('#dvUploadDestinationList,#dvMoveFolderList'))return;
    clearTimeout(browseHoverTimer);
    const id=String(button.dataset.dvFolderId||'');
    const uid=activeUserId();
    if(!uid || !id || folderMemory.has(cacheKey(uid,id,false)) || folderPending.has(cacheKey(uid,id,false)))return;
    browseHoverTimer=setTimeout(()=>{
      if(uid===activeUserId())fetchFolder(id,false).catch(()=>{});
    },180);
  },true);

  // API pública para drag & drop y futuras vistas. No expone ni maneja la caché interna.
  window.DVDriveBrowser={
    fetchFolder,
    prefetchAllowedFolders,
    clearCache:clearFolderMemory,
    loadUpload:(folderId='root')=>load('upload',folderId),
    loadMove:(folderId='root')=>load('move',folderId),
    refreshUpload:()=>load('upload',contexts.upload.folderId||'root',true),
    refreshMove:()=>load('move',contexts.move.folderId||'root',true),
    getUploadState:()=>contexts.upload,
    getMoveState:()=>contexts.move
  };

  // El botón Actualizar del selector recarga únicamente el nivel visible.
  document.addEventListener('DOMContentLoaded',()=>{
    const refresh=document.querySelector('#dvUploadDestinationPanel .dv-upload-destination-head .icon-btn');
    if(refresh){
      refresh.setAttribute('title','Actualizar esta carpeta');
      refresh.setAttribute('onclick','dvEnsureUploadDestinationFolders(true)');
    }
  });
})();


/* datavault-drive-browse-fast-preload-v1 */
(function(){
  const originalEnterApp=enterApp;
  enterApp=function(){
    const result=originalEnterApp();
    // Precarga no bloqueante de las cinco carpetas autorizadas.
    try{window.DVDriveBrowser?.prefetchAllowedFolders?.();}catch(_){}
    return result;
  };
  const originalLogout=handleLogout;
  handleLogout=async function(){
    // No compartir carpetas en memoria entre usuarios del mismo navegador.
    try{window.DVDriveBrowser?.clearCache?.();}catch(_){}
    return originalLogout();
  };
})();
