/**
 * ─────────────────────────────────────────────────────────────
 *  CONFIGURACIÓN INSTITUCIONAL (WHITELABEL)
 *  Este es el ÚNICO archivo que necesitás editar para adaptar
 *  TurnoFlow a la identidad del organismo.
 *
 *  - Los textos y colores se sirven al frontend en /api/brand y
 *    como variables CSS en /brand.css (sin necesidad de rebuild).
 *  - Las variables COMPANY_NAME, COMPANY_TAGLINE, BRAND_PRIMARY_COLOR
 *    y BRAND_SECONDARY_COLOR del .env tienen prioridad sobre este archivo.
 *  - Reiniciá el servidor después de editarlo.
 *
 *  Los MOTIVOS DE ATENCIÓN no se configuran aquí: se administran desde
 *  el panel de Consultas → pestaña "Motivos" (o la API /api/admin/reasons).
 * ─────────────────────────────────────────────────────────────
 */
export default {
  companyName: 'Ministerio de Gestión Pública',
  tagline: 'Oficina de Atención al Ciudadano',
  locale: 'es-VE',

  /** Assets institucionales: reemplazá los archivos en /public/assets/ manteniendo el nombre. */
  assets: {
    logo: '/assets/logo.png',
    favicon: '/assets/favicon.ico',
    /** Sonido del llamado. Si el archivo no existe, se genera un "ding-dong" sintético. */
    callSound: '/assets/audio/ding-dong.mp3',
  },

  /** Paleta institucional → se convierte en tokens CSS (--brand-*). */
  colors: {
    primary: '#0B3D91',          // barra superior, botones principales
    primaryContrast: '#FFFFFF',
    secondary: '#C8102E',        // recuadro del llamado en TV, atención preferencial
    secondaryContrast: '#FFFFFF',
    background: '#F3F5F9',
    surface: '#FFFFFF',
    text: '#14213D',
    muted: '#5B6B82',
    success: '#1E8E4E',
    warning: '#E0A100',
    danger: '#C62828',
    displayBackground: '#071A3A',
    displayText: '#FFFFFF',
  },

  fontFamily: "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  borderRadius: '12px',

  /** Identificación del ciudadano */
  citizen: {
    /** Orígenes de documento habilitados en el tótem y la web. */
    allowedOrigins: ['V', 'E', 'J', 'G'],
    originLabels: { V: 'Venezolano', E: 'Extranjero', J: 'Jurídico (RIF)', G: 'Gobierno (RIF)' },
  },

  /** Etiqueta de taquilla. Variables: {number} (sin ceros), {number2} (01, 02…) */
  deskLabel: 'Taquilla N° {number}',

  /** Pantalla de sala */
  display: {
    /** 'cedula' → "Cédula V-12.345.678 pase a Taquilla N° 3" · 'ticket' → "Turno N-001 …" */
    callBy: 'cedula',
    /** Ocultar los últimos 3 dígitos de la cédula en la TV (V-12.345.***). Si es true, la voz anuncia el N° de turno. */
    maskCedula: false,
    voiceEnabled: true,
    /** Variables: {cedula} (número con puntos), {code}, {deskNumber}, {desk}, {reason} */
    voiceTemplateCedula: 'Cédula {cedula}, pase a la taquilla número {deskNumber}',
    voiceTemplateTicket: 'Turno {code}, pase a la taquilla número {deskNumber}',
    voiceLang: 'es-ES',
    historySize: 6,
    ticker: 'Bienvenido. Tenga a mano su cédula de identidad y los recaudos de su trámite. La atención preferencial tiene prioridad.',
  },

  /** Tótem */
  totem: {
    /** Segundos que se muestra el ticket emitido antes de volver al inicio. */
    resetSeconds: 12,
    /** Mostrar la opción de atención preferencial (tercera edad, embarazadas, discapacidad). */
    preferentialEnabled: true,
  },

  /** Reglas de atención */
  attention: {
    /** Puntos de prioridad que suma la atención preferencial a la del motivo. */
    preferentialBoost: 50,
    /** Largo mínimo de las observaciones al finalizar la atención. */
    minResolutionNotes: 10,
  },

  /** Reglas operativas para citas web. */
  appointments: {
    openingTime: '08:00',
    closingTime: '15:00',
    slotMinutes: 20,
    /** Días hábiles: 0=Domingo … 6=Sábado */
    workingDays: [1, 2, 3, 4, 5],
    maxDaysAhead: 30,
    checkInEarlyMinutes: 30,
  },
};
