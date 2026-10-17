import { applyBrand } from './brand.js';
import { api, connectSocket, escapeHtml, getBranchCode, renderBranchPicker, toast } from './api.js';
import { mountCitizenForm } from './citizen-form.js';
import { deskLabel, formatCedula, PREFERENTIAL, STATUS } from './labels.js';

const $ = (sel) => document.querySelector(sel);
const brand = await applyBrand('Registro de turnos');
const params = new URLSearchParams(location.search);
const isWeb = params.get('mode') === 'web';

const fmtTime = (iso) =>
  new Date(iso).toLocaleTimeString(brand.locale, { timeZone: brand.timezone, hour: '2-digit', minute: '2-digit' });
const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString(brand.locale, { timeZone: brand.timezone, weekday: 'long', day: 'numeric', month: 'long' });

/** "Zona Educativa (Caracas / Distrito Capital)" → "Zona Educativa" */
const shortName = (dep) => dep.name.split(' (')[0];

/** Agrupa los trámites por Dirección, respetando el orden del catálogo. */
function groupByDepartment(reasons) {
  const byDept = new Map();
  for (const r of reasons) byDept.set(r.department, [...(byDept.get(r.department) ?? []), r]);
  return byDept;
}

/** <select> de trámites agrupado por Dirección (optgroup). */
function reasonOptions(reasons) {
  return (
    '<option value="">Seleccione un trámite…</option>' +
    [...groupByDepartment(reasons)]
      .map(
        ([dept, list]) =>
          `<optgroup label="${escapeHtml(dept)}">${list
            .map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`)
            .join('')}</optgroup>`,
      )
      .join('')
  );
}

/**
 * Check opcional de atención preferencial. Al marcarlo aparecen los tipos
 * (adulto mayor, embarazada, discapacidad). Devuelve un getter del valor.
 */
function mountPreferential(container) {
  if (!brand.totem.preferentialEnabled) {
    container.hidden = true;
    const none = () => null;
    none.reset = () => {};
    return none;
  }
  container.classList.add('field', 'pref-box');
  container.innerHTML = `
    <label class="pref-check">
      <input type="checkbox" />
      <span><strong>Requiere atención preferencial</strong>
        <small>Adulto mayor, embarazada o persona con discapacidad</small></span>
    </label>
    <div class="seg wide pref-types" role="radiogroup" aria-label="Tipo de atención preferencial" hidden>
      ${Object.entries(PREFERENTIAL)
        .map(([v, l], i) => `<button type="button" role="radio" data-pref="${v}" aria-checked="${i === 0}">${escapeHtml(l)}</button>`)
        .join('')}
    </div>`;
  const check = container.querySelector('input[type=checkbox]');
  const types = container.querySelector('.pref-types');
  let type = Object.keys(PREFERENTIAL)[0];
  check.addEventListener('change', () => (types.hidden = !check.checked));
  types.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pref]');
    if (!b) return;
    type = b.dataset.pref;
    for (const x of types.querySelectorAll('[data-pref]')) x.setAttribute('aria-checked', String(x === b));
  });
  const get = () => (check.checked ? type : null);
  get.reset = () => {
    check.checked = false;
    types.hidden = true;
    types.querySelector('[data-pref]').click();
  };
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

  // ════════ Solicitar turno: asistente de 3 pasos ════════
  const hasDeps = () => branch.dependencies.length > 0;
  const wiz = { step: 1, dependency: null, department: null, reason: null };

  forms.walkin = mountCitizenForm($('#walkin-citizen'), { brand, withName: true, keypad: !isWeb });
  const walkinPref = mountPreferential($('#walkin-pref'));

  const goStep = (n) => {
    wiz.step = n;
    for (const c of document.querySelectorAll('.wiz')) c.hidden = Number(c.dataset.step) !== n;
    for (const li of document.querySelectorAll('#wiz-steps li')) {
      const s = Number(li.dataset.step);
      li.classList.toggle('active', s === n);
      li.classList.toggle('done', s < n);
      li.hidden = s === 2 && !hasDeps();
    }
    for (const el of document.querySelectorAll('[data-error]')) el.textContent = '';
    const c = forms.walkin.value;
    const pref = walkinPref();
    const who = `${formatCedula(c.idOrigin, c.idNumber)} · ${c.citizenName}${pref ? ` · ${PREFERENTIAL[pref]}` : ''}`;
    for (const el of document.querySelectorAll('.wiz-who')) el.textContent = n > 1 ? who : '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const renderDependencies = () => {
    $('#dep-options').innerHTML = branch.dependencies
      .map(
        (d) => `<button type="button" class="dep-card" data-dep="${d.id}">
          <span class="dep-icon" aria-hidden="true">${escapeHtml(d.icon ?? '🏢')}</span>
          <span class="dep-name">${escapeHtml(d.name)}</span>
          <span class="dep-desc">${escapeHtml(d.description ?? '')}</span>
          <span class="dep-prefix">Turnos ${escapeHtml(d.prefix)}-001</span>
        </button>`,
      )
      .join('');
  };

  const renderDirections = () => {
    const groups = groupByDepartment(branch.reasons);
    $('#dep-chosen').innerHTML = wiz.dependency
      ? `${escapeHtml(wiz.dependency.icon ?? '')} <strong>${escapeHtml(wiz.dependency.name)}</strong>`
      : '';
    $('#dir-options').innerHTML = [...groups]
      .map(
        ([dept, list]) => `<button type="button" role="tab" class="dir-btn" data-dept="${escapeHtml(dept)}"
          aria-selected="${dept === wiz.department}"><span>${escapeHtml(dept)}</span><small>${list.length} trámite${list.length > 1 ? 's' : ''}</small></button>`,
      )
      .join('');
    const list = wiz.department ? groups.get(wiz.department) ?? [] : [];
    $('#tramite-list').innerHTML = wiz.department
      ? `<h3>${escapeHtml(wiz.department)}</h3>` +
        list
          .map(
            (r) => `<button type="button" role="radio" class="tramite-btn" data-reason="${r.id}" aria-checked="${r.id === wiz.reason?.id}">
              <span class="tramite-code">${escapeHtml(r.code)}</span>
              <span class="tramite-name">${escapeHtml(r.name)}</span>
              ${r.priorityLevel > 0 ? '<span class="pill pref">Prioritario</span>' : ''}
            </button>`,
          )
          .join('')
      : '<p class="muted">Toque una Dirección para ver sus trámites.</p>';
    $('#walkin-submit').disabled = !wiz.reason;
  };

  const resetWizard = () => {
    forms.walkin.reset();
    walkinPref.reset();
    Object.assign(wiz, { dependency: null, department: null, reason: null });
    goStep(1);
  };

  // Paso 1 → 2 (o → 3 si la sede no usa dependencias)
  $('#walkin-form').addEventListener('click', (e) => {
    if (e.target.closest('[data-next="2"]')) {
      const err = forms.walkin.validate();
      $('[data-error="1"]').textContent = err ?? '';
      if (err) return;
      if (hasDeps()) {
        renderDependencies();
        goStep(2);
      } else {
        renderDirections();
        goStep(3);
      }
    }
    if (e.target.closest('[data-back="1"]')) goStep(1);
    const dep = e.target.closest('[data-dep]');
    if (dep) {
      wiz.dependency = branch.dependencies.find((d) => d.id === dep.dataset.dep);
      renderDirections();
      goStep(3);
    }
    const dir = e.target.closest('[data-dept]');
    if (dir) {
      wiz.department = dir.dataset.dept;
      wiz.reason = null;
      renderDirections();
      $('#tramite-list').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    const tr = e.target.closest('[data-reason]');
    if (tr) {
      wiz.reason = branch.reasons.find((r) => r.id === tr.dataset.reason);
      renderDirections();
      $('#walkin-submit').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
  $('#back-from-3').addEventListener('click', () => goStep(hasDeps() ? 2 : 1));

  let busy = false;
  $('#walkin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || wiz.step !== 3) return;
    if (!wiz.reason) return ($('[data-error="3"]').textContent = 'Seleccione el trámite');
    busy = true;
    $('#walkin-submit').disabled = true;
    try {
      const ticket = await api('/api/public/tickets', {
        method: 'POST',
        body: {
          branchId: branch.id,
          dependencyId: wiz.dependency?.id ?? null,
          reasonId: wiz.reason.id,
          preferentialType: walkinPref(),
          ...forms.walkin.value,
        },
      });
      const citizenName = forms.walkin.value.citizenName;
      resetWizard();
      showTicket(ticket, citizenName, async () => {
        await refreshCatalog();
        show('walkin');
      });
    } catch (error) {
      $('[data-error="3"]').textContent = error.message;
      $('#walkin-submit').disabled = false;
    } finally {
      busy = false;
    }
  });

  // ════════ Check-in ════════
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

  // ════════ Agendar cita ════════
  forms.book = mountCitizenForm($('#book-citizen'), { brand, withName: true, keypad: false });
  const bookPref = mountPreferential($('#book-pref'));
  let bookDep = null;
  const renderBookDeps = () => {
    $('#book-dep-wrap').hidden = !hasDeps();
    $('#book-dep').innerHTML = branch.dependencies
      .map((d) => `<button type="button" role="radio" data-bdep="${d.id}" aria-checked="${d.id === bookDep}">${escapeHtml(d.icon ?? '')} ${escapeHtml(shortName(d))}</button>`)
      .join('');
  };
  const describe = (select, out) =>
    select.addEventListener('change', () => {
      const r = branch.reasons.find((x) => x.id === select.value);
      out.textContent = r ? [r.description, `Dirección: ${r.department}`].filter(Boolean).join(' · ') : '';
    });
  renderBookDeps();
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
    if (!reasonId || !date || (hasDeps() && !bookDep)) return;
    $('#slots').innerHTML = '<span class="muted">Cargando…</span>';
    try {
      const av = await api('/api/public/appointments/availability', {
        query: { branchId: branch.id, reasonId, date, dependencyId: bookDep ?? undefined },
      });
      $('#slots').innerHTML = av.slots.some((s) => s.available > 0)
        ? av.slots
            .map((s) => `<button type="button" data-time="${s.time}" ${s.available ? '' : 'disabled'} aria-pressed="false">${s.time}</button>`)
            .join('')
        : '<span class="muted">No quedan horarios disponibles ese día.</span>';
    } catch (error) {
      $('#slots').innerHTML = `<span class="error-msg">${escapeHtml(error.message)}</span>`;
    }
  };
  $('#book-dep').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bdep]');
    if (!b) return;
    bookDep = b.dataset.bdep;
    renderBookDeps();
    loadSlots();
  });
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
    const err = forms.book.validate() ?? (hasDeps() && !bookDep ? 'Seleccione la dependencia' : null);
    $('#book-error').textContent = err ?? '';
    if (err) return;
    try {
      const appt = await api('/api/public/appointments', {
        method: 'POST',
        body: {
          branchId: branch.id,
          dependencyId: bookDep,
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

  // El catálogo se administra en caliente: se recarga al volver al inicio
  async function refreshCatalog() {
    try {
      branch = await api(`/api/public/branches/${encodeURIComponent(code)}`);
      $('#book-reason').innerHTML = reasonOptions(branch.reasons.filter((r) => r.allowAppointments));
      renderBookDeps();
    } catch { /* se mantiene el catálogo anterior */ }
  }

  goStep(1);
  show(isWeb ? 'book' : 'walkin');
  setInterval(() => $('#result').hidden && wiz.step === 1 && refreshCatalog(), 5 * 60_000);
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
      ${ticket.dependency ? `<p class="ticket-dep">${escapeHtml(ticket.dependency.name)}</p>` : ''}
      <p><strong>${escapeHtml(ticket.reason.name)}</strong><br><span class="muted">${escapeHtml(ticket.reason.department)}</span></p>
      ${ticket.preferentialType ? `<p><span class="pill pref">Atención preferencial · ${escapeHtml(PREFERENTIAL[ticket.preferentialType])}</span></p>` : ''}
      <div class="stats">
        <div><b>${ticket.position ?? '—'}</b><span class="muted">en la fila</span></div>
        <div><b>${ticket.estimatedWaitMin != null ? `~${ticket.estimatedWaitMin}'` : '—'}</b><span class="muted">espera estimada</span></div>
      </div>
      <p class="muted">Esté atento a la pantalla: se le llamará por su número de turno y cédula.<br>
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
