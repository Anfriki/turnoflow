import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface BrandConfig {
  companyName: string;
  tagline: string;
  locale: string;
  assets: { logo: string; favicon: string; callSound: string };
  colors: Record<string, string>;
  fontFamily: string;
  borderRadius: string;
  display: {
    voiceEnabled: boolean;
    voiceTemplate: string;
    voiceLang: string;
    historySize: number;
    ticker: string;
  };
  totem: { resetSeconds: number; customerIdentifierLabel: string };
  appointments: {
    openingTime: string;
    closingTime: string;
    slotMinutes: number;
    workingDays: number[];
    maxDaysAhead: number;
    checkInEarlyMinutes: number;
  };
}

let brand: BrandConfig;

/** Carga brand.config.js desde la raíz del proyecto y aplica overrides del .env. */
export async function loadBrand(): Promise<BrandConfig> {
  const file = pathToFileURL(path.resolve(process.cwd(), 'brand.config.js')).href;
  const mod = (await import(file)) as { default: BrandConfig };
  brand = structuredClone(mod.default);

  const e = process.env;
  if (e.COMPANY_NAME) brand.companyName = e.COMPANY_NAME;
  if (e.COMPANY_TAGLINE) brand.tagline = e.COMPANY_TAGLINE;
  if (e.BRAND_PRIMARY_COLOR) brand.colors.primary = e.BRAND_PRIMARY_COLOR;
  if (e.BRAND_SECONDARY_COLOR) brand.colors.secondary = e.BRAND_SECONDARY_COLOR;
  return brand;
}

export function getBrand(): BrandConfig {
  if (!brand) throw new Error('Brand config no cargada: llamá a loadBrand() al iniciar');
  return brand;
}

/** camelCase → kebab-case para nombres de tokens CSS. */
const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

/** Genera la hoja /brand.css con los tokens de color de la marca. */
export function brandCss(b: BrandConfig): string {
  const vars = Object.entries(b.colors)
    .map(([k, v]) => `  --brand-${kebab(k)}: ${v};`)
    .join('\n');
  return `/* Generado desde brand.config.js — no editar a mano */
:root {
${vars}
  --brand-font: ${b.fontFamily};
  --brand-radius: ${b.borderRadius};
}
`;
}
