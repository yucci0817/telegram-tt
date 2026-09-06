import './util/handleError';
import './util/setupServiceWorker';
import './global/init';

import TeactDOM from './lib/teact/teact-dom';
import {
  getActions, getGlobal, setGlobal,
} from './global';

import {
  DEBUG, STRICTERDOM_ENABLED,
} from './config';
import { isBcgramLanguage } from './assets/localization/bcgram';
import { enableStrict, requestMutation } from './lib/fasterdom/fasterdom';
import { selectChat, selectCurrentMessageList, selectPeerFullInfo, selectTabState } from './global/selectors';
import { selectSharedSettings } from './global/selectors/sharedState';
import { updateSharedSettings } from './global/reducers';
import { betterView } from './util/betterView';
import { initBcgramEmbedBridge } from './util/bcgramEmbed';
import { IS_TAURI } from './util/browser/globalEnvironment';
import listenOtherClients from './util/browser/listenOtherClients';
import { requestGlobal, subscribeToMultitabBroadcastChannel } from './util/browser/multitab';
import { establishMultitabRole, subscribeToMasterChange } from './util/establishMultitabRole';
import { initGlobal } from './util/init';
import { initLocalization } from './util/localization';
import { MULTITAB_STORAGE_KEY } from './util/multiaccount';
import { checkAndAssignPermanentWebVersion } from './util/permanentWebVersion';
import { onBeforeUnload } from './util/schedulers';
import initTauriApi from './util/tauri/initTauriApi';
import setupTauriListeners from './util/tauri/setupTauriListeners';
import updateWebmanifest from './util/updateWebmanifest';

import App from './components/App';

import './assets/fonts/roboto.css';
import './styles/index.scss';

if (STRICTERDOM_ENABLED) {
  enableStrict();
}

if (IS_TAURI) {
  initTauriApi();
  setupTauriListeners();
}

init();

async function init() {
  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('>>> INIT');
  }

  if (!(window as any).isCompatTestPassed) return;

  checkAndAssignPermanentWebVersion();
  listenOtherClients();

  subscribeToMultitabBroadcastChannel();
  await requestGlobal(APP_VERSION);
  localStorage.setItem(MULTITAB_STORAGE_KEY, '1');
  onBeforeUnload(() => {
    const global = getGlobal();
    if (Object.keys(global.byTabId).length === 1) {
      localStorage.removeItem(MULTITAB_STORAGE_KEY);
    }
  });

  await initGlobal();

  // BCGram BCG-2: decide the boot language here — after `setGlobal` in `initGlobal` (util/init.ts:44) has
  // loaded the cached shared state, and before `getActions().init()` below starts the SharedWorker
  // (`initSharedState`, global/init.ts:58), whose `fullState` reply replaces the whole shared state and
  // would erase anything written after it. `initLocalization` (further down) reads the value from here.
  // Priority: the user's saved choice (`wasLanguageSetManually`) always wins; otherwise a valid `?hl=`
  // (BCGram's own 8 packs or an officially known code); otherwise `ja`. An unknown `?hl=` is ignored, not thrown.
  {
    const bootGlobal = getGlobal();
    if (!selectSharedSettings(bootGlobal).wasLanguageSetManually) {
      // Kept in sync with the `LangCode` union (types/index.ts:142) — Telegram's officially bundled codes.
      const OFFICIAL_LANG_CODES = new Set([
        'en', 'ar', 'be', 'ca', 'nl', 'fr', 'de', 'id', 'it', 'ko', 'ms', 'fa', 'pl', 'pt-br', 'ru', 'es', 'tr', 'uk', 'uz',
      ]);
      const hl = new URLSearchParams(window.location.search).get('hl')?.toLowerCase();
      const language = hl && (isBcgramLanguage(hl) || OFFICIAL_LANG_CODES.has(hl)) ? hl : 'ja';

      setGlobal(updateSharedSettings(bootGlobal, { language }));
    }
  }

  // BCGram C7-e (fork 1st stage): flag the document when opened as `?embed=chat` so CSS
  // (Main.scss) can hide the chat-list column and `util/bcgramEmbed.ts` knows to bridge the
  // chat list / openChat with the parent window. Kept OUTSIDE the `wasLanguageSetManually`
  // block above — inside it, a user who already set their language manually would never get
  // the flag. Kept on the DOM (not global state): this is a per-document display switch, and
  // global state would propagate it to other tabs via the SharedWorker.
  if (new URLSearchParams(window.location.search).get('embed') === 'chat') {
    document.documentElement.classList.add('embed-chat');
  }

  getActions().init();

  getActions().updateShouldEnableDebugLog();
  getActions().updateShouldDebugExportedSenders();

  const global = getGlobal();

  initLocalization(selectSharedSettings(global).language, true);

  // BCGram C7-e (fork 1st stage): no-ops unless the `embed-chat` flag above is set AND this
  // page is actually running inside an iframe (see util/bcgramEmbed.ts for the guard).
  initBcgramEmbedBridge();

  subscribeToMasterChange((isMasterTab) => {
    getActions()
      .switchMultitabRole({ isMasterTab }, { forceSyncOnIOs: true });
  });
  const shouldReestablishMasterToSelf = getGlobal().auth.state !== 'authorizationStateReady';
  establishMultitabRole(shouldReestablishMasterToSelf);

  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('>>> START INITIAL RENDER');
  }

  requestMutation(() => {
    updateWebmanifest();

    TeactDOM.render(
      <App />,
      document.getElementById('root')!,
    );

    betterView();
  });

  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('>>> FINISH INITIAL RENDER');
  }

  if (DEBUG) {
    document.addEventListener('dblclick', () => {
      const currentGlobal = getGlobal();
      const currentMessageList = selectCurrentMessageList(currentGlobal);
      // eslint-disable-next-line no-console
      console.warn('TAB STATE', selectTabState(currentGlobal));
      // eslint-disable-next-line no-console
      console.warn('GLOBAL STATE', currentGlobal);
      if (currentMessageList) {
        // eslint-disable-next-line no-console
        console.warn(
          'CURRENT MESSAGE LIST',
          selectChat(currentGlobal, currentMessageList.chatId),
          selectPeerFullInfo(currentGlobal, currentMessageList.chatId),
          currentGlobal.messages.byChatId[currentMessageList.chatId],
        );
      }
    });
  }
}

onBeforeUnload(() => {
  const actions = getActions();
  actions.leaveGroupCall?.({ isPageUnload: true });
  actions.hangUp?.({ isPageUnload: true });
});
