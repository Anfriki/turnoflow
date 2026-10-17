import { applyBrand } from './brand.js';
import { api, auth, escapeHtml, toast } from './api.js';
import { DAYS, deskLabel, minutes, MONTHS, PREFERENTIAL, RESOLUTION, STATUS } from './labels.js';

const $ = (sel) => document.querySelector(sel);
const brand = await applyBrand('Consultas');
const state = { user: null, options: null, page: 1, tab: 'list', reasons: [], editingReason: null };

const fmtDate = (ymd) => (ymd ? ymd.split('-').reverse().join('/') : '');
const fmtTime = (iso) =>
  iso ? new Date(iso).toLocaleTimeString(brand.locale, { timeZone: brand.timezone, hour: '2-digit', minute: '2-digit' }) : '—';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: brand.timezone }).format(new Date());
const opt = (v, l, sel = false) => `<option value="${escapeHtml(v)}" ${sel ? 'selected' : ''}>${escapeHtml(l)}</option>`;

// ── Sesión ──
async function boot() {
  if (!auth.token) return showLogin();
  try {
    const { user } = await api('/api/auth/me');
    if (user.role === 'OPERATOR') {
      auth.token = null;
      return showLogin('Esta sección es sólo para supervisores y administradores.');
    }
    state.user = user;
    $('#who').textContent = `${user.name} · ${user.role === 'ADMIN' ? 'Administrador' : 'Supervisor'}`;
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    await loadOptions();
    setToday();
    await search();
  } catch {
    auth.token = null;
    showLogin();
  }
}

function showLogin(msg = '') {
  $('#login-view').hidden = false;
  $('#app-view').hidden = true;
  $('#login-error').textContent = msg;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { token } = await api('/api/auth/login', { method: 'POST', body: { email: $('#email').value, password: $('#password').value } });
    auth.token = token;
    e.target.reset();
    await boot();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});
$('#logout').addEventListener('click', () => {
  auth.token = null;
  showLogin();
});

// ── Filtros ──
async function loadOptions() {
  const branchId = $('#f-branch').value || undefined;
  const o = await api('/api/reports/options', { query: { branchId } });
  state.options = o;
  if (state.user.role === 'ADMIN') {
    $('#f-branch-wrap').hidden = false;
    if (!$('#f-branch').options.length) $('#f-branch').innerHTML = opt('', 'Todas') + o.branches.map((b) => opt(b.id, b.name)).join('');
  }
  const y = new Date().getFullYear();
  $('#f-year').innerHTML = opt('', 'Todos') + [y, y - 1, y - 2].map((v) => opt(v, v)).join('');
  $('#f-month').innerHTML = opt('', 'Todos') + MONTHS.slice(1).map((m, i) => opt(i + 1, m)).join('');
  $('#f-day').innerHTML = opt('', 'Todos') + Array.from({ length: 31 }, (_, i) => opt(i + 1, i + 1)).join('');
  $('#f-desk').innerHTML = opt('', 'Todas') + [...new Set(o.desks.map((d) => d.number))].map((n) => opt(n, deskLabel(brand, n))).join('');
  $('#f-operator').innerHTML = opt('', 'Todos') + o.operators.map((u) => opt(u.id, u.name)).join('');
  const byDept = new Map();
  for (const r of o.reasons) byDept.set(r.department, [...(byDept.get(r.department) ?? []), r]);
  $('#f-dependency-wrap').hidden = !o.dependencies.length;
  $('#f-dependency').innerHTML = opt('', 'Todas') + o.dependencies.map((d) => opt(d.id, d.name.split(' (')[0])).join('');
  $('#f-reason').innerHTML =
    opt('', 'Todos') +
    [...byDept]
      .map(([d, list]) => `<optgroup label="${escapeHtml(d)}">${list.map((r) => opt(r.id, `${r.code} · ${r.name}${r.isActive ? '' : ' (inactivo)'}`)).join('')}</optgroup>`)
      .join('');
  $('#f-department').innerHTML = opt('', 'Todas') + o.departments.map((d) => opt(d, d)).join('');
  $('#f-status').innerHTML = opt('', 'Todos') + Object.entries(STATUS).map(([k, l]) => opt(k, l)).join('');
  $('#f-resolution').innerHTML = opt('', 'Todos') + Object.entries(RESOLUTION).map(([k, r]) => opt(k, r.label)).join('');
}

$('#f-branch').addEventListener('change', loadOptions);

function filterQuery() {
  const data = new FormData($('#filters'));
  const q = {};
  for (const [k, v] of data) if (String(v).trim()) q[k] = String(v).trim();
  if (q.idNumber && !q.idOrigin) q.idOrigin = 'V';
  if (!q.idNumber) delete q.idOrigin;
  return q;
}

function setToday() {
  $('#f-from').value = today();
  $('#f-to').value = today();
}

$('#f-today').addEventListener('click', () => {
  $('#filters').reset();
  setToday();
  search();
});
$('#filters').addEventListener('reset', () => setTimeout(() => (state.page = 1), 0));
$('#filters').addEventListener('submit', (e) => {
  e.preventDefault();
  state.page = 1;
  search();
});

async function search() {
  $('#filters-error').textContent = '';
  try {
    if (state.tab === 'list') await loadList();
    else if (state.tab === 'summary') await loadSummary();
  } catch (err) {
    $('#filters-error').textContent = err.message;
  }
}

// ── Listado ──
let lastItems = [];
async function loadList() {
  const r = await api('/api/reports/attentions', { query: { ...filterQuery(), page: state.page, pageSize: 50 } });
  lastItems = r.items;
  $('#list-count').textContent = `${r.total} atención(es) encontradas`;
  $('#list-table tbody').innerHTML = r.items.length
    ? r.items
        .map(
          (t, i) => `<tr data-i="${i}" tabindex="0">
            <td>${fmtDate(t.serviceDate)}</td>
            <td>${fmtTime(t.checkedInAt ?? t.createdAt)}</td>
            <td><strong>${escapeHtml(t.code)}</strong>${t.type === 'SCHEDULED' ? ' <span class="pill">Cita</span>' : ''}</td>
            <td class="nowrap">${escapeHtml(t.citizen.display)}</td>
            <td>${escapeHtml(t.citizen.name)}${t.preferentialType ? ' <span class="pill pref" title="Preferencial">P</span>' : ''}</td>
            <td>${escapeHtml(t.reason.name)}</td>
            <td>${t.deskNumber ?? '—'}</td>
            <td>${escapeHtml(t.operatorName ?? '—')}</td>
            <td><span class="pill ${t.status}">${STATUS[t.status]}</span></td>
            <td>${t.resolutionStatus ? `<span class="res res-${t.resolutionStatus}">${RESOLUTION[t.resolutionStatus].label}</span>` : '—'}</td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="10" class="muted center">Sin resultados para los filtros elegidos.</td></tr>';
  $('#pager').innerHTML =
    r.pages > 1
      ? `<button class="btn ghost" data-page="${r.page - 1}" ${r.page <= 1 ? 'disabled' : ''}>‹ Anterior</button>
         <span class="muted">Página ${r.page} de ${r.pages}</span>
         <button class="btn ghost" data-page="${r.page + 1}" ${r.page >= r.pages ? 'disabled' : ''}>Siguiente ›</button>`
      : '';
}

$('#pager').addEventListener('click', (e) => {
  const b = e.target.closest('[data-page]');
  if (!b || b.disabled) return;
  state.page = Number(b.dataset.page);
  loadList();
});

const openDetail = (t) => {
  const row = (k, v) => (v ? `<tr><th>${k}</th><td>${v}</td></tr>` : '');
  $('#detail').innerHTML = `
    <h2 style="margin-top:0">${escapeHtml(t.code)} · ${escapeHtml(t.citizen.display)}</h2>
    <table class="kv">
      ${row('Ciudadano', escapeHtml(t.citizen.name))}
      ${row('Preferencial', t.preferentialType ? escapeHtml(PREFERENTIAL[t.preferentialType]) : '')}
      ${row('Motivo', `${escapeHtml(t.reason.code)} · ${escapeHtml(t.reason.name)}`)}
      ${row('Dirección', escapeHtml(t.reason.department))}
      ${row('Tipo', t.type === 'SCHEDULED' ? `Cita (${fmtTime(t.scheduledAt)})` : 'Presencial')}
      ${row('Fecha', `${fmtDate(t.serviceDate)} · ${DAYS[t.dayOfWeek]} · ${t.hour}:00 h`)}
      ${row('Taquilla', t.deskNumber ? escapeHtml(deskLabel(brand, t.deskNumber)) : '—')}
      ${row('Funcionario', escapeHtml(t.operatorName ?? '—'))}
      ${row('Estatus', STATUS[t.status])}
      ${row('Llegada / llamado', `${fmtTime(t.checkedInAt ?? t.createdAt)} / ${fmtTime(t.calledAt)}`)}
      ${row('Inicio / fin', `${fmtTime(t.startedAt)} / ${fmtTime(t.finishedAt)}`)}
      ${row('Espera / atención', `${minutes(t.waitSeconds)} / ${minutes(t.serviceSeconds)}`)}
      ${row('Resultado', t.resolutionStatus ? `<span class="res res-${t.resolutionStatus}">${RESOLUTION[t.resolutionStatus].label}</span>` : '')}
      ${row('Remitido a', escapeHtml(t.destinationDepartment ?? ''))}
    </table>
    ${t.resolutionNotes ? `<h3>Observaciones</h3><p class="notes">${escapeHtml(t.resolutionNotes)}</p>` : ''}`;
  $('#detail-dialog').showModal();
};
$('#list-table tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (tr) openDetail(lastItems[Number(tr.dataset.i)]);
});
$('#list-table tbody').addEventListener('keydown', (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (tr && e.key === 'Enter') openDetail(lastItems[Number(tr.dataset.i)]);
});
$('#detail-close').addEventListener('click', () => $('#detail-dialog').close());

// ── CSV ──
$('#f-csv').addEventListener('click', async () => {
  try {
    const url = new URL('/api/reports/attentions', location.origin);
    for (const [k, v] of Object.entries({ ...filterQuery(), format: 'csv' })) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { authorization: `Bearer ${auth.token}` } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? `Error ${res.status}`);
    const blob = await res.blob();
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `atenciones_${today()}.csv` });
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ── Resumen ──
function statTable(title, rows, label) {
  if (!rows.length) return '';
  return `<div class="card"><h3>${escapeHtml(title)}</h3>
    <table class="data-table compact">
      <thead><tr><th></th><th class="num">Total</th><th class="num">Atendidos</th><th class="num">Ausentes</th><th class="num">Espera media</th><th class="num">Atención media</th></tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr><td class="label">${escapeHtml(label(r))}</td><td class="num">${r.total}</td><td class="num">${r.attended}</td><td class="num">${r.absent}</td>
          <td class="num">${r.avgWaitMin != null ? `${r.avgWaitMin} min` : '—'}</td><td class="num">${r.avgServiceMin != null ? `${r.avgServiceMin} min` : '—'}</td></tr>`,
        )
        .join('')}</tbody></table></div>`;
}

async function loadSummary() {
  const s = await api('/api/reports/summary', { query: filterQuery() });
  const t = s.totals;
  const resolvedPct = t.attended ? Math.round(((s.byResolution.find((r) => r.key === 'RESUELTO')?.total ?? 0) / t.attended) * 100) : 0;
  $('#summary').innerHTML = `
    <div class="card"><h3>Totales del período</h3>
      <table class="kv">
        <tr><th>Atenciones registradas</th><td>${t.total}</td></tr>
        <tr><th>Atendidos</th><td>${t.attended}</td></tr>
        <tr><th>Ausentes</th><td>${t.absent}</td></tr>
        <tr><th>Cancelados</th><td>${t.cancelled}</td></tr>
        <tr><th>En curso / en espera</th><td>${t.pending}</td></tr>
        <tr><th>Espera media</th><td>${t.avgWaitMin ?? '—'} min</td></tr>
        <tr><th>Atención media</th><td>${t.avgServiceMin ?? '—'} min</td></tr>
        <tr><th>Peticiones resueltas</th><td>${resolvedPct}% de los atendidos</td></tr>
      </table></div>
    <div class="card"><h3>Resultado de las peticiones</h3>
      <table class="data-table compact"><thead><tr><th></th><th class="num">Atenciones</th></tr></thead>
      <tbody>${s.byResolution
        .map((r) => `<tr><td><span class="res res-${r.key}">${RESOLUTION[r.key]?.label ?? 'Sin registro'}</span></td><td class="num">${r.total}</td></tr>`)
        .join('') || '<tr><td colspan="2" class="muted">Sin atenciones finalizadas</td></tr>'}</tbody></table></div>
    ${s.byDependency.some((d) => d.code) ? statTable('Por dependencia', s.byDependency, (r) => r.name) : ''}
    ${statTable('Por Dirección', s.byDepartment.map((d) => ({ ...d, avgWaitMin: null, avgServiceMin: null })), (r) => r.key)}
    ${statTable('Por motivo', s.byReason, (r) => `${r.code ?? ''} · ${r.name ?? r.key}`)}
    ${statTable('Por taquilla', s.byDesk, (r) => (r.key === 'null' || r.key === '—' ? 'Sin asignar' : deskLabel(brand, r.key)))}
    ${statTable('Por funcionario', s.byOperator, (r) => (r.key === 'null' || r.key === '—' ? 'Sin asignar' : r.key))}
    ${statTable('Por hora de llegada', s.byHour, (r) => `${String(r.key).padStart(2, '0')}:00 – ${String(r.key).padStart(2, '0')}:59`)}
    ${statTable('Por día de la semana', s.byDayOfWeek, (r) => DAYS[r.key])}
    ${statTable('Por día', s.byDay, (r) => fmtDate(r.key))}`;
}

// ── Motivos (CRUD) ──
async function loadReasons() {
  const branchId = $('#f-branch').value || state.user.branchId || state.options.branches[0]?.id;
  state.reasonsBranch = branchId;
  state.reasons = await api('/api/admin/reasons', { query: { branchId } });
  $('#r-depts').innerHTML = [...new Set(state.reasons.map((r) => r.department))].map((d) => `<option value="${escapeHtml(d)}"></option>`).join('');
  $('#reasons-table tbody').innerHTML = state.reasons
    .map(
      (r) => `<tr class="${r.isActive ? '' : 'inactive'}">
        <td class="nowrap"><strong>${escapeHtml(r.code)}</strong></td>
        <td>${escapeHtml(r.name)}${r.description ? `<br><small class="muted">${escapeHtml(r.description)}</small>` : ''}</td>
        <td>${escapeHtml(r.department)}</td>
        <td>${escapeHtml(r.prefixLetter)}</td>
        <td class="num">${r.priorityLevel}</td>
        <td class="num">${r.estimatedDurationMin} min</td>
        <td>${r.allowAppointments ? 'Sí' : 'No'}</td>
        <td class="num">${r.ticketCount}</td>
        <td>${r.isActive ? '<span class="pill ATTENDED">Activo</span>' : '<span class="pill CANCELLED">Inactivo</span>'}</td>
        <td class="nowrap">
          <button class="btn ghost sm" data-edit="${r.id}">Editar</button>
          <button class="btn ghost sm" data-toggle="${r.id}">${r.isActive ? 'Desactivar' : 'Activar'}</button>
          ${r.ticketCount === 0 ? `<button class="btn danger sm" data-delete="${r.id}">Eliminar</button>` : ''}
        </td>
      </tr>`,
    )
    .join('');
}

const reasonDialog = $('#reason-dialog');
function openReason(r) {
  state.editingReason = r ?? null;
  const f = $('#reason-form');
  f.reset();
  $('#reason-error').textContent = '';
  $('#reason-title').textContent = r ? `Editar ${r.code}` : 'Nuevo motivo';
  if (r) {
    for (const k of ['code', 'prefixLetter', 'name', 'department', 'description', 'priorityLevel', 'estimatedDurationMin', 'sortOrder']) f.elements[k].value = r[k] ?? '';
    f.elements.allowAppointments.checked = r.allowAppointments;
    f.elements.isActive.checked = r.isActive;
  }
  reasonDialog.showModal();
}
$('#reason-new').addEventListener('click', () => openReason());
$('#reason-cancel').addEventListener('click', () => reasonDialog.close());

$('#reason-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const body = {
    code: f.code.value.trim(),
    prefixLetter: f.prefixLetter.value.trim(),
    name: f.name.value.trim(),
    department: f.department.value.trim(),
    description: f.description.value.trim() || null,
    priorityLevel: Number(f.priorityLevel.value || 0),
    estimatedDurationMin: Number(f.estimatedDurationMin.value || 10),
    sortOrder: Number(f.sortOrder.value || 0),
    allowAppointments: f.allowAppointments.checked,
    isActive: f.isActive.checked,
  };
  try {
    if (state.editingReason) await api(`/api/admin/reasons/${state.editingReason.id}`, { method: 'PATCH', body });
    else await api('/api/admin/reasons', { method: 'POST', body: { ...body, branchId: state.reasonsBranch } });
    reasonDialog.close();
    toast('Motivo guardado');
    await loadReasons();
    await loadOptions();
  } catch (err) {
    $('#reason-error').textContent = err.message;
  }
});

$('#reasons-table').addEventListener('click', async (e) => {
  const find = (id) => state.reasons.find((r) => r.id === id);
  const b = e.target.closest('button');
  if (!b) return;
  try {
    if (b.dataset.edit) return openReason(find(b.dataset.edit));
    if (b.dataset.toggle) {
      const r = find(b.dataset.toggle);
      await api(`/api/admin/reasons/${r.id}`, { method: 'PATCH', body: { isActive: !r.isActive } });
      toast(r.isActive ? 'Motivo desactivado' : 'Motivo activado');
    }
    if (b.dataset.delete) {
      const r = find(b.dataset.delete);
      if (!confirm(`¿Eliminar definitivamente el motivo ${r.code} · ${r.name}?`)) return;
      await api(`/api/admin/reasons/${r.id}`, { method: 'DELETE' });
      toast('Motivo eliminado');
    }
    await loadReasons();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ── Pestañas ──
$('#tabs').addEventListener('click', async (e) => {
  const tab = e.target.dataset.tab;
  if (!tab) return;
  state.tab = tab;
  for (const b of $('#tabs').querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== tab;
  $('#filters').hidden = tab === 'reasons';
  try {
    if (tab === 'reasons') await loadReasons();
    else await search();
  } catch (err) {
    toast(err.message, 'error');
  }
});

await boot();
