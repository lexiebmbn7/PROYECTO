/* Pagination works on filtered data, never on the administrator's groups. */
(() => {
  const pages = new Map();
  window.dvSubPage = (rows, key, filter, tbody, render) => {
    const identity = String(typeof currentUser !== 'undefined' ? currentUser?.id || '' : '');
    const signature = identity + '|' + filter;
    let state = pages.get(key);
    if (!state || state.signature !== signature) state = {signature, page: 1};
    const total = Math.max(1, Math.ceil(rows.length / 10));
    state.page = Math.min(state.page, total);
    pages.set(key, state);
    let nav = document.getElementById('dv-pages-' + key);
    if (!nav) {
      nav = document.createElement('nav');
      nav.id = 'dv-pages-' + key;
      nav.className = 'dv-sub-pagination';
      nav.setAttribute('aria-label', 'Páginas de ' + (key === 'history' ? 'historial' : 'solicitudes'));
      tbody.closest('table').parentElement.after(nav);
    }
    nav.replaceChildren();
    const label = document.createElement('span');
    label.setAttribute('aria-live', 'polite');
    label.textContent = `${rows.length ? (state.page - 1) * 10 + 1 : 0}–${Math.min(state.page * 10, rows.length)} de ${rows.length} · Página ${state.page} de ${total}`;
    nav.append(label);
    for (const [text, delta, disabled] of [['Anterior', -1, state.page === 1], ['Siguiente', 1, state.page === total]]) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = text; button.disabled = disabled;
      button.onclick = () => { state.page += delta; render(); };
      nav.append(button);
    }
    return rows.slice((state.page - 1) * 10, state.page * 10);
  };
})();
