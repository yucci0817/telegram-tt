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
//   5) accept `bcgram:toggleLeftColumn` from the parent and toggle this page's own left column;
//   6) accept `bcgram:startCall` from the parent and start a call (voice, or video when asked) with
//      that chat's user via `requestMasterAndRequestCall`. When the parent sends no `chatId`, use
//      whatever chat is currently open here (CM-10a: "the call target is whoever BCGram has open").
//      Report back `bcgram:startCallFailed` with a `reason` — `no_chat` (nothing open, no chatId),
//      `self` (target is the signed-in account itself), or `user_not_found` (not a resolvable user) —
//      instead of staying silent.
// See: 指示書/AP/2026-09-07_BCGram_弾C7-e第1段_embed-chatと一覧の受け渡し_実装指示書.md §3-3/§3-4
// and 指示書/AP/2026-09-07_Chat_弾C7-e-fix_開かない原因と左列の復活_実装指示書.md §2.
// and 指示書/AP/2026-09-12_CM-6b_Telegramドアの通話_実装指示書.md §2-1 (job 6, bcgram:startCall).
// and 指示書/AP/2026-09-13_CM-10a_通話は開いている相手に_黙らない_実装指示書.md §2 段A.
//   7) send `bcgram:authState { loggedIn }` once right after `bcgram:ready`, then again whenever
//      `auth.state` changes (dedup so the same value isn't sent twice in a row) — lets the parent
//      know whether it can route a call through BCGram or must ask the operator to sign in first.
// and 指示書/AP/2026-09-13_CM-8_Chatの既定をBCGramにする_実装指示書.md §2-4.

import type { ApiPeer } from '../api/types';
import type { GlobalState } from '../global/types';

import { MAIN_THREAD_ID } from '../api/types';
import { getActions, getGlobal } from '../global';
import { getMainUsername } from '../global/helpers/users';
import { getMessageSummaryText } from '../global/helpers/messageSummary';
import { getPeerFullTitle } from '../global/helpers/peers';
import {
  selectChat, selectChatFullInfo, selectChatLastMessage, selectCurrentMessageList, selectIsChatWithSelf,
  selectPeer, selectUser,
} from '../global/selectors';
import { selectThreadReadState } from '../global/selectors/threads';
import { ALL_FOLDER_ID } from '../config';
import { addCallback } from '../lib/teact/teactn';
import { isUserId } from './entities/ids';
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
// CM-15: creating a group is a real server round trip, so give it a real budget — but a bounded
// one, so a failure reports back instead of leaving the operator waiting on a button forever.
const ENSURE_GROUP_POLL_MS = 400;
const ENSURE_GROUP_MAX_TRIES = 25; // ≈10s
// 弾 CM-16: how long to wait for the new group's default invite link (same 400ms tick).
const INVITE_LINK_MAX_TRIES = 25; // ≈10s

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

// CM-6b §2-1: parent asks to start a call with this chat's user. `chatId` here is the same id
// space `bcgram:openChat` already uses; for a private chat that id IS the user id (see
// `requestMasterAndRequestCall({ userId: chatId })` at HeaderActions.tsx:216 for precedent).
// CM-10a §2 段A-1: `chatId` is now optional — when the parent omits it, the currently open chat
// (`selectCurrentMessageList`) is used instead.
interface BcgramStartCallMessage {
  type: 'bcgram:startCall';
  chatId?: string | number;
  video?: boolean;
}

// CM-8 §2-4: outgoing only (this page never receives this type back).
interface BcgramAuthStateMessage {
  type: 'bcgram:authState';
  loggedIn: boolean;
}

// CM-15 (CEO 2026-09-14): 3LINE is a dedicated Telegram GROUP per AP company, and the operator
// joins it with their own account. The open question was who creates that group — a Telegram BOT
// cannot create groups at all (API limitation), so a bot-driven flow is impossible. This page,
// however, runs as the operator's own account, so it can create the group itself: the operator
// becomes the creator (and therefore a member) without any manual step in the Telegram app.
//
// Creating a group is a real, visible side effect on a real account, so this is NEVER automatic —
// the parent only sends this after the operator explicitly asks for it.
interface BcgramEnsureGroupMessage {
  type: 'bcgram:ensureGroup';
  /** Group title, e.g. `3LINE / <company name>`. */
  title: string;
  /** Telegram user ids to add up front. May be empty — people can join by the invite link instead. */
  memberIds?: (string | number)[];
}

// CM-15: outgoing. The parent stores `chatId` so the group opens directly from then on.
// Inviting more people afterwards is done in Telegram itself — that is the whole point of
// 第0条 ("use it with the Telegram operations people already know"), so this page does not
// build a second invite mechanism on top.
interface BcgramGroupCreatedMessage {
  type: 'bcgram:groupCreated';
  chatId: string;
  /**
   * 弾 CM-16: the group's default invite link (`t.me/+<hash>`), when it is available in time.
   *
   * This is what the parent actually hands to each operator: an account that has NOT joined yet
   * cannot open the group by id at all (`openChat` only resolves chats this client already knows,
   * and a supergroup id is useless without a per-account `access_hash`). The link is the only
   * value that lets somebody else get in — so the parent stores it next to `chatId`.
   *
   * Absent when the link did not arrive within the budget. The group still exists in that case,
   * so this is NOT a failure — the parent can ask for the link again later.
   */
  inviteLink?: string;
}

// CM-15: outgoing. Sent instead of `groupCreated` when the group could not be made, so the parent
// can say so out loud rather than leaving the operator pressing a button that does nothing
// (the same rule as `startCallFailed` — never fail silently).
interface BcgramEnsureGroupFailedMessage {
  type: 'bcgram:ensureGroupFailed';
  reason: 'not_logged_in' | 'create_failed';
}

let lastSentSignature: string | undefined;
let lastSentAuthLoggedIn: boolean | undefined;

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

// CM-8 §2-4: tells the parent whether this page is signed in to Telegram, so it can decide
// whether pressing "Call" while the Telegram view is showing can actually reach BCGram, or must
// tell the operator to sign in first. Dedup on the boolean value only (unlike sendChatList's
// full-payload dedup) since this is a single flag, not a list.
function isBcgramLoggedIn(global: GlobalState): boolean {
  return global.auth.state === 'authorizationStateReady';
}

function sendAuthState(global: GlobalState, parentOrigin: string) {
  const loggedIn = isBcgramLoggedIn(global);
  if (loggedIn === lastSentAuthLoggedIn) return;
  lastSentAuthLoggedIn = loggedIn;
  const message: BcgramAuthStateMessage = { type: 'bcgram:authState', loggedIn };
  window.parent.postMessage(message, parentOrigin);
}

function setupAuthStateSender(parentOrigin: string) {
  addCallback((global: GlobalState) => sendAuthState(global, parentOrigin));
  // Send the initial state once immediately (mirrors setupSender above).
  sendAuthState(getGlobal(), parentOrigin);
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

function isBcgramEnsureGroupMessage(data: unknown): data is BcgramEnsureGroupMessage {
  return Boolean(
    data
    && typeof data === 'object'
    && (data as { type?: unknown }).type === 'bcgram:ensureGroup'
    && typeof (data as { title?: unknown }).title === 'string'
    && (data as { title: string }).title.trim().length > 0,
  );
}

// 弾 CM-16: the group exists — now fetch its default invite link and send both to the parent.
//
// Telegram gives every newly created group a default invite link, but it only reaches this client
// inside the chat's FULL info, which is a separate request. So ask for it, then watch for the link
// the same way the group itself was watched for. If it never arrives, still report the group as
// created (with no link) rather than failing: the group is real, and reporting a failure would
// make the parent tell the operator that nothing happened when something did.
function watchForInviteLink(chatId: string, parentOrigin: string) {
  const send = (inviteLink?: string) => {
    const message: BcgramGroupCreatedMessage = { type: 'bcgram:groupCreated', chatId, inviteLink };
    window.parent.postMessage(message, parentOrigin);
  };

  const existing = selectChatFullInfo(getGlobal(), chatId)?.inviteLink;
  if (existing) {
    send(existing);
    return;
  }

  getActions().loadFullChat({ chatId, force: true });

  let tries = 0;
  const timer = window.setInterval(() => {
    tries += 1;
    const inviteLink = selectChatFullInfo(getGlobal(), chatId)?.inviteLink;
    if (inviteLink) {
      window.clearInterval(timer);
      send(inviteLink);
      return;
    }
    if (tries >= INVITE_LINK_MAX_TRIES) {
      window.clearInterval(timer);
      send(undefined);
    }
  }, ENSURE_GROUP_POLL_MS);
}

// CM-15: `createGroupChat` is fire-and-forget (the action writes the created chat into global
// state and opens it). Rather than reaching into the action's internal progress flag, watch for a
// chat id that did not exist before and carries the title we asked for — the same "check what the
// operator would actually see" approach `scheduleOpenChatFailureCheck` already takes.
function watchForCreatedGroup(title: string, before: Set<string>, parentOrigin: string) {
  let tries = 0;
  const timer = window.setInterval(() => {
    tries += 1;
    const global = getGlobal();
    const createdId = Object.keys(global.chats.byId).find(
      (id) => !before.has(id) && global.chats.byId[id]?.title === title,
    );
    if (createdId) {
      window.clearInterval(timer);
      watchForInviteLink(createdId, parentOrigin);
      return;
    }
    if (tries >= ENSURE_GROUP_MAX_TRIES) {
      window.clearInterval(timer);
      const message: BcgramEnsureGroupFailedMessage = {
        type: 'bcgram:ensureGroupFailed', reason: 'create_failed',
      };
      window.parent.postMessage(message, parentOrigin);
    }
  }, ENSURE_GROUP_POLL_MS);
}

function isBcgramStartCallMessage(data: unknown): data is BcgramStartCallMessage {
  // CM-10a §2 段A-2: no `'chatId' in data` check here — `chatId` is optional (see
  // BcgramStartCallMessage above), and requiring the key would drop a chatId-less request at
  // the door, right back to the original silence this 弾 is fixing.
  return Boolean(
    data
    && typeof data === 'object'
    && (data as { type?: unknown }).type === 'bcgram:startCall',
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
      return;
    }

    // CM-15 (CEO 2026-09-14): create the 3LINE group for a work tab, as the operator's own
    // account. A Telegram BOT cannot create groups at all, so this page — which is a real client
    // signed in as the operator — is the only place this can happen without manual work in the
    // Telegram app for every new AP. The operator ends up as the creator, hence a member.
    if (isBcgramEnsureGroupMessage(data)) {
      const global = getGlobal();
      if (!isBcgramLoggedIn(global)) {
        const message: BcgramEnsureGroupFailedMessage = {
          type: 'bcgram:ensureGroupFailed', reason: 'not_logged_in',
        };
        window.parent.postMessage(message, parentOrigin);
        return;
      }
      const before = new Set(Object.keys(global.chats.byId));
      // 弾 CM-16: a SUPERGROUP (`megagroup`), not a basic group.
      //
      // 3LINE is created by the company account BEFORE any operator exists, so the group has to be
      // creatable with nobody but its creator. `messages.createChat` (basic group) takes a required
      // `users:Vector<InputUser>` and answers `USERS_TOO_FEW` when it is empty — this very file
      // handles that error at chats.ts:1184 — so the previous `createGroupChat` call could never
      // have worked for the intended flow. `channels.createChannel` has no `users` parameter at
      // all: creator-only creation is the protocol's own default, and people are added afterwards.
      getActions().createChannel({
        title: data.title,
        isSuperGroup: true,
        memberIds: (data.memberIds ?? []).map(String),
      });
      watchForCreatedGroup(data.title, before, parentOrigin);
      return;
    }

    if (isBcgramStartCallMessage(data)) {
      const global = getGlobal();
      // CM-10a §2 段A-3: chatId が来ていなければ、いま開いている会話を使う
      // （CEO 定義＝「通話の相手は、BCGram でいま開いている相手」）。
      const chatId = data.chatId !== undefined && data.chatId !== null && `${data.chatId}` !== ''
        ? `${data.chatId}`
        : selectCurrentMessageList(global)?.chatId;

      // CM-10a §2 段A-4: 断りは必ず reason 付きで返す（3通り。chatId は分かる時だけ付ける）。
      if (!chatId) {
        window.parent.postMessage({ type: 'bcgram:startCallFailed', reason: 'no_chat' }, parentOrigin);
        return;
      }
      if (selectIsChatWithSelf(global, chatId)) {
        window.parent.postMessage({ type: 'bcgram:startCallFailed', chatId, reason: 'self' }, parentOrigin);
        return;
      }
      // CM-6b §2-1: only a resolvable user can be called (no group calls via this door). Fail
      // fast and synchronously — same reasoning as OPEN_CHAT_FAILURE_CHECK_MS above: the parent
      // only ever asks for a chat it already knows, so there's no real network wait to bridge.
      if (!isUserId(chatId) || !selectUser(global, chatId)) {
        window.parent.postMessage({ type: 'bcgram:startCallFailed', chatId, reason: 'user_not_found' }, parentOrigin);
        return;
      }
      // requestCall(payload) 相当。userId/isVideo は fork 内部の語彙（親からは chatId/video で届く）。
      getActions().requestMasterAndRequestCall({ userId: chatId, isVideo: !!data.video });
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
  // CM-8 §2-4: right next to bcgram:ready — initial login state, then re-sent on every change.
  setupAuthStateSender(parentOrigin);
}
