/**
 * ─────────────────────────────────────────────────────────────
 *  CONFIGURACIÓN DE MARCA (WHITELABEL)
 *  Este es el ÚNICO archivo que necesitás editar para adaptar
 *  TurnoFlow a la identidad visual de tu empresa o institución.
 *
 *  - Los textos y colores se sirven al frontend en /api/brand y
 *    como variables CSS en /brand.css (sin necesidad de rebuild).
 *  - Las variables COMPANY_NAME, COMPANY_TAGLINE, BRAND_PRIMARY_COLOR
 *    y BRAND_SECONDARY_COLOR del .env tienen prioridad sobre este archivo.
 *  - Reiniciá el servidor después de editarlo.
 * ─────────────────────────────────────────────────────────────
 */
export default {
  companyName: 'Banco Regional',
  tagline: 'Atención al Cliente',
  locale: 'es-AR',

  /** Assets de marca: reemplazá los archivos en /public/assets/ manteniendo el nombre. */
  assets: {
    logo: '/assets/logo.png',
    favicon: '/assets/favicon.ico',
    /** Sonido del llamado. Si el archivo no existe, se genera un "ding-dong" sintético. */
    callSound: '/assets/audio/ding-dong.mp3',
  },

  /** Paleta corporativa → se convierte en tokens CSS (--brand-*). */
  colors: {
    primary: '#0F4C81',          // botones principales, encabezados
    primaryContrast: '#FFFFFF',  // texto sobre el color primario
    secondary: '#00A6A6',        // acentos, turno destacado en TV
    secondaryContrast: '#FFFFFF',
    background: '#F3F6FA',       // fondo general
    surface: '#FFFFFF',          // tarjetas
    text: '#14213D',
    muted: '#5B6B82',
    success: '#1E9E5A',
    warning: '#E0A100',
    danger: '#D64545',
    /** Pantalla de sala (TV): suele verse mejor en oscuro. */
    displayBackground: '#0B1F33',
    displayText: '#FFFFFF',
  },

  fontFamily: "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  borderRadius: '14px',

  /** Pantalla de sala */
  display: {
    /** Anunciar el turno por voz (Web Speech API) además del sonido. */
    voiceEnabled: true,
    /** Plantilla de voz. Variables: {code}, {desk}, {category} */
    voiceTemplate: 'Turno {code}, diríjase a {desk}',
    voiceLang: 'es-ES',
    /** Cantidad de llamados recientes que se muestran en la TV. */
    historySize: 6,
    /** Texto del cartel inferior (marquesina). */
    ticker: 'Bienvenido. Por favor, aguarde a ser llamado. Tenga su documento a mano.',
  },

  /** Tótem */
  totem: {
    /** Segundos que se muestra el ticket emitido antes de volver al inicio. */
    resetSeconds: 10,
    customerIdentifierLabel: 'DNI, teléfono o nombre',
  },

  /** Reglas operativas para citas web. */
  appointments: {
    openingTime: '08:00',
    closingTime: '16:00',
    /** Duración de cada franja horaria agendable (minutos). */
    slotMinutes: 15,
    /** Días hábiles: 0=Domingo … 6=Sábado */
    workingDays: [1, 2, 3, 4, 5],
    /** Máximo de días hacia adelante para agendar. */
    maxDaysAhead: 30,
    /** Minutos de tolerancia antes de la cita para hacer check-in en el tótem. */
    checkInEarlyMinutes: 30,
  },
};
