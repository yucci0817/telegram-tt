// BCGram C7-e (fork 1st stage, extended by C7-e-fix) — bridge between this embedded conversation
// view and the parent window (BridgeCore). Only ever does anything when the document was flagged
// `embed-chat` by `index.tsx` (i.e. it was opened with `?embed=chat`) AND it is actually running
// inside an iframe. Jobs, all gated the same way:
//   1) send the chat list to the parent (postMessage) so BridgeCore can render it in its own panel;
//   2) tell the parent once this page's receiver is actually listening (`bcgram:ready`), so the
//      parent can resend an `openChat` it fired before this page was ready to hear it;
//   3) accept `bcgram:openChat` from the parent and open that chat here — by username
//      (server-resolved) when the parent supplies one, otherwise by the local numeric id;
//   4) report back `bcgram:openChatFailed` when neither path actually resolves a chat, instead of
//      leaving the parent's view spinning forever;
//   5) accept `bcgram:toggleLeftColumn` from the parent and toggle this page's own left column.
// See: 指示書/AP/2026-09-07_BCGram_弾C7-e第1段_embed-chatと一覧の受け渡し_実装指示書.md §3-3/§3-4
// and 指示書/AP/2026-09-07_Chat_弾C7-e-fix_開かない原因と左列の復活_実装指示書.md §2.

import type { ApiPeer } from '../api/types';
import type { GlobalState } from '../global/types';

import { MAIN_THREAD_ID } from '../api/types';
import { getActions, getGlobal } from '../global';
import { getMainUsername } from '../global/helpers/users';
import { getMessageSummaryText } from '../global/helpers/messageSummary';
import { getPeerFullTitle } from '../global/helpers/peers';
import { selectChat, selectChatLastMessage, selectPeer } from '../global/selectors';
import { selectThreadReadState } from '../global/selectors/threads';
import { ALL_FOLDER_ID } from '../config';
import { addCallback } from '../lib/teact/teactn';
import { getOrderedIds } from './folderManager';
import { getTranslationFn } from './localization';
import { throttle } from './schedulers';

// Only these two origins may exchange messages with this page. Never widen this with '*'.
const ALLOWED_PARENT_ORIGINS = [
  'https://bridgecore-gray.vercel.app',
  'http://localhost:3000',
];

const MAX_ITEMS = 200;
const SEND_THROTTLE_MS = 2000;
// C7-e-fix §2-2: how long to wait after an openChat/openChatByUsername attempt before deciding it
// failed. Both actions are effectively synchronous for a chat already known locally (the common
// case here — the parent only ever asks for chats it already showed in the list or resolved from
// chat_contacts), so this is generous headroom, not a real network round trip budget.
const OPEN_CHAT_FAILURE_CHECK_MS = 3000;

interface BcgramChatListItem {
  chatId: string;
  title: string;
  unreadCount: number;
  lastMessage?: string;
  lastMessageDate?: number;
  username?: string;
}

interface BcgramChatListMessage {
  type: 'bcgram:chatList';
  items: BcgramChatListItem[];
  truncated: boolean;
}

interface BcgramOpenChatMessage {
  type: 'bcgram:openChat';
  chatId: string | number;
  username?: string;
}

interface BcgramToggleLeftColumnMessage {
  type: 'bcgram:toggleLeftColumn';
}

let lastSentSignature: string | undefined;

function getAllowedParentOrigin(): string | undefined {
  let origin: string | undefined;

  if (document.referrer) {
    try {
      origin = new URL(document.referrer).origin;
    } catch {
      origin = undefined;
    }
  }

  if (!origin) {
    const ancestorOrigins = window.location.ancestorOrigins;
    if (ancestorOrigins && ancestorOrigins.length > 0) {
      origin = ancestorOrigins[0];
    }
  }

  return origin && ALLOWED_PARENT_ORIGINS.includes(origin) ? origin : undefined;
}

function buildChatListItem(global: GlobalState, chatId: string): BcgramChatListItem | undefined {
  const peer: ApiPeer | undefined = selectPeer(global, chatId);
  if (!peer) return undefined;

  const lang = getTranslationFn();
  const title = getPeerFullTitle(lang, peer) || chatId;
  const unreadCount = selectThreadReadState(global, chatId, MAIN_THREAD_ID)?.unreadCount || 0;
  const username = getMainUsername(peer);

  const lastMessage = selectChatLastMessage(global, chatId);
  const lastMessageSummary = lastMessage
    ? getMessageSummaryText(lang, lastMessage, undefined)
    : undefined;

  return {
    chatId,
    title,
    unreadCount,
    ...(lastMessageSummary && { lastMessage: lastMessageSummary }),
    ...(lastMessage && { lastMessageDate: lastMessage.date }),
    ...(username && { username }),
  };
}

function buildChatListMessage(global: GlobalState): BcgramChatListMessage {
  const orderedIds = getOrderedIds(ALL_FOLDER_ID) || [];
  const truncated = orderedIds.length > MAX_ITEMS;
  const items: BcgramChatListItem[] = [];

  for (const chatId of orderedIds.slice(0, MAX_ITEMS)) {
    const item = buildChatListItem(global, chatId);
    if (item) items.push(item);
  }

  return { type: 'bcgram:chatList', items, truncated };
}

function sendChatList(global: GlobalState, parentOrigin: string) {
  const message = buildChatListMessage(global);

  // Cheap dedup: skip the postMessage entirely when nothing actually changed since last send.
  const signature = JSON.stringify(message);
  if (signature === lastSentSignature) return;
  lastSentSignature = signature;

  window.parent.postMessage(message, parentOrigin);
}

function setupSender(parentOrigin: string) {
  const sendThrottled = throttle(
    (global: GlobalState) => sendChatList(global, parentOrigin),
    SEND_THROTTLE_MS,
    true,
  );

  addCallback(sendThrottled);
  // Send once immediately so the parent doesn't wait for the next global-state change.
  sendThrottled(getGlobal());
}

function isBcgramOpenChatMessage(data: unknown): data is BcgramOpenChatMessage {
  return Boolean(
    data
    && typeof data === 'object'
    && (data as { type?: unknown }).type === 'bcgram:openChat'
    && 'chatId' in (data as object),
  );
}

function isBcgramToggleLeftColumnMessage(data: unknown): data is BcgramToggleLeftColumnMessage {
  return Boolean(
    data
    && typeof data === 'object'
    && (data as { type?: unknown }).type === 'bcgram:toggleLeftColumn',
  );
}

// C7-e-fix §2-2: after asking to open a chat (by id or by username), check back once whether it
// actually resolved. `selectChat` is exactly what MessageList.tsx keys its "known chat" render
// path on (see 実装指示書 §1-2), so this mirrors what the user would actually see.
function scheduleOpenChatFailureCheck(chatId: string, parentOrigin: string) {
  window.setTimeout(() => {
    if (!selectChat(getGlobal(), chatId)) {
      window.parent.postMessage({ type: 'bcgram:openChatFailed', chatId }, parentOrigin);
    }
  }, OPEN_CHAT_FAILURE_CHECK_MS);
}

function setupReceiver(parentOrigin: string) {
  window.addEventListener('message', (event: MessageEvent) => {
    // Defense in depth: both the sender's origin and the window it actually came from must check out.
    if (!ALLOWED_PARENT_ORIGINS.includes(event.origin)) return;
    if (event.source !== window.parent) return;

    const { data } = event;

    if (isBcgramOpenChatMessage(data)) {
      const chatId = String(data.chatId);
      // C7-e-fix §2-2: a username lets Telegram resolve the chat server-side (access_hash), which
      // a raw numeric id cannot do unless the chat is already known locally. Prefer it whenever the
      // parent has one; otherwise fall back to the id-only path exactly as before.
      if (data.username) {
        getActions().openChatByUsername({ username: data.username });
      } else {
        getActions().openChat({ id: chatId });
      }
      scheduleOpenChatFailureCheck(chatId, parentOrigin);
      return;
    }

    if (isBcgramToggleLeftColumnMessage(data)) {
      getActions().toggleLeftColumn();
    }
  });
}

export function initBcgramEmbedBridge() {
  if (!document.documentElement.classList.contains('embed-chat')) return;
  if (window.parent === window) return;

  const parentOrigin = getAllowedParentOrigin();
  if (!parentOrigin) return;

  setupSender(parentOrigin);
  setupReceiver(parentOrigin);
  // C7-e-fix §2-1: tell the parent this page's receiver is actually listening now, so it can
  // (re)send the chat it wants opened — including on a reload, when this fires again from scratch.
  window.parent.postMessage({ type: 'bcgram:ready' }, parentOrigin);
}
