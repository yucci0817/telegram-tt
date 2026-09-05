import type { CachedLangData } from '../../../api/types';

import { buildStringsPack, type LocalLangMeta } from '../../../util/data/readFallbackStrings';

/**
 * BCGram: languages that Telegram's servers do not carry.
 *
 * Telegram has no language pack of its own for these, so BridgeCore ships one with the build.
 * The list is merged into the language list *behind* whatever the server returns, so if Telegram
 * ever publishes one of these, the server's pack wins and ours quietly stops being used.
 *
 * `pluralCode` picks the plural rules. Where a language has no distinct plural forms in the
 * source strings, 'en' rules are correct enough - the translated values read the same either way.
 */
export const BCGRAM_LANGUAGES: Record<string, LocalLangMeta> = {
  bn: { langCode: 'bn', name: 'Bengali', nativeName: 'বাংলা', pluralCode: 'bn' },
  ne: { langCode: 'ne', name: 'Nepali', nativeName: 'नेपाली', pluralCode: 'ne' },
  vi: { langCode: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt', pluralCode: 'vi' },
};

const LOADERS: Record<string, () => Promise<{ default: string }>> = {
  bn: () => import('./bn.strings?raw'),
  ne: () => import('./ne.strings?raw'),
  vi: () => import('./vi.strings?raw'),
};

export function isBcgramLanguage(langCode: string): boolean {
  return langCode in BCGRAM_LANGUAGES;
}

export function getBcgramLanguages(): LocalLangMeta[] {
  return Object.values(BCGRAM_LANGUAGES);
}

/** Reads the bundled .strings for one of our languages. Returns undefined for anything else. */
export async function loadBcgramLangData(langCode: string): Promise<CachedLangData | undefined> {
  const meta = BCGRAM_LANGUAGES[langCode];
  const loader = LOADERS[langCode];
  if (!meta || !loader) return undefined;

  const file = await loader();
  return buildStringsPack(file.default, meta);
}
