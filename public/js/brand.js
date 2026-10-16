/**
 * Aplica la marca (nombre, eslogan, logo, favicon) servida por /api/brand.
 * Los colores llegan aparte como variables CSS desde /brand.css.
 */
let brandPromise;

export function loadBrand() {
  brandPromise ??= fetch('/api/brand').then((r) => r.json());
  return brandPromise;
}

export async function applyBrand(viewTitle) {
  const brand = await loadBrand();
  document.title = viewTitle ? `${viewTitle} · ${brand.companyName}` : brand.companyName;
  document.documentElement.lang = brand.locale?.split('-')[0] ?? 'es';

  let icon = document.querySelector('link[rel="icon"]');
  if (!icon) {
    icon = document.createElement('link');
    icon.rel = 'icon';
    document.head.append(icon);
  }
  icon.href = brand.assets.favicon;

  for (const el of document.querySelectorAll('[data-brand="company"]')) el.textContent = brand.companyName;
  for (const el of document.querySelectorAll('[data-brand="tagline"]')) el.textContent = brand.tagline;
  for (const img of document.querySelectorAll('img[data-brand="logo"]')) {
    img.src = brand.assets.logo;
    img.alt = brand.companyName;
    img.onerror = () => (img.hidden = true);
  }
  return brand;
}
