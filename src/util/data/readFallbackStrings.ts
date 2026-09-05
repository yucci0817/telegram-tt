import type {
  ApiLanguage, CachedLangData, LangPack, LangPackStringValuePlural,
} from '../../api/types';

import readStrings from './readStrings';

const FALLBACK_LANG_CODE = 'en';
const FALLBACK_TRANSLATE_URL = `https://translations.telegram.org/${FALLBACK_LANG_CODE}/weba`;

/** BCGram: the identity of a language pack that ships with the build instead of coming from the server. */
export type LocalLangMeta = {
  langCode: string;
  name: string;
  nativeName: string;
  pluralCode: string;
  translationsUrl?: string;
};

const EN_META: LocalLangMeta = {
  langCode: FALLBACK_LANG_CODE,
  name: 'English',
  nativeName: 'English',
  pluralCode: FALLBACK_LANG_CODE,
  translationsUrl: FALLBACK_TRANSLATE_URL,
};

/**
 * BCGram: the version of a bundled pack is derived from the file itself.
 *
 * `initLocalization` prefers whatever is already cached in IndexedDB under `langpack-<code>`,
 * so a pack whose version never moves would keep serving the old strings after the .strings file
 * is replaced. Hashing the file means editing one line changes the version and the cache turns over.
 */
function versionFromContent(fileData: string): number {
  let hash = 0;
  for (let i = 0; i < fileData.length; i++) {
    hash = (Math.imul(hash, 31) + fileData.charCodeAt(i)) | 0;
  }
  return hash & 0x7FFFFFFF;
}

export default async function readFallbackStrings(): Promise<CachedLangData> {
  const file = await import('../../assets/localization/fallback.strings?raw');
  return buildFallbackStrings(file.default);
}

export function buildFallbackStrings(fileData: string): CachedLangData {
  return buildStringsPack(fileData, EN_META);
}

/** Turns an Apple .strings file into a langpack. Used for the English fallback and for BCGram's own packs. */
export function buildStringsPack(fileData: string, meta: LocalLangMeta): CachedLangData {
  const rawStrings = readStrings(fileData);

  const strings: LangPack['strings'] = {};

  Object.entries(rawStrings).forEach(([key, value]) => {
    const [clearKey, pluralSuffix] = key.split('_');

    if (!pluralSuffix) {
      strings[clearKey] = value;
      return;
    }

    const knownValue = (strings[clearKey] || {}) as LangPackStringValuePlural;
    knownValue[pluralSuffix as keyof LangPackStringValuePlural] = value;
    strings[clearKey] = knownValue;
  });

  const langPack: LangPack = {
    langCode: meta.langCode,
    version: versionFromContent(fileData),
    strings,
  };

  const stringsCount = Object.keys(strings).length;

  const language: ApiLanguage = {
    langCode: meta.langCode,
    name: meta.name,
    nativeName: meta.nativeName,
    pluralCode: meta.pluralCode,
    stringsCount,
    translatedCount: stringsCount,
    translationsUrl: meta.translationsUrl
      || `https://translations.telegram.org/${meta.langCode}/weba`,
  };

  return {
    langPack,
    language,
  };
}
