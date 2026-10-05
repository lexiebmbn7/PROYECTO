/* Pagination shared by administrator and subordinate tables. */
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
    label.textContent = `Página ${state.page} de ${total}`;
    nav.append(label);
    const previous = document.createElement('button');
    previous.type = 'button'; previous.textContent = '‹'; previous.title = 'Página anterior';
    previous.disabled = state.page === 1;
    previous.onclick = () => { state.page -= 1; render(); };
    nav.append(previous);
    for (let number = 1; number <= total; number += 1) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = String(number);
      button.className = number === state.page ? 'is-active' : '';
      button.setAttribute('aria-current', number === state.page ? 'page' : 'false');
      button.onclick = () => { state.page = number; render(); };
      nav.append(button);
    }
    const next = document.createElement('button');
    next.type = 'button'; next.textContent = '›'; next.title = 'Página siguiente';
    next.disabled = state.page === total;
    next.onclick = () => { state.page += 1; render(); };
    nav.append(next);
    return rows.slice((state.page - 1) * 10, state.page * 10);
  };
})();
