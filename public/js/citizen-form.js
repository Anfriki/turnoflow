import { api, escapeHtml } from './api.js';
import { formatCedula } from './labels.js';

/** Largo permitido del número por origen (igual que el backend). */
const LENGTH = { V: [4, 8], E: [4, 10], J: [8, 9], G: [8, 9] };
let uid = 0;

/**
 * Bloque de identificación del ciudadano:
 *   [V][E][J][G]  [ número de cédula ]  [Buscar]
 *   estado de la consulta
 *   [ Nombre y apellido ]         (opcional)
 *   teclado numérico en pantalla  (opcional, para tótems táctiles)
 *
 * Al completar la cédula consulta /api/public/citizens/lookup (SAIME / cache)
 * y autocompleta el nombre, que sigue siendo editable.
 */
export function mountCitizenForm(container, { brand, withName = true, keypad = false } = {}) {
  const id = `cz${++uid}`;
  const origins = brand.citizen.allowedOrigins;
  const state = { origin: origins[0], autoFilled: false, lookupSeq: 0, timer: null };

  container.innerHTML = `
    <div class="field">
      <label id="${id}-lbl">Cédula de identidad</label>
      <div class="cedula-row">
        <div class="seg" role="radiogroup" aria-labelledby="${id}-lbl">
          ${origins
            .map(
              (o) => `<button type="button" role="radio" data-origin="${o}" title="${escapeHtml(brand.citizen.originLabels[o] ?? o)}"
                aria-checked="${o === state.origin}">${o}</button>`,
            )
            .join('')}
        </div>
        <input id="${id}-num" class="cedula-input" inputmode="numeric" autocomplete="off" maxlength="12"
          placeholder="Número" aria-describedby="${id}-status" required />
        ${brand.citizenLookupEnabled ? `<button type="button" class="btn ghost" data-lookup>Buscar</button>` : ''}
      </div>
      <div class="lookup-status" id="${id}-status" aria-live="polite"></div>
    </div>
    ${
      withName
        ? `<div class="field">
            <label for="${id}-name">Nombre y apellido</label>
            <input id="${id}-name" autocomplete="off" maxlength="150" required />
          </div>`
        : ''
    }
    ${
      keypad
        ? `<div class="keypad" aria-label="Teclado numérico">
            ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-key="${n}">${n}</button>`).join('')}
            <button type="button" data-key="clear" class="muted-key">Borrar</button>
            <button type="button" data-key="0">0</button>
            <button type="button" data-key="back" class="muted-key" aria-label="Borrar último dígito">⌫</button>
          </div>`
        : ''
    }`;

  const num = container.querySelector(`#${id}-num`);
  const name = container.querySelector(`#${id}-name`);
  const status = container.querySelector(`#${id}-status`);

  const setStatus = (text, kind = '') => {
    status.textContent = text;
    status.className = `lookup-status ${kind}`;
  };
  const digits = () => num.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  const lengthOk = () => {
    const [min, max] = LENGTH[state.origin];
    const n = digits().length;
    return n >= min && n <= max;
  };

  async function lookup() {
    if (!brand.citizenLookupEnabled || !withName || !lengthOk()) return;
    const seq = ++state.lookupSeq;
    const cedula = formatCedula(state.origin, digits());
    setStatus(`Buscando ${cedula}…`);
    try {
      const r = await api('/api/public/citizens/lookup', { query: { idOrigin: state.origin, idNumber: digits() } });
      if (seq !== state.lookupSeq) return; // llegó una respuesta vieja
      if (r.found && !r.masked) {
        if (!name.value.trim() || state.autoFilled) {
          name.value = r.fullName;
          state.autoFilled = true;
        }
        setStatus(`✓ ${cedula} registrado. Verifique el nombre.`, 'ok');
      } else if (r.found && r.masked) {
        setStatus(`✓ ${cedula} registrado como ${r.fullName}. Escriba su nombre para confirmar.`, 'ok');
      } else {
        if (state.autoFilled) name.value = '';
        state.autoFilled = false;
        setStatus(`${cedula} no está en el registro. Escriba su nombre y apellido.`, 'warn');
      }
    } catch (err) {
      if (seq === state.lookupSeq) setStatus(err.status === 429 ? err.message : 'No se pudo consultar. Escriba su nombre y apellido.', 'warn');
    }
  }

  const scheduleLookup = () => {
    clearTimeout(state.timer);
    setStatus(digits() ? formatCedula(state.origin, digits()) : '');
    if (lengthOk()) state.timer = setTimeout(lookup, 600);
  };

  container.addEventListener('click', (e) => {
    const o = e.target.closest('[data-origin]');
    if (o) {
      state.origin = o.dataset.origin;
      for (const b of container.querySelectorAll('[data-origin]')) b.setAttribute('aria-checked', String(b === o));
      scheduleLookup();
      return;
    }
    if (e.target.closest('[data-lookup]')) return lookup();
    const k = e.target.closest('[data-key]');
    if (k) {
      const key = k.dataset.key;
      if (key === 'clear') num.value = '';
      else if (key === 'back') num.value = num.value.slice(0, -1);
      else if (num.value.length < 10) num.value += key;
      scheduleLookup();
    }
  });
  num.addEventListener('input', () => {
    num.value = num.value.replace(/[^\d]/g, '');
    scheduleLookup();
  });
  num.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && withName) {
      e.preventDefault();
      lookup();
      name.focus();
    }
  });
  name?.addEventListener('input', () => (state.autoFilled = false));

  return {
    get value() {
      return {
        idOrigin: state.origin,
        idNumber: digits(),
        ...(withName ? { citizenName: name.value.trim().replace(/\s+/g, ' ') } : {}),
      };
    },
    /** Devuelve un mensaje de error o null si es válido. */
    validate() {
      if (!digits()) return 'Ingrese el número de cédula';
      if (!lengthOk()) {
        const [min, max] = LENGTH[state.origin];
        return `Para ${state.origin} el número debe tener ${min === max ? min : `entre ${min} y ${max}`} dígitos`;
      }
      if (withName && name.value.trim().length < 3) return 'Ingrese nombre y apellido';
      return null;
    },
    reset() {
      num.value = '';
      if (name) name.value = '';
      state.autoFilled = false;
      state.lookupSeq++;
      setStatus('');
    },
    focus: () => num.focus(),
  };
}
