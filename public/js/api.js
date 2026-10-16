/** Cliente HTTP mínimo + utilidades compartidas por las vistas. */

const TOKEN_KEY = 'turnoflow.token';

export const auth = {
  get token() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set token(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch { /* almacenamiento bloqueado */ }
  },
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? `Error ${status}`);
    this.status = status;
    this.code = body?.error;
    this.issues = body?.issues;
  }
}

export async function api(path, { method = 'GET', body, query } = {}) {
  const url = new URL(path, location.origin);
  if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    if (err.issues?.length) err.message = err.issues.map((i) => i.message).join('. ');
    throw err;
  }
  return data;
}

let toastTimer;
export function toast(message, type = 'info', ms = 3500) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.toggle('error', type === 'error');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

/** Sucursal activa: ?branch=CODE en la URL, o la última elegida en este equipo. */
export function getBranchCode() {
  const fromUrl = new URLSearchParams(location.search).get('branch');
  if (fromUrl) {
    try { localStorage.setItem('turnoflow.branch', fromUrl.toUpperCase()); } catch {}
    return fromUrl.toUpperCase();
  }
  try { return localStorage.getItem('turnoflow.branch'); } catch { return null; }
}

export function setBranchCode(code) {
  try { localStorage.setItem('turnoflow.branch', code); } catch {}
  const url = new URL(location.href);
  url.searchParams.set('branch', code);
  location.href = url.toString();
}

/** Renderiza un selector de sucursal dentro de `container`. */
export async function renderBranchPicker(container) {
  const branches = await api('/api/public/branches');
  container.innerHTML = `
    <div class="card" style="max-width:520px;margin:40px auto">
      <h2 style="margin-top:0">Elegí la sucursal</h2>
      <p class="muted">Este equipo recordará la selección. También podés abrir la vista con <code>?branch=CODIGO</code>.</p>
      <div style="display:grid;gap:10px">
        ${branches.map((b) => `<button class="btn ghost" data-code="${escapeHtml(b.code)}">${escapeHtml(b.name)} <span class="muted">(${escapeHtml(b.code)})</span></button>`).join('')}
      </div>
    </div>`;
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-code]');
    if (btn) setBranchCode(btn.dataset.code);
  });
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Conecta Socket.io (cliente servido por el propio servidor en /socket.io/). */
export function connectSocket(withAuth = false) {
  // eslint-disable-next-line no-undef
  return io({ auth: withAuth && auth.token ? { token: auth.token } : {}, transports: ['websocket', 'polling'] });
}
