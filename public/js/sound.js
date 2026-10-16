/**
 * Aviso sonoro + voz para la pantalla de sala.
 * - Reproduce el archivo de marca (brand.assets.callSound).
 * - Si el archivo no existe o falla, genera un "ding-dong" con Web Audio.
 * - Luego anuncia el turno con la Web Speech API.
 */
let ctx;
let audioEl;
let fileOk = null; // null = no probado

export function unlockAudio(soundUrl) {
  ctx ??= new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  if (!audioEl && soundUrl) {
    audioEl = new Audio(soundUrl);
    audioEl.preload = 'auto';
    audioEl.addEventListener('canplaythrough', () => (fileOk = true), { once: true });
    audioEl.addEventListener('error', () => (fileOk = false), { once: true });
  }
  // "Despierta" el motor de voz con un enunciado vacío (requisito de algunos navegadores)
  if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(''));
}

function syntheticDingDong() {
  if (!ctx) return Promise.resolve();
  const tone = (freq, start, dur) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
    gain.gain.exponentialRampToValueAtTime(0.5, ctx.currentTime + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime + start);
    osc.stop(ctx.currentTime + start + dur + 0.05);
  };
  tone(880, 0, 0.9);    // ding
  tone(698.5, 0.45, 1.3); // dong
  return new Promise((r) => setTimeout(r, 1700));
}

function playChime() {
  if (audioEl && fileOk !== false) {
    audioEl.currentTime = 0;
    return audioEl
      .play()
      .then(() => new Promise((r) => {
        audioEl.onended = r;
        setTimeout(r, 4000); // por si "ended" no llega
      }))
      .catch(() => {
        fileOk = false;
        return syntheticDingDong();
      });
  }
  return syntheticDingDong();
}

/** Convierte "A-024" en "A, 24" para que la voz lo lea natural. */
const speakableCode = (code) => {
  const [prefix, num] = code.split('-');
  return `${prefix.split('').join(' ')}, ${Number(num)}`;
};

function speak(text, lang) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = 0.92;
  const voice = speechSynthesis.getVoices().find((v) => v.lang?.startsWith(lang.split('-')[0]));
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}

/** Cola de anuncios: si llegan dos llamados juntos, se anuncian en orden. */
let chain = Promise.resolve();
export function announce(ticket, brand) {
  chain = chain.then(async () => {
    await playChime();
    if (brand.display.voiceEnabled) {
      const text = brand.display.voiceTemplate
        .replace('{code}', speakableCode(ticket.code))
        .replace('{desk}', ticket.desk?.identifier ?? '')
        .replace('{category}', ticket.category?.name ?? '');
      speak(text, brand.display.voiceLang);
      await new Promise((r) => setTimeout(r, 3500));
    }
  });
  return chain;
}
