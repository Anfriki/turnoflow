import { applyBrand } from './brand.js';
import { api, connectSocket, escapeHtml, getBranchCode, renderBranchPicker } from './api.js';
import { deskLabel } from './labels.js';
import { announce, unlockAudio } from './sound.js';

const $ = (sel) => document.querySelector(sel);
const brand = await applyBrand('Pantalla de sala');
/** Se llama por cédula salvo que la marca pida llamar por turno o la cédula vaya enmascarada sin número legible. */
const byCedula = brand.display.callBy === 'cedula';

const code = getBranchCode();
if (!code) {
  document.body.classList.remove('display');
  $('#sound-gate').hidden = true;
  await renderBranchPicker($('#app'));
} else {
  await init(code);
}

async function init(code) {
  const branch = await api(`/api/public/branches/${encodeURIComponent(code)}`);
  $('#branch-name').textContent = branch.name;
  $('#ticker').textContent = brand.display.ticker;

  const tick = () =>
    ($('#clock').textContent = new Date().toLocaleTimeString(brand.locale, {
      timeZone: brand.timezone,
      hour: '2-digit',
      minute: '2-digit',
    }));
  tick();
  setInterval(tick, 10_000);

  // Los navegadores bloquean el audio sin interacción previa: un toque lo habilita.
  const gate = $('#sound-gate');
  gate.addEventListener('click', () => {
    unlockAudio(brand.assets.callSound);
    gate.hidden = true;
  });

  let lastCalledId = null;

  /** "Turno ZE-001 · V-12.345.678 · pase a · Taquilla N° 3" (callBy decide cuál va más grande) */
  const showNow = (t, animate) => {
    $('#now-secondary').textContent = byCedula ? `Turno ${t.code}` : `Cédula ${t.citizen.display}`;
    $('#now-main').textContent = byCedula ? t.citizen.display : t.code;
    $('#now-main').classList.toggle('cedula', byCedula);
    $('#now-pass').textContent = 'pase a';
    $('#now-desk').textContent = t.desk ? deskLabel(brand, t.desk.number) : '';
    $('#now-sub').textContent = [t.dependency?.name.split(' (')[0], t.reason.name].filter(Boolean).join(' · ');
    if (animate) {
      const now = $('#now');
      now.classList.remove('flash');
      void now.offsetWidth; // reinicia la animación
      now.classList.add('flash');
    }
  };

  const renderSnapshot = (s) => {
    const [latest, ...rest] = s.recentCalls;
    if (latest && latest.id !== lastCalledId) {
      showNow(latest, false);
      lastCalledId = latest.id;
    }
    $('#history').innerHTML = (latest ? rest : [])
      .map(
        (t) => `<div class="history-row three status-${t.status}">
          <span class="h-code">${escapeHtml(t.code)}</span>
          <span class="h-cedula">${escapeHtml(t.citizen.display)}</span>
          <span class="desk">${escapeHtml(t.desk ? deskLabel(brand, t.desk.number) : '')}</span></div>`,
      )
      .join('');
    // En espera por dependencia (Zona Educativa / Atención al Ciudadano); sin dependencias, por trámite
    const chips = s.dependencies?.length
      ? s.dependencies.map((d) => ({ name: d.name.split(' (')[0], waiting: d.waiting }))
      : s.reasons.filter((r) => r.waiting > 0);
    $('#waiting').innerHTML =
      `<span class="chip">En espera <b>${s.totals.waiting}</b></span>` +
      (s.totals.waitingPreferential ? `<span class="chip pref">Preferencial <b>${s.totals.waitingPreferential}</b></span>` : '') +
      chips.map((r) => `<span class="chip">${escapeHtml(r.name)} <b>${r.waiting}</b></span>`).join('');
  };

  renderSnapshot(await api(`/api/public/branches/${branch.id}/queue`));

  const socket = connectSocket();
  socket.on('connect', () => {
    $('#conn').classList.add('on');
    socket.emit('branch:join', { branchId: branch.id }, (res) => res.ok && renderSnapshot(res.snapshot));
  });
  socket.on('disconnect', () => $('#conn').classList.remove('on'));

  socket.on('ticket:called', ({ ticket }) => {
    lastCalledId = ticket.id;
    showNow(ticket, true);
    announce(ticket, brand);
  });
  socket.on('queue:updated', renderSnapshot);
}
