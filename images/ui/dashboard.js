/* Presentation layer for the selected GM interface. No sample data or tokens. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const norm = v => String(v ?? '').trim().toLowerCase();
  const upper = v => String(v ?? '').trim().toUpperCase();
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const admin = () => ['jefe','admin','administrador'].includes(norm(currentRole));
  const state = {audit:null, ops:[], requests:null, users:null, policies:null, pending:[], recent:[], refreshedAt:null, metaAt:0, userId:'', activeNav:'inicio'};
  let metaPromise = null;
  let fileMenuContext = null;

  function isMine(row) {
    const uid = String(currentUser?.id || '');
    const owner = String(row?.solicitante_id || row?.userId || '');
    if (uid && owner) return uid === owner;
    const email = norm(currentUserEmail || currentUser?.email);
    const ownerEmail = norm(row?.solicitante_correo || row?.email);
    if (email && ownerEmail) return email === ownerEmail;
    const name = norm(currentDisplayName);
    return !!name && norm(row?.solicitante_nombre || row?.usuario_solicitante || row?.user) === name;
  }

  function personalRows(rows) { return admin() ? rows : rows.filter(isMine); }
  function deleted(row) { return (upper(row?.estado)==='APROBADO' && row?.en_drive===false) || upper(row?.estado_archivo).startsWith('ELIMINADO') || !!row?.fecha_eliminacion; }
  function active(row) { return upper(row?.estado) === 'APROBADO' && !deleted(row); }
  function rowDate(row) { return row?.fecha_ultima_operacion || row?.fecha_respuesta || row?.fecha_solicitud || row?.date || ''; }
  function groupState(rows) {
    if (rows.some(r => upper(r.estado) === 'PENDIENTE')) return 'PENDIENTE';
    return typeof dvGroupState === 'function' ? dvGroupState(rows) : upper(rows[0]?.estado || 'PENDIENTE');
  }
  function units(rows) {
    if (typeof dvGroupedUnits === 'function') return dvGroupedUnits(rows);
    return rows.map(r => ({type:'file', row:r, date:rowDate(r), id:r.id}));
  }
  function rootName(row) { return typeof dvRoot === 'function' ? dvRoot(row) : String(row?.carpeta_origen || row?.carpeta || 'Carpeta'); }

  function requestRows() {
    if (Array.isArray(state.requests)) return personalRows(state.requests);
    const audit = personalRows(state.audit || []);
    const result = units(audit).map(u => {
      const folder = u.type === 'folder';
      const rows = folder ? u.rows : [u.row];
      const r = rows[0] || {};
      return {kind:'UPLOAD', id:folder ? u.id : r.id, unit:u,
        type:folder ? 'Subida de carpeta' : 'Subida de archivo',
        origin:folder ? rootName(r) : r.nombre_archivo || 'Archivo',
        dest:r.ubicacion_drive || r.carpeta_destino_nombre || 'Destino solicitado',
        user:r.solicitante_nombre || r.usuario_solicitante || 'Usuario',
        userId:r.solicitante_id || '', email:r.solicitante_correo || '',
        date:u.date || rowDate(r), state:groupState(rows),
        pendingChildren:rows.filter(x => upper(x.estado) === 'PENDIENTE').length};
    });
    for (const r of personalRows(state.ops || [])) {
      const move = upper(r.tipo_operacion) === 'MOVER';
      result.push({kind:'OP', id:r.id, opType:upper(r.tipo_operacion),
        type:move ? 'Movimiento' : 'Eliminación', origin:r.nombre_objeto || r.carpeta_origen || 'Archivo',
        dest:move ? r.carpeta_destino_nombre || 'Destino solicitado' : 'Papelera',
        user:r.solicitante_nombre || 'Usuario', userId:r.solicitante_id || '', email:r.solicitante_correo || '',
        date:r.fecha_solicitud || '', state:upper(r.estado || 'PENDIENTE')});
    }
    return result.sort((a,b) => String(b.date).localeCompare(String(a.date)));
  }

  function dateText(value, short=false) {
    const d = new Date(value);
    if (!value || Number.isNaN(d.getTime())) return '—';
    return new Intl.DateTimeFormat('es-PE', {timeZone:'America/Lima', day:'numeric', month:'short', ...(short ? {} : {year:'numeric'}), hour:'2-digit', minute:'2-digit', hour12:false}).format(d);
  }
  function relative(value) {
    const d = Date.parse(value);
    if (!Number.isFinite(d)) return '—';
    const minutes = Math.max(0, Math.floor((Date.now() - d)/60000));
    if (minutes < 1) return 'Hace un momento';
    if (minutes < 60) return `Hace ${minutes} min`;
    if (minutes < 1440) { const n = Math.floor(minutes/60); return `Hace ${n} ${n===1?'hora':'horas'}`; }
    const days = Math.floor(minutes/1440);
    return days < 8 ? `Hace ${days} ${days===1?'día':'días'}` : new Intl.DateTimeFormat('es-PE',{timeZone:'America/Lima',day:'numeric',month:'short'}).format(new Date(d));
  }
  function typeOf(name, folder=false) { return folder ? 'CARPETA' : String(name || '').split('.').pop().toUpperCase().slice(0,8) || 'ARCHIVO'; }
  function fileIcon(name, folder=false) {
    const ext = norm(typeOf(name,folder));
    const icon = folder ? 'folder' : ext === 'pdf' ? 'file-pdf' : ['doc','docx'].includes(ext) ? 'file-word' : ['xls','xlsx','csv'].includes(ext) ? 'file-excel' : 'file-lines';
    return `<span class="dv-file-type ${folder?'folder':esc(ext)}"><i class="fa-solid fa-${icon}" aria-hidden="true"></i></span>`;
  }
  function pill(value) {
    const v = upper(value);
    const c = v === 'APROBADO' ? 'approved' : v === 'PENDIENTE' ? 'pending' : v === 'RECHAZADO' ? 'rejected' : 'neutral';
    const label = v === 'APROBADO' ? 'Aprobado' : v === 'PENDIENTE' ? 'Pendiente' : v === 'RECHAZADO' ? 'Rechazado' : v === 'ELIMINADO' ? 'Eliminado' : value || '—';
    return `<span class="dv-state-pill ${c}">${esc(label)}</span>`;
  }
  function setText(id,value) { if ($(id)) $(id).textContent = value; }
  function setCard(index,label,value,trend,color,icon) {
    const card = document.querySelectorAll('#view-inicio .dv-metric')[index];
    if (!card) return;
    const labels = ['.metric-label','.metric-value','.metric-trend'];
    [label,value,trend].forEach((text,i) => {const el=card.querySelector(labels[i]); if(el)el.textContent=text;});
    const holder = card.querySelector('.metric-icon');
    const signature = `${color}:${icon}`;
    if (holder && holder.dataset.uiIcon !== signature) {
      holder.className = `metric-icon ${color}`;
      holder.dataset.uiIcon = signature;
      holder.innerHTML = `<i class="fa-solid fa-${icon}" aria-hidden="true"></i>`;
    }
    card.style.removeProperty('cursor'); card.removeAttribute('title'); card.onclick = null;
  }

  function countFolders(rows) {
    const folders = new Set();
    for (const r of rows) {
      const path = String(r.ruta_relativa || '').replace(/\\/g,'/').replace(/^\/+|\/+$/g,'');
      const parts = path.split('/').filter(Boolean);
      for (let i=1;i<parts.length;i++) folders.add(parts.slice(0,i).join('/'));
      if (parts.length < 2 && r.lote_id) folders.add(`${r.lote_id}:${rootName(r)}`);
    }
    return folders.size;
  }
  function activeUserCount() {
    if (!state.users) return '—';
    const since = Date.now() - 30*86400000;
    return state.users.filter(u => Date.parse(u.last_sign_in_at || '') >= since).length;
  }

  function renderCards(requests) {
    const ready = state.audit !== null;
    const inventory = personalRows(state.audit || []).filter(active);
    const approved = requests.filter(r => upper(r.state) === 'APROBADO').length;
    const pending = requests.filter(r => upper(r.state) === 'PENDIENTE' || r.pendingChildren > 0).length;
    if (admin()) {
      setCard(0,'Archivos totales',ready?inventory.length:'—','Inventario activo en Drive','blue','file-lines');
      setCard(1,'Pendientes',ready?pending:'—','Solicitudes en revisión','orange','clock');
      setCard(2,'Aprobadas',ready?approved:'—','Historial de solicitudes','green','circle-check');
      setCard(3,'Usuarios activos',activeUserCount(),'Acceso en últimos 30 días','purple','users');
      const pendingCard = document.querySelectorAll('#view-inicio .dv-metric')[1];
      if (pendingCard) {pendingCard.style.cursor='pointer';pendingCard.title='Ver solicitudes pendientes';pendingCard.onclick=()=>window.dvOpenRequests('PENDIENTE');}
    } else {
      setCard(0,'Mis archivos',ready?inventory.length:'—','Archivos en mi unidad','blue','file-lines');
      setCard(1,'Mis carpetas',ready?countFolders(inventory):'—','Carpetas con archivos','orange','folder');
      setCard(2,'Mis solicitudes',ready?requests.length:'—','En total','green','file-lines');
      setCard(3,'Aprobadas',ready?approved:'—','Historial de solicitudes','green','circle-check');
    }
    for (const id of ['bellBadge','topBellBadge','dvSideRequestBadge']) {
      const el=$(id); if(!el)continue;
      el.textContent=pending>99?'99+':String(pending);el.classList.toggle('hidden',pending===0);
    }
    if (ready) {
      const bytes=inventory.reduce((sum,r)=>sum+Math.max(0,Number(r.tamano_bytes)||0),0);
      setText('dvStorageUsed',typeof formatBytes==='function'?formatBytes(bytes):`${bytes} B`);
      // Drive's quota is not exposed by the backend; avoid inventing 50 GB.
      $('dvStorageBar').style.width=bytes>0?'100%':'0%';
      $('dvStorageBar').parentElement.title='Tamaño de los archivos activos registrados; la cuota de Drive no está disponible.';
    }
  }

  function renderRecent() {
    const target=$('inicioRecentFilesBody');if(!target)return;
    state.recent=units(personalRows(state.audit||[])).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))).slice(0,5);
    target.innerHTML=state.recent.length?state.recent.map((u,index)=>{
      const folder=u.type==='folder',rows=folder?u.rows:[u.row],r=rows[0]||{};
      const name=folder?rootName(r):r.nombre_archivo||'Sin nombre';
      const stateText=rows.every(deleted)?'ELIMINADO':groupState(rows);
      return `<tr><td><span class="dv-document" title="${esc(name)}">${fileIcon(name,folder)}<span class="dv-document-label">${esc(name)}</span></span></td><td>${esc(typeOf(name,folder))}</td><td>${esc(dateText(u.date||rowDate(r)))}</td><td>${pill(stateText)}</td><td><button class="dv-more-button" type="button" data-dv-file-menu="${index}" aria-label="Acciones de ${esc(name)}" title="Acciones">···</button></td></tr>`;
    }).join(''):`<tr><td colspan="5" class="dv-empty-table">${state.audit===null?'Cargando archivos...':'No hay archivos registrados.'}</td></tr>`;
  }
  function operationShort(r) { return r.kind==='UPLOAD' ? 'Subida' : upper(r.opType)==='MOVER' ? 'Movimiento' : 'Eliminación'; }
  function decisions(r,index) {
    if (!r.id) return '—';
    return `<div class="dv-home-decisions"><button type="button" class="dv-home-decision" data-home-decision="APROBAR" data-request-index="${index}"><i class="fa-solid fa-check" aria-hidden="true"></i>Aprobar</button><button type="button" class="dv-home-decision reject" data-home-decision="RECHAZAR" data-request-index="${index}"><i class="fa-solid fa-xmark" aria-hidden="true"></i>Rechazar</button></div>`;
  }
  function renderPending(requests) {
    const target=$('dvHomePendingBody');if(!target)return;
    state.pending=requests.filter(r=>upper(r.state)==='PENDIENTE'||r.pendingChildren>0).slice(0,5);
    target.innerHTML=state.pending.length?state.pending.map((r,index)=>`<tr><td><span class="dv-user-cell"><span class="dv-user-initial">${esc(String(r.user||'?').slice(0,1))}</span>${esc(r.user||'Usuario')}</span></td><td><span class="dv-document" title="${esc(r.origin)}">${fileIcon(r.origin,r.unit?.type==='folder')}<span class="dv-document-label">${esc(r.origin)}</span></span></td><td>${esc(operationShort(r))}</td><td>${esc(dateText(r.date,true))}</td><td>${decisions(r,index)}</td></tr>`).join(''):`<tr><td colspan="5" class="dv-empty-table">${state.audit===null?'Cargando solicitudes...':'No hay solicitudes pendientes.'}</td></tr>`;
  }

  function eventText(r,personal) {
    const approved=upper(r.state)==='APROBADO',rejected=upper(r.state)==='RECHAZADO';
    if (personal) {
      if(rejected)return 'Tu solicitud fue rechazada';
      if(approved)return r.kind==='UPLOAD'?'Tu archivo fue aprobado':'Tu operación fue aprobada';
      return r.kind==='UPLOAD'?'Subiste un archivo':'Enviaste una solicitud';
    }
    const action=operationShort(r).toLowerCase(), ending=action==='movimiento'?'o':'a';
    return `${r.user||'Usuario'} · ${action} ${approved?'aprobad'+ending:rejected?'rechazad'+ending:'solicitad'+ending}`;
  }
  function eventIcon(r) {
    const approved=upper(r.state)==='APROBADO',rejected=upper(r.state)==='RECHAZADO';
    const color=approved?'approved':rejected?'rejected':'pending';
    const icon=approved?'circle-check':rejected?'circle-xmark':r.kind==='UPLOAD'?'cloud-arrow-up':'clock';
    return `<span class="dv-event-icon ${color}"><i class="fa-solid fa-${icon}" aria-hidden="true"></i></span>`;
  }
  function renderRail(requests) {
    const rows=requests.slice().sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
    const requestTarget=$('dvHomeRequests');
    if(requestTarget)requestTarget.innerHTML=rows.length?rows.slice(0,4).map(r=>`<div class="dv-rail-item">${fileIcon(r.origin,r.unit?.type==='folder')}<div class="dv-rail-copy"><b title="${esc(r.origin)}">${esc(r.origin)}</b><span>${esc(relative(r.date))}</span></div>${pill(r.state)}</div>`).join(''):'<p class="dv-empty-mini">No hay solicitudes recientes.</p>';
    for(const [id,personal,count] of [['dvHomeEvents',true,3],['dvHomeTeamEvents',false,4]]){
      const target=$(id);if(!target)continue;
      target.innerHTML=rows.length?rows.slice(0,count).map(r=>`<div class="dv-rail-item dv-rail-event">${eventIcon(r)}<div class="dv-rail-copy"><b title="${esc(eventText(r,personal))}">${esc(eventText(r,personal))}</b><span><span title="${esc(r.origin)}">${esc(String(r.origin||'').slice(0,24))}</span><span>${esc(relative(r.date))}</span></span></div></div>`).join(''):'<p class="dv-empty-mini">No hay actividad reciente.</p>';
    }
  }

  function renderProtection() {
    const count=state.policies===null?'—':state.policies.filter(r=>r.activa===true).length;
    setText('dvUiPolicyCount',count);setText('gestorRuleCount',count);
    setText('dvUiLastRefresh',state.refreshedAt?relative(state.refreshedAt):'—');
    const badge=$('dvProtectionBadge');if(!badge)return;
    badge.textContent=state.policies===null?'No disponible':count>0?'Activo':'Sin reglas activas';
    badge.className=`dv-state-pill ${count>0?'approved':'neutral'}`;
  }
  function renderHistory() {
    const q=norm($('dvHistorySearch')?.value);
    const rows=requestRows().filter(r=>!q||norm([r.origin,r.user,r.type,r.dest].join(' ')).includes(q));
    const target=$('dvHistoryBody');if(!target)return;
    target.innerHTML=rows.length?rows.map(r=>`<tr><td><span class="dv-document">${fileIcon(r.origin,r.unit?.type==='folder')}<span class="dv-document-label">${esc(r.origin)}</span></span></td><td>${esc(r.user)}</td><td>${esc(r.type)}</td><td>${esc(dateText(r.date))}</td><td>${pill(r.state)}</td></tr>`).join(''):'<tr><td colspan="5" class="dv-empty-table">No hay actividad que coincida con la búsqueda.</td></tr>';
  }
  function renderHome() {
    const requests=requestRows();
    renderCards(requests);renderRecent();renderPending(requests);renderRail(requests);renderProtection();renderHistory();
  }

  function applyRole() {
    const isAdmin=admin();
    document.body.dataset.dvRole=isAdmin?'jefe':'subordinado';
    document.body.classList.toggle('dv-role-admin',isAdmin);document.body.classList.toggle('dv-role-sub',!isAdmin);
    for(const el of document.querySelectorAll('[data-ui-role]')){
      const visible=el.dataset.uiRole===(isAdmin?'admin':'sub');
      el.hidden=!visible;
      if(visible)el.classList.remove('hidden','role-hidden');
    }
    setText('dvFileNavLabel',isAdmin?'Explorador de archivos':'Mis archivos');
    setText('dvRequestNavLabel',isAdmin?'Aprobaciones':'Mis solicitudes');
    for(const id of ['userRoleBadge','profileRolTexto','profileRolBadge','solRoleMini'])setText(id,isAdmin?'Administrador':'Subordinado');
    setText('dashWelcome',currentDisplayName||'Usuario');
    setText('dvHeroSubtitle',isAdmin?'Supervisa los archivos y las solicitudes de todo el equipo.':'Aquí puedes gestionar y subir tus archivos de forma segura.');
    setText('dvHistoryDescription',isAdmin?'Consulta la actividad de los archivos y las solicitudes del equipo.':'Consulta la actividad de tus archivos y solicitudes.');
    renderProtection();
    updateActiveNav();
  }
  function updateActiveNav() {
    document.querySelectorAll('#sidebar .nav-item').forEach(el=>{
      const key=el.id==='navTrashDirect'?'trash':el.id==='navHistoryDirect'?'historial':el.id==='navSubirDirect'?'upload':el.dataset.nav;
      const active=key===state.activeNav;el.classList.toggle('active',active);
      if(active)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');
    });
  }
  function fileViewTitle(trash=false,upload=false) {
    const title=document.querySelector('#view-gestor .page-title h2'),description=document.querySelector('#view-gestor .page-title p');
    if(title)title.textContent=trash?'Papelera':upload?'Subir archivos':'Explorador de archivos';
    if(description)description.textContent=trash?'Archivos enviados a la papelera mediante una eliminación aprobada.':upload?'Selecciona archivos o una carpeta y elige el destino de la carga.':'Navega y gestiona tus archivos y carpetas.';
  }

  async function refreshMeta(force=false) {
    if(!admin()||!currentUser?.id)return;
    if(metaPromise)return metaPromise;
    if(!force && Date.now()-state.metaAt<60000)return;
    const uid=String(currentUser.id);
    metaPromise=(async()=>{
      let headers;
      try { headers=await authHeaders(false); } catch(_) { return; }
      const responses=await Promise.allSettled(['/admin/users','/dlp/policies'].map(async endpoint=>{
        const response=await fetch(`${API_URL}${endpoint}`,{headers});
        const data=await response.json();
        if(!response.ok)throw new Error(data?.detail||`HTTP ${response.status}`);
        return data;
      }));
      if(!admin()||String(currentUser?.id||'')!==uid)return;
      if(responses[0].status==='fulfilled')state.users=Array.isArray(responses[0].value.usuarios)?responses[0].value.usuarios:[];
      else state.users=null;
      if(responses[1].status==='fulfilled')state.policies=Array.isArray(responses[1].value.politicas)?responses[1].value.politicas:[];
      else state.policies=null;
      state.metaAt=Date.now();renderHome();
    })().catch(error=>console.warn('[GM UI metadata]',error)).finally(()=>{metaPromise=null;});
    return metaPromise;
  }

  const oldSetSession=setSessionFromUser;
  window.setSessionFromUser=setSessionFromUser=function(user){
    const changed=state.userId!==String(user?.id||'');
    if(changed){Object.assign(state,{audit:null,ops:[],requests:null,users:null,policies:null,metaAt:0,refreshedAt:null,activeNav:'inicio',userId:String(user?.id||'')});closeFileMenu();}
    const result=oldSetSession(user);applyRole();renderHome();void refreshMeta();return result;
  };

  const previousShow=window.showView||showView;
  window.showView=showView=function(name){
    let target=name==='operaciones'?'gestor':name;
    const allowed=admin()?['inicio','gestor','cola','reglas','reportes','auditoria','usuarios','historial']:['inicio','gestor','cola','historial'];
    if(!allowed.includes(target))target='inicio';
    if(target==='historial'){
      document.querySelectorAll('.view').forEach(el=>el.classList.remove('active'));$('view-historial').classList.add('active');
      state.activeNav='historial';document.body.classList.remove('dv-trash-mode');applyRole();renderHistory();closeMobileSidebar();
      if(typeof dvRefreshDashboardInventory==='function')dvRefreshDashboardInventory('history');return;
    }
    const result=previousShow(target);
    state.activeNav=target;
    if(target!=='gestor')document.body.classList.remove('dv-trash-mode');
    applyRole();
    if(target==='gestor')fileViewTitle(document.body.classList.contains('dv-trash-mode'));
    if(target==='inicio'){renderHome();void refreshMeta();}
    closeFileMenu();return result;
  };

  window.dvOpenHome=()=>showView('inicio');
  window.dvOpenFiles=function(){document.body.classList.remove('dv-trash-mode');showView('gestor');if(typeof selectFileFolder==='function')selectFileFolder('');fileViewTitle();};
  window.dvOpenUpload=function(){if(admin())return;window.dvOpenFiles();if(typeof dvActivateFileOperation==='function')dvActivateFileOperation('SUBIR');state.activeNav='upload';updateActiveNav();fileViewTitle(false,true);};
  window.dvOpenTrash=function(){document.body.classList.add('dv-trash-mode');showView('gestor');if(typeof selectFileFolder==='function')selectFileFolder('__TRASH__');state.activeNav='trash';updateActiveNav();fileViewTitle(true);};
  window.dvOpenHistory=()=>showView('historial');
  window.dvExactApplyRole=applyRole;
  window.dvExactGestorTitle=fileViewTitle;
  window.dvExactRenderHomeRail=renderHome;
  window.dvSelectRequestState=function(value){
    if($('solStateFilter'))$('solStateFilter').value=value;
    document.querySelectorAll('[data-request-state]').forEach(el=>{const selected=el.dataset.requestState===value;el.classList.toggle('active',selected);el.setAttribute('aria-pressed',String(selected));});
    if(typeof filterSolicitudesUI==='function')filterSolicitudesUI();
  };
  window.dvOpenRequests=function(value=''){showView('cola');window.dvSelectRequestState(value);};
  window.dvExactGlobalSearch=function(event){
    if(event&&event.key!=='Enter')return;
    const query=String($('dvGlobalSearchInput')?.value||'').trim();if(!query)return;
    const view=document.querySelector('.view.active')?.id;
    const targetId={'view-cola':'solSearch','view-usuarios':'adminUserSearch','view-historial':'dvHistorySearch','view-gestor':'fileSearch'}[view];
    if(!targetId)window.dvOpenFiles();
    const input=$(targetId||'fileSearch');if(input){input.value=query;input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();}
  };
  window.toggleSidebar=toggleSidebar=function(){
    if(window.innerWidth<=900){const open=$('sidebar').classList.toggle('mobile-open');$('sidebarOverlay').classList.toggle('show',open);document.querySelector('.dv-menu-toggle')?.setAttribute('aria-expanded',String(open));}
    else {const collapsed=document.body.classList.toggle('dv-sidebar-collapsed');document.querySelector('.dv-menu-toggle')?.setAttribute('aria-expanded',String(!collapsed));}
  };
  window.updateTopbarResponsive=updateTopbarResponsive=function(){if(window.innerWidth>900)closeMobileSidebar();};

  const previousFiles=loadFilesView;
  window.loadFilesView=loadFilesView=async function(){const result=await previousFiles.apply(this,arguments);if(typeof filterFiles==='function')filterFiles();fileViewTitle(document.body.classList.contains('dv-trash-mode'),state.activeNav==='upload');return result;};

  function closeFileMenu(){document.querySelector('.dv-file-popover')?.remove();fileMenuContext=null;}
  function openFileMenu(button,index){
    closeFileMenu();fileMenuContext=state.recent[index];if(!fileMenuContext)return;
    const u=fileMenuContext,rows=u.type==='folder'?u.rows:[u.row];
    const canOperate=rows.every(active);
    const menu=document.createElement('div');menu.className='dv-file-popover';menu.setAttribute('role','menu');
    menu.innerHTML='<button type="button" role="menuitem" data-home-file-action="view"><i class="fa-regular fa-folder"></i>Ver en Mis archivos</button>'+(canOperate?'<button type="button" role="menuitem" data-home-file-action="move"><i class="fa-solid fa-folder"></i>Mover</button><button type="button" role="menuitem" class="danger" data-home-file-action="delete"><i class="fa-solid fa-trash-can"></i>Eliminar</button>':'');
    const rect=button.getBoundingClientRect();menu.style.left=`${Math.max(8,Math.min(rect.right-170,window.innerWidth-178))}px`;menu.style.top=`${Math.min(rect.bottom+5,window.innerHeight-140)}px`;document.body.appendChild(menu);menu.querySelector('button')?.focus();
  }
  document.addEventListener('click',event=>{
    const decision=event.target.closest('[data-home-decision]');
    if(decision&&admin()){
      const r=state.pending[Number(decision.dataset.requestIndex)];if(!r)return;
      if(r.kind==='OP')void window.resolvePendingOperation(r.id,decision.dataset.homeDecision,decision);
      else void window.resolvePendingUpload(r.id,r.unit?.type==='folder'||/carpeta/i.test(r.type)?'CARPETA':'ARCHIVO',decision.dataset.homeDecision,decision);
      return;
    }
    const fileButton=event.target.closest('[data-dv-file-menu]');if(fileButton){openFileMenu(fileButton,Number(fileButton.dataset.dvFileMenu));return;}
    const action=event.target.closest('[data-home-file-action]');
    if(action&&fileMenuContext){
      const u=fileMenuContext,r=u.type==='folder'?u.rows[0]:u.row,kind=u.type==='folder'?'CARPETA':'ARCHIVO',id=u.type==='folder'?u.id:r.id;
      const verb=action.dataset.homeFileAction;closeFileMenu();
      if(verb==='view'){window.dvOpenFiles();if(u.type==='folder')selectFileFolder(rootName(r));}
      if(verb==='move')void window.dvRequestMove(kind,id);
      if(verb==='delete')void window.dvRequestDelete(kind,id);
      return;
    }
    if(!event.target.closest('.dv-file-popover'))closeFileMenu();
  });
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeFileMenu();$('profileMenu')?.classList.add('hidden');closeMobileSidebar();}if((event.ctrlKey||event.metaKey)&&norm(event.key)==='k'){event.preventDefault();$('dvGlobalSearchInput')?.focus();}});
  window.addEventListener('dv:dashboard-data',event=>{
    state.audit=Array.isArray(event.detail?.audit)?event.detail.audit:[];state.ops=Array.isArray(event.detail?.ops)?event.detail.ops:[];
    state.requests=null;state.refreshedAt=event.detail?.refreshedAt||new Date().toISOString();renderHome();
  });
  window.addEventListener('dv:requests-data',event=>{state.requests=Array.isArray(event.detail?.requests)?event.detail.requests:[];renderHome();});
  window.addEventListener('dv:users-data',event=>{if(admin()){state.users=event.detail?.users||[];renderHome();}});
  document.addEventListener('DOMContentLoaded',()=>{applyRole();renderHome();$('solStateFilter')?.addEventListener('change',()=>window.dvSelectRequestState($('solStateFilter').value));});
  supabaseClient.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT'){Object.assign(state,{audit:null,ops:[],requests:null,users:null,policies:null,pending:[],recent:[],metaAt:0,userId:''});closeFileMenu();}});
  window.DVUI={applyRole,renderHome,renderHistory,refreshMeta};
})();
