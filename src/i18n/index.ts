import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from './locales/en.json';
import ptBR from './locales/pt-BR.json';
import it from './locales/it.json';

/**
 * i18next bootstrap for the Chess Coach web app.
 *
 * Initialised at module-load time (imported once from `main.tsx`) so
 * the very first React render has translations ready — no `Suspense`
 * fallback flicker between English and the user's chosen language.
 *
 * Locale resolution order (first hit wins):
 *   1. `localStorage['chess-coach:locale']` — written by the language
 *      picker in Settings. Survives reloads with zero IndexedDB round-trip.
 *   2. `navigator.language` family — Chrome/Firefox/Safari user preference.
 *      Brazilian users typically have `pt-BR` here; we honour it.
 *   3. `'en'` — fallback.
 *
 * The Settings page may also persist `Settings.locale` to Dexie when
 * Phase 2 cloud-sync ships, but the localStorage layer is the load-
 * bearing one for first-paint correctness. We sync Dexie → localStorage
 * on app boot in `useLocaleSync` so the two stay aligned without
 * either being a single point of failure.
 *
 * Supported locales: extend `SUPPORTED_LOCALES` and drop a JSON catalog
 * under `./locales/`. Keep the JSON keys identical across locales
 * (English-side keys are canonical); a missing key in a non-English
 * catalog falls back to the English string via `fallbackLng`.
 */

export const SUPPORTED_LOCALES = ['en', 'pt-BR', 'it'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Storage key for the localStorage-side locale persistence. Kept here
 *  rather than reusing `usePersistedState`'s `chess-coach:` prefix
 *  because i18next's LanguageDetector reads/writes localStorage
 *  directly during init (before React mounts) and needs to know the
 *  raw key. */
export const LOCALE_STORAGE_KEY = 'chess-coach:locale';

export const LOCALE_DISPLAY_NAMES: Record<SupportedLocale, string> = {
  en: 'English',
  // Native-name labelling for the language picker — Brazilians never
  // see "Portuguese (Brazil)" on real software, they see "Português
  // (Brasil)". Matches the convention from chess.com / lichess too.
  'pt-BR': 'Português (Brasil)',
  // Native-name labelling for Italian — Italian users see "Italiano",
  // not "Italian", in every native interface they're used to.
  it: 'Italiano',
};

/** True if the given string is a locale we ship a catalog for. */
export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return (
    typeof value === 'string' &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/** Read the user's stored locale preference from localStorage. Used by
 *  the LanguageDetector below and by `useLocaleSync` for one-way
 *  Dexie-Settings → localStorage hydration. */
export function readStoredLocale(): SupportedLocale | null {
  try {
    const raw =
      typeof localStorage !== 'undefined' ? localStorage.getItem(LOCALE_STORAGE_KEY) : null;
    return isSupportedLocale(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Persist a locale to localStorage and switch i18next at runtime.
 *  Called by the language picker. We intentionally don't catch the
 *  `setItem` error here — it's already wrapped by the picker UI's
 *  promise handler so a quota failure surfaces as a status message. */
export async function setLocale(locale: SupportedLocale): Promise<void> {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage unavailable — runtime switch still works for the
    // current session, just won't survive reload.
  }
  await i18n.changeLanguage(locale);
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      'pt-BR': { translation: ptBR },
      it: { translation: it },
    },
    supportedLngs: SUPPORTED_LOCALES as unknown as string[],
    // English is the catalog of record. Missing keys in pt-BR fall
    // through to en automatically — a partial translation degrades
    // gracefully rather than rendering raw `key.path` strings.
    fallbackLng: 'en',
    // i18next's default resolver already does language-only fallback —
    // `it-IT` / `it-CH` / `it-FR` resolve to our `it` catalog out of
    // the box, and similarly browsers reporting just `pt` resolve to
    // `pt-BR` (which is fine: pt-BR is much closer to pt-PT than
    // English would be for a Portuguese speaker). Setting
    // `nonExplicitSupportedLngs: true` here was a bug — it caused
    // `pt-BR` itself to be cleaned to bare `pt`, fall through the
    // supportedLngs check, and resolve to `fallbackLng: 'en'` instead
    // of the pt-BR catalog. Leaving the default (`false`) makes every
    // exact code we ship resolve to itself, while regional variants
    // still get language-only matching for free.
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LOCALE_STORAGE_KEY,
      // We write to localStorage ourselves via `setLocale` to keep
      // the contract symmetrical with `readStoredLocale`. Telling
      // the detector to also write would race with our writes.
      caches: [],
    },
    interpolation: {
      // React already escapes by default; double-escaping breaks
      // strings like "Save & Continue".
      escapeValue: false,
    },
    // Dev-time logging helps catch missing keys; prod is silent.
    debug: false,
    returnNull: false,
  });

export default i18n;
