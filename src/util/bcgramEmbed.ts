// BCGram C7-e (fork 1st stage) — bridge between this embedded conversation view and the parent
// window (BridgeCore). Only ever does anything when the document was flagged `embed-chat` by
// `index.tsx` (i.e. it was opened with `?embed=chat`) AND it is actually running inside an iframe.
// Two jobs, both gated the same way:
//   1) send the chat list to the parent (postMessage) so BridgeCore can render it in its own panel;
//   2) accept `bcgram:openChat` from the parent and open that chat here.
// See: 指示書/AP/2026-09-07_BCGram_弾C7-e第1段_embed-chatと一覧の受け渡し_実装指示書.md §3-3/§3-4.

import type { ApiPeer } from '../api/types';
import type { GlobalState } from '../global/types';

import { MAIN_THREAD_ID } from '../api/types';
import { getActions, getGlobal } from '../global';
import { getMainUsername } from '../global/helpers/users';
import { getMessageSummaryText } from '../global/helpers/messageSummary';
import { getPeerFullTitle } from '../global/helpers/peers';
import { selectChatLastMessage, selectPeer } from '../global/selectors';
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

function setupReceiver() {
  window.addEventListener('message', (event: MessageEvent) => {
    // Defense in depth: both the sender's origin and the window it actually came from must check out.
    if (!ALLOWED_PARENT_ORIGINS.includes(event.origin)) return;
    if (event.source !== window.parent) return;
    if (!isBcgramOpenChatMessage(event.data)) return;

    getActions().openChat({ id: String(event.data.chatId) });
  });
}

export function initBcgramEmbedBridge() {
  if (!document.documentElement.classList.contains('embed-chat')) return;
  if (window.parent === window) return;

  const parentOrigin = getAllowedParentOrigin();
  if (!parentOrigin) return;

  setupSender(parentOrigin);
  setupReceiver();
}
