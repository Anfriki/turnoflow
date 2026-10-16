/** Vocabulario institucional compartido por las vistas. */

export const STATUS = {
  WAITING: 'En espera',
  CALLED: 'Llamado',
  IN_SERVICE: 'En atención',
  ATTENDED: 'Atendido',
  ABSENT: 'Ausente',
  CANCELLED: 'Cancelado',
};

export const RESOLUTION = {
  RESUELTO: { label: 'Resuelto', hint: 'Trámite concluido satisfactoriamente' },
  EN_TRAMITE: { label: 'En trámite', hint: 'Requiere seguimiento' },
  REMITIDO: { label: 'Remitido', hint: 'Enviado a otra Dirección u organismo' },
  NO_PROCEDE: { label: 'No procede', hint: 'Rechazado: no aplica o falta de requisitos' },
  PENDIENTE_RECAUDOS: { label: 'Pendiente de recaudos', hint: 'El ciudadano debe consignar documentos' },
};

export const PREFERENTIAL = {
  TERCERA_EDAD: 'Tercera edad',
  EMBARAZADA: 'Embarazada',
  DISCAPACIDAD: 'Persona con discapacidad',
};

export const DAYS = ['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
export const MONTHS = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

/** "Taquilla N° 3" según brand.deskLabel. */
export const deskLabel = (brand, number) =>
  number == null ? '' : brand.deskLabel.replace('{number2}', String(number).padStart(2, '0')).replace('{number}', String(number));

const thousands = (s) => s.replace(/(?=(?:.{3})+$)/g, '.').replace(/^\./, '');

/** Formato visible de un documento: V-12.345.678 · J-12345678-9 */
export function formatCedula(origin, number) {
  if (!number) return '';
  if ((origin === 'J' || origin === 'G') && number.length === 9) return `${origin}-${number.slice(0, 8)}-${number.slice(8)}`;
  if (origin === 'J' || origin === 'G') return `${origin}-${number}`;
  return `${origin}-${thousands(number)}`;
}

export const minutes = (seconds) => (seconds == null ? '—' : `${(seconds / 60).toFixed(1).replace('.', ',')} min`);
