import { applyBrand } from './brand.js';
import { api, auth, connectSocket, escapeHtml, getBranchCode, toast } from './api.js';
import { deskLabel, PREFERENTIAL, RESOLUTION } from './labels.js';

const $ = (sel) => document.querySelector(sel);
const brand = await applyBrand('Taquilla');

const state = { user: null, branchId: null, deskId: null, desk: null, current: null, socket: null, busy: false };

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
    $('#who').textContent = user.name;
    state.branchId = desk?.branchId ?? user.branchId ?? (await adminBranch());
    connect();
    if (desk) openPanel(desk.id);
    else showDesks();
  } catch {
    auth.token = null;
    showLogin();
  }
}

/** Un ADMIN no pertenece a una sede: usa la elegida en este equipo o la primera. */
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
  $('#desk-header').textContent = 'Panel de taquilla';
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
    // Un supervisor pudo anular el turno activo de esta taquilla
    if (state.current?.id === ticket.id && ticket.status === 'CANCELLED') refreshDesk();
  });
  socket.on('connect_error', (err) => err.message === 'UNAUTHORIZED' && logout());
}

function renderQueue(snapshot) {
  if (!snapshot) return;
  const mine = state.desk?.reasons?.length ? new Set(state.desk.reasons.map((r) => r.id)) : null;
  const rows = snapshot.reasons.filter((r) => r.waiting > 0);
  const t = snapshot.totals;
  $('#queue-totals').textContent =
    `${t.waiting} en espera` +
    (t.waitingPreferential ? ` · ${t.waitingPreferential} preferenciales` : '') +
    (t.pendingAppointments ? ` · ${t.pendingAppointments} citas sin presentarse` : '');
  $('#queue').innerHTML = rows.length
    ? rows
        .map(
          (r) => `<li class="${mine && !mine.has(r.id) ? 'not-mine' : ''}">
            <span><strong>${escapeHtml(r.name)}</strong><br>
              <span class="muted" style="font-size:.85rem">${escapeHtml(r.department)} · ~${r.estimatedWaitMin} min</span></span>
            <span class="count">${r.waiting}</span></li>`,
        )
        .join('')
    : '<li class="muted">No hay ciudadanos en espera.</li>';
}

// ── Taquillas ──
async function showDesks() {
  showView('desk-view');
  $('#desk-header').textContent = 'Panel de taquilla';
  const desks = await api('/api/operator/desks', { query: { branchId: state.branchId } });
  $('#desk-grid').innerHTML = desks
    .map((d) => {
      const taken = d.occupiedBy && !d.isMine;
      return `
      <button class="card desk-card ${taken ? 'taken' : ''}" data-desk="${d.id}" ${taken ? 'disabled' : ''}>
        <h3 style="margin:0 0 6px">${escapeHtml(deskLabel(brand, d.number))}</h3>
        <div class="muted" style="font-size:.85rem">${d.reasons.length ? d.reasons.map(escapeHtml).join('<br>') : 'Atiende todos los motivos'}</div>
        <p style="margin:10px 0 0">${d.occupiedBy ? `<span class="pill">${d.isMine ? 'Suya' : `Ocupada: ${escapeHtml(d.occupiedBy)}`}</span>` : '<span class="pill ATTENDED">Libre</span>'}</p>
      </button>`;
    })
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
    toast('Ya no está asignado a esta taquilla', 'error');
    return showDesks();
  }
  state.desk = s.desk;
  const label = deskLabel(brand, s.desk.number);
  $('#desk-title').textContent = `${label} — Funcionario: ${state.user.name}`;
  $('#desk-header').textContent = `${label} · ${state.user.name}`;
  $('#desk-reasons').textContent = s.desk.reasons.length
    ? `Atiende: ${s.desk.reasons.map((r) => r.name).join(', ')}`
    : 'Atiende todos los motivos';
  $('#attended').textContent = s.attendedToday;
  renderCurrent(s.current);
}

function renderCurrent(ticket) {
  state.current = ticket;
  const el = $('#current');
  if (!ticket) {
    el.innerHTML = `
      <p class="muted" style="font-size:1.1rem">Sin ciudadano en atención</p>
      <button class="btn xl" data-action="call-next">📣 Llamar siguiente</button>`;
    return;
  }
  const isCalled = ticket.status === 'CALLED';
  el.innerHTML = `
    <div>
      <span class="pill ${ticket.status}">${isCalled ? 'Llamado' : 'En atención'}</span>
      ${ticket.type === 'SCHEDULED' ? '<span class="pill">Cita</span>' : ''}
      ${ticket.preferentialType ? `<span class="pill pref">${escapeHtml(PREFERENTIAL[ticket.preferentialType])}</span>` : ''}
    </div>
    <div class="cedula-big">${escapeHtml(ticket.citizen.display)}</div>
    <div class="citizen-name">${escapeHtml(ticket.citizen.name)}</div>
    <p style="margin:12px 0 4px"><span class="muted">Turno</span> <strong>${escapeHtml(ticket.code)}</strong> ·
      <strong>${escapeHtml(ticket.reason.name)}</strong> <span class="muted">(${escapeHtml(ticket.reason.code)})</span></p>
    <p class="muted" style="margin:0">${escapeHtml(ticket.reason.department)}</p>
    <p class="muted">Llegada ${fmtClock(ticket.checkedInAt ?? ticket.createdAt)} · Llamado ${fmtClock(ticket.calledAt)}${ticket.recallCount ? ` · re-llamado ×${ticket.recallCount}` : ''}${ticket.startedAt ? ` · Inicio ${fmtClock(ticket.startedAt)}` : ''}</p>
    <div class="actions">
      ${isCalled ? '<button class="btn success lg" data-action="start">▶ Iniciar atención</button>' : ''}
      ${isCalled ? '<button class="btn secondary" data-action="recall">🔁 Re-llamar</button>' : ''}
      ${isCalled ? '<button class="btn danger" data-action="absent">✖ Ausente</button>' : ''}
      ${isCalled ? '<button class="btn ghost" data-action="requeue">↩ Devolver a la cola</button>' : ''}
      ${!isCalled ? '<button class="btn success lg" data-action="finish">✔ Finalizar atención</button>' : ''}
    </div>`;
}

// ── Modal de cierre (obligatorio) ──
const dialog = $('#finish-dialog');
$('#resolution-options').innerHTML = Object.entries(RESOLUTION)
  .map(
    ([key, r]) => `<label class="resolution-option res-${key}">
      <input type="radio" name="resolution" value="${key}" required />
      <span><strong>${escapeHtml(r.label)}</strong><small>${escapeHtml(r.hint)}</small></span>
    </label>`,
  )
  .join('');

const selectedResolution = () => dialog.querySelector('input[name=resolution]:checked')?.value;
const updateNotesCount = () => {
  const n = $('#notes').value.trim().length;
  const min = brand.attention.minResolutionNotes;
  $('#notes-count').textContent = n < min ? `(mínimo ${min} caracteres, faltan ${min - n})` : `(${n}/2000)`;
};
$('#notes').addEventListener('input', updateNotesCount);
$('#finish-form').addEventListener('input', () => ($('#finish-error').textContent = ''));
$('#resolution-options').addEventListener('change', () => {
  const remitido = selectedResolution() === 'REMITIDO';
  $('#destination-wrap').hidden = !remitido;
  if (remitido) $('#destination').focus();
});
$('#finish-cancel').addEventListener('click', () => dialog.close());

let departmentsLoaded = false;
async function openFinishDialog() {
  if (!departmentsLoaded) {
    try {
      const deps = await api('/api/operator/departments');
      $('#departments').innerHTML = deps.map((d) => `<option value="${escapeHtml(d)}"></option>`).join('');
      departmentsLoaded = true;
    } catch { /* el campo sigue siendo libre */ }
  }
  $('#finish-form').reset();
  $('#destination-wrap').hidden = true;
  $('#finish-error').textContent = '';
  $('#finish-code').textContent = state.current.code;
  $('#finish-citizen').textContent = `${state.current.citizen.display} · ${state.current.citizen.name} · ${state.current.reason.name}`;
  updateNotesCount();
  dialog.showModal();
}

$('#finish-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const resolutionStatus = selectedResolution();
  const resolutionNotes = $('#notes').value.trim();
  const destinationDepartment = $('#destination').value.trim();
  const min = brand.attention.minResolutionNotes;
  const error = !resolutionStatus
    ? 'Seleccione el estatus de la petición'
    : resolutionNotes.length < min
      ? `Escriba las observaciones (mínimo ${min} caracteres)`
      : resolutionStatus === 'REMITIDO' && !destinationDepartment
        ? 'Indique a qué unidad o dependencia se remite'
        : null;
  $('#finish-error').textContent = error ?? '';
  if (error) return;

  $('#finish-submit').disabled = true;
  try {
    await api(`/api/operator/tickets/${state.current.id}/finish`, {
      method: 'POST',
      body: { resolutionStatus, resolutionNotes, destinationDepartment: resolutionStatus === 'REMITIDO' ? destinationDepartment : null },
    });
    dialog.close();
    toast(`Atención ${state.current.code} cerrada: ${RESOLUTION[resolutionStatus].label}`);
    await refreshDesk();
  } catch (err) {
    $('#finish-error').textContent = err.message;
  } finally {
    $('#finish-submit').disabled = false;
  }
});

// ── Acciones ──
const actions = {
  async 'call-next'() {
    const ticket = await api(`/api/operator/desks/${state.deskId}/call-next`, { method: 'POST' });
    if (!ticket) return toast('No hay ciudadanos en espera para los motivos de esta taquilla');
    renderCurrent(ticket);
  },
  async start() {
    renderCurrent(await api(`/api/operator/tickets/${state.current.id}/start`, { method: 'POST' }));
  },
  async finish() {
    await openFinishDialog();
  },
  async absent() {
    if (!confirm(`¿Marcar ausente la cédula ${state.current.citizen.display}?`)) return;
    await api(`/api/operator/tickets/${state.current.id}/absent`, { method: 'POST' });
    await refreshDesk();
  },
  async recall() {
    renderCurrent(await api(`/api/operator/tickets/${state.current.id}/recall`, { method: 'POST' }));
    toast('Llamado anunciado nuevamente');
  },
  async requeue() {
    await api(`/api/operator/tickets/${state.current.id}/requeue`, { method: 'POST' });
    await refreshDesk();
  },
  async release() {
    await api(`/api/operator/desks/${state.deskId}/release`, { method: 'POST', body: {} });
    state.deskId = null;
    state.desk = null;
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
  if ($('#panel-view').hidden || dialog.open || e.target.matches('input, textarea, select')) return;
  const map = { ' ': 'call-next', i: 'start', f: 'finish', r: 'recall', a: 'absent' };
  const action = map[e.key.toLowerCase()];
  if (!action) return;
  const allowed = state.current
    ? state.current.status === 'CALLED' ? ['start', 'recall', 'absent'] : ['finish']
    : ['call-next'];
  if (!allowed.includes(action)) return;
  e.preventDefault();
  run(action);
});

function logout() {
  auth.token = null;
  state.socket?.disconnect();
  Object.assign(state, { user: null, deskId: null, desk: null, current: null });
  showLogin();
}
