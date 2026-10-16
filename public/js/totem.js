import { applyBrand } from './brand.js';
import { api, connectSocket, escapeHtml, getBranchCode, renderBranchPicker, toast } from './api.js';
import { mountCitizenForm } from './citizen-form.js';
import { deskLabel, PREFERENTIAL, STATUS } from './labels.js';

const $ = (sel) => document.querySelector(sel);
const brand = await applyBrand('Registro de turnos');
const params = new URLSearchParams(location.search);
const isWeb = params.get('mode') === 'web';

const fmtTime = (iso) =>
  new Date(iso).toLocaleTimeString(brand.locale, { timeZone: brand.timezone, hour: '2-digit', minute: '2-digit' });
const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString(brand.locale, { timeZone: brand.timezone, weekday: 'long', day: 'numeric', month: 'long' });

/** <select> de motivos agrupado por Dirección (optgroup), alimentado desde la base de datos. */
function reasonOptions(reasons) {
  const byDept = new Map();
  for (const r of reasons) byDept.set(r.department, [...(byDept.get(r.department) ?? []), r]);
  return (
    '<option value="">Seleccione un motivo…</option>' +
    [...byDept]
      .map(
        ([dept, list]) =>
          `<optgroup label="${escapeHtml(dept)}">${list
            .map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`)
            .join('')}</optgroup>`,
      )
      .join('')
  );
}

/** Selector "No aplica / Tercera edad / Embarazada / Discapacidad". Devuelve un getter del valor. */
function mountPreferential(wrap, group) {
  if (!brand.totem.preferentialEnabled) {
    wrap.hidden = true;
    return () => null;
  }
  const opts = [['', 'No aplica'], ...Object.entries(PREFERENTIAL)];
  group.innerHTML = opts
    .map(([v, l], i) => `<button type="button" role="radio" data-pref="${v}" aria-checked="${i === 0}">${escapeHtml(l)}</button>`)
    .join('');
  let value = '';
  group.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pref]');
    if (!b) return;
    value = b.dataset.pref;
    for (const x of group.querySelectorAll('[data-pref]')) x.setAttribute('aria-checked', String(x === b));
  });
  const get = () => value || null;
  get.reset = () => group.querySelector('[data-pref=""]').click();
  return get;
}

// ── Modo seguimiento: /totem.html?track=<ticketId> (celular del ciudadano) ──
if (params.get('track')) {
  await renderTracking(params.get('track'));
} else {
  const code = getBranchCode();
  if (!code) await renderBranchPicker($('#app'));
  else await init(code);
}

async function init(code) {
  let branch;
  try {
    branch = await api(`/api/public/branches/${encodeURIComponent(code)}`);
  } catch {
    try { localStorage.removeItem('turnoflow.branch'); } catch {}
    return renderBranchPicker($('#app'));
  }
  $('#branch-name').textContent = branch.name;

  const tabs = $('#tabs');
  tabs.hidden = false;
  const forms = {};
  const show = (name) => {
    for (const b of tabs.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== name;
    $('#result').hidden = true;
    forms[name]?.focus();
  };
  tabs.addEventListener('click', (e) => e.target.dataset.tab && show(e.target.dataset.tab));

  // Los motivos se administran en caliente: se recargan al volver al inicio
  const refreshReasons = async () => {
    try {
      branch = await api(`/api/public/branches/${encodeURIComponent(code)}`);
      $('#walkin-reason').innerHTML = reasonOptions(branch.reasons);
      $('#book-reason').innerHTML = reasonOptions(branch.reasons.filter((r) => r.allowAppointments));
    } catch { /* se mantiene la lista anterior */ }
  };
  const describe = (select, out) =>
    select.addEventListener('change', () => {
      const r = branch.reasons.find((x) => x.id === select.value);
      out.textContent = r ? [r.description, `Dirección: ${r.department}`].filter(Boolean).join(' · ') : '';
    });

  // ── Solicitar turno ──
  forms.walkin = mountCitizenForm($('#walkin-citizen'), { brand, withName: true, keypad: !isWeb });
  const walkinPref = mountPreferential($('#walkin-pref-wrap'), $('#walkin-pref'));
  $('#walkin-reason').innerHTML = reasonOptions(branch.reasons);
  describe($('#walkin-reason'), $('#walkin-reason-desc'));

  let busy = false;
  $('#walkin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const err = forms.walkin.validate() ?? (!$('#walkin-reason').value ? 'Seleccione el motivo de atención' : null);
    $('#walkin-error').textContent = err ?? '';
    if (err) return;
    busy = true;
    try {
      const ticket = await api('/api/public/tickets', {
        method: 'POST',
        body: { branchId: branch.id, reasonId: $('#walkin-reason').value, preferentialType: walkinPref(), ...forms.walkin.value },
      });
      const citizenName = forms.walkin.value.citizenName;
      forms.walkin.reset();
      walkinPref.reset?.();
      $('#walkin-reason').value = '';
      $('#walkin-reason-desc').textContent = '';
      showTicket(ticket, citizenName, async () => {
        await refreshReasons();
        show('walkin');
      });
    } catch (error) {
      $('#walkin-error').textContent = error.message;
    } finally {
      busy = false;
    }
  });

  // ── Check-in ──
  forms.checkin = mountCitizenForm($('#checkin-citizen'), { brand, withName: false, keypad: !isWeb });
  $('#checkin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = forms.checkin.validate();
    $('#checkin-error').textContent = err ?? '';
    if (err) return;
    try {
      const ticket = await api('/api/public/appointments/check-in', {
        method: 'POST',
        body: { branchId: branch.id, ...forms.checkin.value },
      });
      forms.checkin.reset();
      showTicket(ticket, null, () => show('checkin'), 'Llegada registrada');
    } catch (error) {
      $('#checkin-error').textContent = error.message;
    }
  });

  // ── Agendar cita ──
  forms.book = mountCitizenForm($('#book-citizen'), { brand, withName: true, keypad: false });
  const bookPref = mountPreferential($('#book-pref-wrap'), $('#book-pref'));
  $('#book-reason').innerHTML = reasonOptions(branch.reasons.filter((r) => r.allowAppointments));
  describe($('#book-reason'), $('#book-reason-desc'));
  const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: brand.timezone }).format(d);
  $('#book-date').min = ymd(new Date());
  $('#book-date').max = ymd(new Date(Date.now() + brand.appointments.maxDaysAhead * 86_400_000));

  let selectedTime = null;
  const loadSlots = async () => {
    selectedTime = null;
    $('#book-submit').disabled = true;
    $('#book-error').textContent = '';
    const reasonId = $('#book-reason').value;
    const date = $('#book-date').value;
    if (!reasonId || !date) return;
    $('#slots').innerHTML = '<span class="muted">Cargando…</span>';
    try {
      const av = await api('/api/public/appointments/availability', { query: { branchId: branch.id, reasonId, date } });
      $('#slots').innerHTML = av.slots.some((s) => s.available > 0)
        ? av.slots
            .map((s) => `<button type="button" data-time="${s.time}" ${s.available ? '' : 'disabled'} aria-pressed="false">${s.time}</button>`)
            .join('')
        : '<span class="muted">No quedan horarios disponibles ese día.</span>';
    } catch (error) {
      $('#slots').innerHTML = `<span class="error-msg">${escapeHtml(error.message)}</span>`;
    }
  };
  $('#book-reason').addEventListener('change', loadSlots);
  $('#book-date').addEventListener('change', loadSlots);
  $('#slots').addEventListener('click', (e) => {
    const b = e.target.closest('[data-time]');
    if (!b || b.disabled) return;
    for (const x of $('#slots').querySelectorAll('button')) x.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-pressed', 'true');
    selectedTime = b.dataset.time;
    $('#book-submit').disabled = false;
  });
  $('#book-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = forms.book.validate();
    $('#book-error').textContent = err ?? '';
    if (err) return;
    try {
      const appt = await api('/api/public/appointments', {
        method: 'POST',
        body: {
          branchId: branch.id,
          reasonId: $('#book-reason').value,
          date: $('#book-date').value,
          time: selectedTime,
          preferentialType: bookPref(),
          ...forms.book.value,
        },
      });
      showAppointment(appt, branch);
    } catch (error) {
      $('#book-error').textContent = error.message;
      if (error.code === 'SLOT_FULL') loadSlots();
    }
  });

  show(isWeb ? 'book' : 'walkin');
  // Si cambian los motivos (panel de administración) mientras el tótem está en reposo
  setInterval(() => $('#result').hidden && refreshReasons(), 5 * 60_000);
}

function showTicket(ticket, citizenName, onDone, heading = 'Su turno es') {
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = true;
  const trackUrl = `${location.origin}/totem.html?track=${ticket.id}`;
  const result = $('#result');
  result.hidden = false;
  result.innerHTML = `
    <div class="ticket-print">
      <div class="muted">${escapeHtml(heading)}</div>
      <div class="code">${escapeHtml(ticket.code)}</div>
      <div class="ticket-cedula">Cédula ${escapeHtml(ticket.citizen.display)}</div>
      ${citizenName ? `<div>${escapeHtml(citizenName)}</div>` : ''}
      <p><strong>${escapeHtml(ticket.reason.name)}</strong><br><span class="muted">${escapeHtml(ticket.reason.department)}</span></p>
      ${ticket.preferentialType ? `<p><span class="pill pref">Atención preferencial · ${escapeHtml(PREFERENTIAL[ticket.preferentialType])}</span></p>` : ''}
      <div class="stats">
        <div><b>${ticket.position ?? '—'}</b><span class="muted">en la fila</span></div>
        <div><b>${ticket.estimatedWaitMin != null ? `~${ticket.estimatedWaitMin}'` : '—'}</b><span class="muted">espera estimada</span></div>
      </div>
      <p class="muted">Esté atento a la pantalla: se le llamará por su número de cédula.<br>
        Siga su turno desde el celular: <a href="${trackUrl}">${trackUrl}</a></p>
      <button class="btn lg" id="done">Listo</button>
    </div>`;
  const done = () => {
    clearTimeout(timer);
    onDone();
  };
  const timer = setTimeout(done, brand.totem.resetSeconds * 1000);
  $('#done').addEventListener('click', done);
}

function showAppointment(appt, branch) {
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = true;
  const result = $('#result');
  result.hidden = false;
  result.innerHTML = `
    <div class="ticket-print">
      <div class="muted">Cita confirmada</div>
      <div class="code">${escapeHtml(appt.code)}</div>
      <div class="ticket-cedula">Cédula ${escapeHtml(appt.citizen.display)}</div>
      <p><strong>${escapeHtml(appt.reason.name)}</strong> · ${escapeHtml(branch.name)}</p>
      <p style="font-size:1.3rem;margin:16px 0"><strong>${fmtDate(appt.scheduledAt)}</strong> a las <strong>${fmtTime(appt.scheduledAt)}</strong></p>
      <p class="muted">El día de la cita registre su llegada en el tótem (opción “Tengo cita”) con su cédula,
        desde ${brand.appointments.checkInEarlyMinutes} minutos antes. Traiga los recaudos del trámite.</p>
      <button class="btn lg" id="done">Volver</button>
    </div>`;
  $('#done').addEventListener('click', () => location.reload());
}

async function renderTracking(ticketId) {
  const app = $('#app');
  const render = (t) => {
    const called = t.status === 'CALLED';
    app.innerHTML = `
      <div class="ticket-print" style="${called ? 'border-color:var(--brand-secondary)' : ''}">
        <div class="muted">${escapeHtml(t.reason.name)}</div>
        <div class="code">${escapeHtml(t.code)}</div>
        <div class="ticket-cedula">Cédula ${escapeHtml(t.citizen.display)}</div>
        <p><span class="pill ${t.status}">${STATUS[t.status]}</span></p>
        ${called && t.desk ? `<p style="font-size:1.8rem;font-weight:800;color:var(--brand-secondary)">Pase a ${escapeHtml(deskLabel(brand, t.desk.number))}</p>` : ''}
        ${t.position ? `<p>Personas delante: <strong>${t.position - 1}</strong> · espera estimada <strong>~${t.estimatedWaitMin} min</strong></p>` : ''}
        ${t.type === 'SCHEDULED' && !t.checkedInAt && t.status === 'WAITING' ? `<p class="muted">Cita: ${fmtDate(t.scheduledAt)} ${fmtTime(t.scheduledAt)}. Registre su llegada en el tótem.</p>` : ''}
        ${t.status === 'WAITING' ? '<button class="btn ghost" id="cancel">Cancelar mi turno</button>' : ''}
      </div>`;
    $('#cancel')?.addEventListener('click', async () => {
      if (!confirm('¿Cancelar el turno?')) return;
      try {
        render({ ...(await api(`/api/public/tickets/${ticketId}/cancel`, { method: 'POST' })), position: null });
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  };

  const refresh = async () => {
    try {
      render(await api(`/api/public/tickets/${ticketId}`));
    } catch (err) {
      app.innerHTML = `<p class="error-msg">${escapeHtml(err.message)}</p>`;
    }
  };
  await refresh();

  const socket = connectSocket();
  socket.on('connect', () => socket.emit('ticket:watch', { ticketId }));
  socket.on('ticket:called', ({ ticket }) => {
    if (ticket.id !== ticketId) return;
    navigator.vibrate?.([300, 150, 300]);
    refresh();
  });
  socket.on('ticket:updated', ({ ticket }) => ticket.id === ticketId && refresh());
  setInterval(refresh, 30_000);
}
