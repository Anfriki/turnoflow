import { applyBrand } from './brand.js';
import { api, connectSocket, escapeHtml, getBranchCode, renderBranchPicker, toast } from './api.js';

const $ = (sel) => document.querySelector(sel);
const brand = await applyBrand('Tótem');
const params = new URLSearchParams(location.search);

const STATUS_TEXT = {
  WAITING: 'En espera',
  CALLED: '¡Te están llamando!',
  IN_SERVICE: 'En atención',
  ATTENDED: 'Atendido',
  ABSENT: 'Ausente',
  CANCELLED: 'Cancelado',
};

const fmtTime = (iso) =>
  new Date(iso).toLocaleTimeString(brand.locale, { timeZone: brand.timezone, hour: '2-digit', minute: '2-digit' });
const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString(brand.locale, { timeZone: brand.timezone, weekday: 'long', day: 'numeric', month: 'long' });

// ── Modo seguimiento: /totem.html?track=<ticketId> (para el celular del cliente) ──
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
    localStorage.removeItem('turnoflow.branch');
    return renderBranchPicker($('#app'));
  }
  $('#branch-name').textContent = branch.name;
  for (const el of document.querySelectorAll('.id-label')) el.textContent = brand.totem.customerIdentifierLabel;

  // Pestañas. ?mode=web abre directamente "Agendar cita" (enlace para la web institucional).
  const tabs = $('#tabs');
  tabs.hidden = false;
  const show = (name) => {
    for (const b of tabs.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== name;
    $('#result').hidden = true;
  };
  tabs.addEventListener('click', (e) => e.target.dataset.tab && show(e.target.dataset.tab));
  show(params.get('mode') === 'web' ? 'book' : 'walkin');

  // ── Sacar turno ──
  $('#categories').innerHTML = branch.categories
    .map(
      (c) => `
      <button class="category-btn ${c.priorityLevel > 0 ? 'priority' : ''}" data-id="${c.id}">
        <span class="letter">${escapeHtml(c.prefixLetter)}</span>
        <span class="name">${escapeHtml(c.name)}</span>
        <span class="muted">~${c.estimatedDurationMin} min por persona</span>
      </button>`,
    )
    .join('');

  let busy = false;
  $('#categories').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-id]');
    if (!btn || busy) return;
    busy = true;
    try {
      const ticket = await api('/api/public/tickets', { method: 'POST', body: { branchId: branch.id, categoryId: btn.dataset.id } });
      showTicket(ticket, 'Tu turno es', () => show('walkin'));
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      busy = false;
    }
  });

  // ── Check-in ──
  $('#checkin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#checkin-error').textContent = '';
    try {
      const ticket = await api('/api/public/appointments/check-in', {
        method: 'POST',
        body: { branchId: branch.id, customerIdentifier: $('#checkin-id').value.trim() },
      });
      e.target.reset();
      showTicket(ticket, 'Llegada registrada. Tu turno es', () => show('checkin'));
    } catch (err) {
      $('#checkin-error').textContent = err.message;
    }
  });

  // ── Agendar cita ──
  const bookable = branch.categories.filter((c) => c.allowAppointments);
  $('#book-category').innerHTML =
    '<option value="">Elegí un trámite…</option>' +
    bookable.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: brand.timezone }).format(new Date());
  const max = new Date(Date.now() + brand.appointments.maxDaysAhead * 86_400_000);
  $('#book-date').min = today;
  $('#book-date').max = new Intl.DateTimeFormat('en-CA', { timeZone: brand.timezone }).format(max);

  let selectedTime = null;
  const loadSlots = async () => {
    selectedTime = null;
    $('#book-submit').disabled = true;
    $('#book-error').textContent = '';
    const categoryId = $('#book-category').value;
    const date = $('#book-date').value;
    if (!categoryId || !date) return;
    $('#slots').innerHTML = '<span class="muted">Cargando…</span>';
    try {
      const av = await api('/api/public/appointments/availability', { query: { branchId: branch.id, categoryId, date } });
      const free = av.slots.filter((s) => s.available > 0).length;
      $('#slots').innerHTML = free
        ? av.slots
            .map((s) => `<button type="button" data-time="${s.time}" ${s.available ? '' : 'disabled'} aria-pressed="false">${s.time}</button>`)
            .join('')
        : '<span class="muted">No quedan horarios disponibles ese día.</span>';
    } catch (err) {
      $('#slots').innerHTML = `<span class="error-msg">${escapeHtml(err.message)}</span>`;
    }
  };
  $('#book-category').addEventListener('change', loadSlots);
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
    $('#book-error').textContent = '';
    try {
      const appt = await api('/api/public/appointments', {
        method: 'POST',
        body: {
          branchId: branch.id,
          categoryId: $('#book-category').value,
          date: $('#book-date').value,
          time: selectedTime,
          customerIdentifier: $('#book-id').value.trim(),
        },
      });
      e.target.reset();
      $('#slots').innerHTML = '<span class="muted">Elegí trámite y fecha.</span>';
      showAppointment(appt, branch);
    } catch (err) {
      $('#book-error').textContent = err.message;
      if (err.code === 'SLOT_FULL') loadSlots();
    }
  });
}

function showTicket(ticket, heading, onDone) {
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = true;
  const trackUrl = `${location.origin}/totem.html?track=${ticket.id}`;
  const result = $('#result');
  result.hidden = false;
  result.innerHTML = `
    <div class="ticket-print">
      <div class="muted">${escapeHtml(heading)}</div>
      <div class="code">${escapeHtml(ticket.code)}</div>
      <div><strong>${escapeHtml(ticket.category.name)}</strong></div>
      <div class="stats">
        <div><b>${ticket.position ?? '—'}</b><span class="muted">en la fila</span></div>
        <div><b>${ticket.estimatedWaitMin != null ? `~${ticket.estimatedWaitMin}'` : '—'}</b><span class="muted">espera estimada</span></div>
      </div>
      <p class="muted">Atento a la pantalla. Seguí tu turno desde el celular:<br><a href="${trackUrl}">${trackUrl}</a></p>
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
      <div><strong>${escapeHtml(appt.category.name)}</strong> · ${escapeHtml(branch.name)}</div>
      <p style="font-size:1.3rem;margin:16px 0"><strong>${fmtDate(appt.scheduledAt)}</strong> a las <strong>${fmtTime(appt.scheduledAt)}</strong></p>
      <p class="muted">El día de la cita, registrá tu llegada en el tótem (opción “Tengo cita”) hasta ${brand.appointments.checkInEarlyMinutes} minutos antes.</p>
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
        <div class="muted">${escapeHtml(t.category.name)}</div>
        <div class="code">${escapeHtml(t.code)}</div>
        <p><span class="pill ${t.status}">${STATUS_TEXT[t.status]}</span></p>
        ${called && t.desk ? `<p style="font-size:1.8rem;font-weight:800;color:var(--brand-secondary)">Dirigite a ${escapeHtml(t.desk.identifier)}</p>` : ''}
        ${t.position ? `<p>Personas delante: <strong>${t.position - 1}</strong> · espera estimada <strong>~${t.estimatedWaitMin} min</strong></p>` : ''}
        ${t.type === 'SCHEDULED' && !t.checkedInAt && t.status === 'WAITING' ? `<p class="muted">Cita: ${fmtDate(t.scheduledAt)} ${fmtTime(t.scheduledAt)}. Registrá tu llegada en el tótem.</p>` : ''}
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
  // La posición cambia cuando otros avanzan: refresco periódico liviano
  setInterval(refresh, 30_000);
}
