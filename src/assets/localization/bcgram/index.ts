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
  hi: { langCode: 'hi', name: 'Hindi', nativeName: 'हिन्दी', pluralCode: 'hi' },
  my: { langCode: 'my', name: 'Burmese', nativeName: 'မြန်မာ', pluralCode: 'my' },
  ne: { langCode: 'ne', name: 'Nepali', nativeName: 'नेपाली', pluralCode: 'ne' },
  tl: { langCode: 'tl', name: 'Tagalog', nativeName: 'Tagalog', pluralCode: 'tl' },
  th: { langCode: 'th', name: 'Thai', nativeName: 'ไทย', pluralCode: 'th' },
  ja: { langCode: 'ja', name: 'Japanese', nativeName: '日本語', pluralCode: 'ja' },
  vi: { langCode: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt', pluralCode: 'vi' },
  km: { langCode: 'km', name: 'Khmer', nativeName: 'ខ្មែរ', pluralCode: 'km' },
  ky: { langCode: 'ky', name: 'Kyrgyz', nativeName: 'Кыргызча', pluralCode: 'ky' },
  lo: { langCode: 'lo', name: 'Lao', nativeName: 'ລາວ', pluralCode: 'lo' },
  mn: { langCode: 'mn', name: 'Mongolian', nativeName: 'Монгол', pluralCode: 'mn' },
  si: { langCode: 'si', name: 'Sinhala', nativeName: 'සිංහල', pluralCode: 'si' },
  ta: { langCode: 'ta', name: 'Tamil', nativeName: 'தமிழ்', pluralCode: 'ta' },
  ur: { langCode: 'ur', name: 'Urdu', nativeName: 'اردو', pluralCode: 'ur' },
  uz: { langCode: 'uz', name: 'Uzbek', nativeName: 'Oʻzbekcha', pluralCode: 'uz' },
};

const LOADERS: Record<string, () => Promise<{ default: string }>> = {
  bn: () => import('./bn.strings?raw'),
  hi: () => import('./hi.strings?raw'),
  my: () => import('./my.strings?raw'),
  ne: () => import('./ne.strings?raw'),
  tl: () => import('./tl.strings?raw'),
  th: () => import('./th.strings?raw'),
  ja: () => import('./ja.strings?raw'),
  vi: () => import('./vi.strings?raw'),
  km: () => import('./km.strings?raw'),
  ky: () => import('./ky.strings?raw'),
  lo: () => import('./lo.strings?raw'),
  mn: () => import('./mn.strings?raw'),
  si: () => import('./si.strings?raw'),
  ta: () => import('./ta.strings?raw'),
  ur: () => import('./ur.strings?raw'),
  uz: () => import('./uz.strings?raw'),
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
