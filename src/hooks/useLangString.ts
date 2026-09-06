import { useEffect, useState } from '../lib/teact/teact';

import type { RegularLangKey } from '../types/language';

import { LANG_PACK } from '../config';
import { callApi } from '../api/gramjs';
import useLastCallback from './useLastCallback';

import { isBcgramLanguage, loadBcgramLangData } from '../assets/localization/bcgram';

export default function useLangString(key: RegularLangKey, langCode?: string) {
  const [value, setValue] = useState<string | undefined>(undefined);

  const fetchLangString = useLastCallback(async () => {
    if (!langCode) return undefined;

    // BCGram: Telegram's servers hold no pack for the languages we ship, so asking them returns
    // nothing. Read the bundled pack instead - this runs before login, where it is the only source.
    if (isBcgramLanguage(langCode)) {
      const localData = await loadBcgramLangData(langCode);
      const localString = localData?.langPack.strings[key];
      return typeof localString === 'string' ? localString : undefined;
    }

    const result = await callApi('fetchLangStrings', {
      langCode,
      langPack: LANG_PACK,
      keys: [key],
    });
    const langString = result?.strings[key];
    if (!langString || typeof langString !== 'string') return undefined;
    return langString;
  });

  useEffect(() => {
    fetchLangString().then(setValue);
  }, [key, langCode]);

  return value;
}
