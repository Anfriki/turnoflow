import { applyBrand } from './brand.js';
import { api, connectSocket, escapeHtml, getBranchCode, renderBranchPicker } from './api.js';
import { announce, unlockAudio } from './sound.js';

const $ = (sel) => document.querySelector(sel);
const brand = await applyBrand('Pantalla de sala');

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

  // Reloj
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

  const showNow = (t, animate) => {
    $('#now-code').textContent = t.code;
    $('#now-desk').textContent = t.desk ? t.desk.identifier : '';
    $('#now-category').textContent = t.category.name;
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
        (t) => `<div class="history-row status-${t.status}"><span>${escapeHtml(t.code)}</span><span class="desk">${escapeHtml(t.desk?.identifier ?? '')}</span></div>`,
      )
      .join('');
    $('#waiting').innerHTML = s.categories
      .map((c) => `<span class="chip">${escapeHtml(c.name)} <b>${c.waiting}</b></span>`)
      .join('');
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
