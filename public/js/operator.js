import { applyBrand } from './brand.js';
import { api, auth, connectSocket, escapeHtml, getBranchCode, toast } from './api.js';

const $ = (sel) => document.querySelector(sel);
const brand = await applyBrand('Operador');

const state = { user: null, branchId: null, deskId: null, current: null, socket: null, busy: false };

const views = ['login-view', 'desk-view', 'panel-view'];
const showView = (id) => views.forEach((v) => ($(`#${v}`).hidden = v !== id));

const fmtClock = (iso) =>
  iso ? new Date(iso).toLocaleTimeString(brand.locale, { timeZone: brand.timezone, hour: '2-digit', minute: '2-digit' }) : '—';

// ── Arranque ──
await boot();

async function boot() {
  if (!auth.token) return showLogin();
  try {
    const { user, desk } = await api('/api/auth/me');
    state.user = user;
    $('#who').textContent = `${user.name} · ${user.role}`;
    state.branchId = desk?.branchId ?? user.branchId ?? (await adminBranch());
    connect();
    if (desk) openPanel(desk.id);
    else showDesks();
  } catch {
    auth.token = null;
    showLogin();
  }
}

/** Un ADMIN no pertenece a una sucursal: usa la elegida en este equipo o la primera. */
async function adminBranch() {
  const code = getBranchCode();
  if (code) {
    try { return (await api(`/api/public/branches/${code}`)).id; } catch { /* sigue */ }
  }
  const [first] = await api('/api/public/branches');
  return first?.id;
}

function showLogin() {
  showView('login-view');
  $('#who').textContent = '';
  $('#email').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    const { token } = await api('/api/auth/login', {
      method: 'POST',
      body: { email: $('#email').value, password: $('#password').value },
    });
    auth.token = token;
    e.target.reset();
    await boot();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

// ── Tiempo real ──
function connect() {
  state.socket?.disconnect();
  const socket = connectSocket(true);
  state.socket = socket;
  socket.on('connect', () =>
    socket.emit('branch:join', { branchId: state.branchId }, (res) => res.ok && renderQueue(res.snapshot)),
  );
  socket.on('queue:updated', renderQueue);
  socket.on('ticket:updated', ({ ticket }) => {
    // Un supervisor pudo anular el turno activo de este box
    if (state.current?.id === ticket.id && ['CANCELLED'].includes(ticket.status)) refreshDesk();
  });
  socket.on('connect_error', (err) => err.message === 'UNAUTHORIZED' && logout());
}

function renderQueue(snapshot) {
  if (!snapshot) return;
  $('#queue').innerHTML =
    snapshot.categories
      .map(
        (c) => `<li><span><strong>${escapeHtml(c.prefix)}</strong> · ${escapeHtml(c.name)}<br>
          <span class="muted" style="font-size:.85rem">${c.openDesks} box(es) abiertos · ~${c.estimatedWaitMin} min</span></span>
          <span class="count">${c.waiting}</span></li>`,
      )
      .join('') +
    (snapshot.totals.pendingAppointments
      ? `<li><span class="muted">Citas de hoy sin presentarse</span><span class="count muted">${snapshot.totals.pendingAppointments}</span></li>`
      : '');
  // Si no hay turno en curso, el botón "Llamar" refleja si hay gente esperando
  const btn = $('#call-next');
  if (btn) btn.dataset.waiting = String(snapshot.categories.reduce((n, c) => n + c.waiting, 0));
}

// ── Boxes ──
async function showDesks() {
  showView('desk-view');
  const desks = await api('/api/operator/desks', { query: { branchId: state.branchId } });
  $('#desk-grid').innerHTML = desks
    .map(
      (d) => `
      <button class="card desk-card ${d.occupiedBy && !d.isMine ? 'taken' : ''}" data-desk="${d.id}" ${d.occupiedBy && !d.isMine ? 'disabled' : ''}>
        <h3 style="margin:0 0 6px">${escapeHtml(d.identifier)}</h3>
        <div class="muted" style="font-size:.85rem">${d.categories.length ? d.categories.map(escapeHtml).join('<br>') : 'Todas las colas'}</div>
        <p style="margin:10px 0 0">${d.occupiedBy ? `<span class="pill">${d.isMine ? 'Tuyo' : `Ocupado: ${escapeHtml(d.occupiedBy)}`}</span>` : '<span class="pill ATTENDED">Libre</span>'}</p>
      </button>`,
    )
    .join('');
}

$('#desk-grid').addEventListener('click', async (e) => {
  const card = e.target.closest('[data-desk]');
  if (!card || card.disabled) return;
  try {
    await api(`/api/operator/desks/${card.dataset.desk}/claim`, { method: 'POST' });
    openPanel(card.dataset.desk);
  } catch (err) {
    toast(err.message, 'error');
    showDesks();
  }
});

async function openPanel(deskId) {
  state.deskId = deskId;
  showView('panel-view');
  await refreshDesk();
}

async function refreshDesk() {
  const s = await api(`/api/operator/desks/${state.deskId}/state`);
  if (!s.desk.isMine) {
    toast('Ya no estás asignado a este box', 'error');
    return showDesks();
  }
  $('#desk-title').textContent = s.desk.identifier;
  $('#desk-cats').textContent = s.desk.categories.length ? `Atiende: ${s.desk.categories.map((c) => c.name).join(', ')}` : 'Atiende todas las colas';
  $('#attended').textContent = s.attendedToday;
  renderCurrent(s.current);
}

function renderCurrent(ticket) {
  state.current = ticket;
  const el = $('#current');
  if (!ticket) {
    el.innerHTML = `
      <p class="muted" style="font-size:1.1rem">Sin turno en curso</p>
      <button class="btn xl" id="call-next" data-action="call-next">📣 Llamar siguiente</button>`;
    return;
  }
  const isCalled = ticket.status === 'CALLED';
  el.innerHTML = `
    <span class="pill ${ticket.status}">${ticket.status === 'CALLED' ? 'Llamado' : 'En atención'}</span>
    <div class="code">${escapeHtml(ticket.code)}</div>
    <div><strong>${escapeHtml(ticket.category.name)}</strong> ${ticket.type === 'SCHEDULED' ? '<span class="pill">Cita</span>' : ''}</div>
    ${ticket.customerIdentifier ? `<p>Cliente: <strong>${escapeHtml(ticket.customerIdentifier)}</strong></p>` : ''}
    <p class="muted">Emitido ${fmtClock(ticket.createdAt)} · Llamado ${fmtClock(ticket.calledAt)}${ticket.recallCount ? ` · re-llamado ×${ticket.recallCount}` : ''}${ticket.startedAt ? ` · Inicio ${fmtClock(ticket.startedAt)}` : ''}</p>
    <div class="actions">
      ${isCalled ? '<button class="btn success lg" data-action="start">▶ Iniciar atención</button>' : ''}
      ${isCalled ? '<button class="btn secondary" data-action="recall">🔁 Re-llamar</button>' : ''}
      ${isCalled ? '<button class="btn danger" data-action="absent">✖ Ausente</button>' : ''}
      ${isCalled ? '<button class="btn ghost" data-action="requeue">↩ Devolver a la cola</button>' : ''}
      ${!isCalled ? '<button class="btn success lg" data-action="finish">✔ Finalizar atención</button>' : ''}
    </div>`;
}

// ── Acciones ──
const actions = {
  async 'call-next'() {
    const ticket = await api(`/api/operator/desks/${state.deskId}/call-next`, { method: 'POST' });
    if (!ticket) return toast('No hay clientes en espera para tus colas');
    renderCurrent(ticket);
  },
  async start() {
    renderCurrent(await api(`/api/operator/tickets/${state.current.id}/start`, { method: 'POST' }));
  },
  async finish() {
    await api(`/api/operator/tickets/${state.current.id}/finish`, { method: 'POST' });
    await refreshDesk();
  },
  async absent() {
    await api(`/api/operator/tickets/${state.current.id}/absent`, { method: 'POST' });
    await refreshDesk();
  },
  async recall() {
    renderCurrent(await api(`/api/operator/tickets/${state.current.id}/recall`, { method: 'POST' }));
    toast('Turno anunciado nuevamente');
  },
  async requeue() {
    await api(`/api/operator/tickets/${state.current.id}/requeue`, { method: 'POST' });
    await refreshDesk();
  },
  async release() {
    await api(`/api/operator/desks/${state.deskId}/release`, { method: 'POST', body: {} });
    state.deskId = null;
    showDesks();
  },
  async logout() {
    logout();
  },
};

async function run(name) {
  if (state.busy || !actions[name]) return;
  state.busy = true;
  try {
    await actions[name]();
  } catch (err) {
    toast(err.message, 'error');
    if (err.status === 409 && state.deskId) await refreshDesk().catch(() => {});
    if (err.status === 401) logout();
  } finally {
    state.busy = false;
  }
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (btn) run(btn.dataset.action);
});

document.addEventListener('keydown', (e) => {
  if ($('#panel-view').hidden || e.target.matches('input, textarea, select')) return;
  const map = { ' ': 'call-next', i: 'start', f: 'finish', r: 'recall', a: 'absent' };
  const action = map[e.key.toLowerCase()];
  if (!action) return;
  const allowed = state.current
    ? (state.current.status === 'CALLED' ? ['start', 'recall', 'absent'] : ['finish'])
    : ['call-next'];
  if (!allowed.includes(action)) return;
  e.preventDefault();
  run(action);
});

function logout() {
  auth.token = null;
  state.socket?.disconnect();
  Object.assign(state, { user: null, deskId: null, current: null });
  showLogin();
}
