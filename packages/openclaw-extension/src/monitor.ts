import { WeChatClient } from "@apexglory/agent-wechat2-shared";
import type { Chat, Message, MediaResult, AuthStatus, A11yState } from "@apexglory/agent-wechat2-shared";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import type { ResolvedWeChatAccount } from "./types.js";
import { getWeChatRuntime } from "./runtime.js";
import {
  resolveWeChatAccount,
  resolveWeChatDisableBlockStreaming,
} from "./types.js";
import {
  normalizeWeChatCommandBody,
  resolveWeChatCommandAuthorization,
  resolveWeChatInboundAccessDecision,
  resolveWeChatMentionGate,
  resolveWeChatPolicyContext,
  type WeChatPolicyContext,
} from "./access-control.js";
import {
  isAutomationIgnoredChatId,
  requiresChatOpenForMessages,
} from "./automation-filter.js";
import { runSerializedWeChatOperation } from "./operation-queue.ts";
import { formatPaymentBody } from "./payment-format.js";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

// Message types that may have downloadable media
const MEDIA_TYPES = new Set([3, 34, 43]); // image, voice, video

// ============================================================
// Persisted lastSeenId — survives gateway restarts so we don't
// re-process the same inbound message (and re-trigger the LLM /
// re-spend tokens) just because in-memory state was lost.
// Storage: $STATE_DIR/extensions/wechat/lastseen-<accountId>.json
// ============================================================
function lastSeenStorePath(accountId: string): string {
  const core = getWeChatRuntime();
  const stateDir = core.state.resolveStateDir();
  return path.join(
    stateDir,
    "extensions",
    "wechat",
    `lastseen-${encodeURIComponent(accountId)}.json`,
  );
}

async function loadLastSeenFromDisk(
  accountId: string,
  log?: { info?: (...args: any[]) => void; error?: (...args: any[]) => void },
): Promise<Map<string, number>> {
  const filePath = lastSeenStorePath(accountId);
  try {
    const data = await fsp.readFile(filePath, "utf8");
    const obj = JSON.parse(data) as Record<string, number>;
    const map = new Map<string, number>();
    for (const [k, v] of Object.entries(obj)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) map.set(k, n);
    }
    log?.info?.(
      `[wechat:${accountId}] Loaded lastSeenId from ${filePath}: ${map.size} chat(s)`,
    );
    return map;
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      log?.error?.(
        `[wechat:${accountId}] Failed to load lastSeenId from ${filePath}: ${err}`,
      );
    }
    return new Map();
  }
}

async function persistLastSeenId(
  accountId: string,
  lastSeenId: Map<string, number>,
): Promise<void> {
  const filePath = lastSeenStorePath(accountId);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(Object.fromEntries(lastSeenId)));
  await fsp.rename(tmp, filePath);
}

/** Update lastSeenId and persist atomically. Logs (but does not throw) on write failure. */
async function setLastSeenAndPersist(
  accountId: string,
  lastSeenId: Map<string, number>,
  chatId: string,
  value: number,
  log?: { info?: (...args: any[]) => void; error?: (...args: any[]) => void },
): Promise<void> {
  lastSeenId.set(chatId, value);
  try {
    await persistLastSeenId(accountId, lastSeenId);
  } catch (err) {
    log?.error?.(`[wechat:${accountId}] Failed to persist lastSeenId: ${err}`);
  }
}

// ============================================================
// A11y fast-path state (module-level, shared across accounts)
//
// WeChat's a11y tree collapses every chat bubble to a single list-item
// with text in `name` and no children/states — so inbound vs outbound
// is invisible at this layer. Instead we track the bottom-most visible
// bubble per chat as a high-water mark: items below the marker are new,
// items at-or-above are already-seen (including bot's own replies).
// The send path updates the marker as soon as the bot delivers a reply,
// so its own bubble can never be misread as a new inbound message.
//
// Dedup ringbuffers (defense-in-depth, NOT the primary new-vs-old judge):
//   recentlySentReplies     — bot outbound texts, guards against echo of bot
//                             bubbles in case the marker fails to update.
//   a11yDispatchedContent   — texts dispatched via fast-path, used ONLY by
//                             the DB catch-up loop to skip the ~9s race
//                             between fast-path dispatch and WCDB flush.
// The marker is the sole "is this a new message" judge — repeating-text
// dedup at content level is intentionally NOT applied in fast-path itself,
// otherwise legitimate user repeats like "2" → bot reply → "2" get killed.
// ============================================================
type RecentEntry = { text: string; ts: number };
const A11Y_DEDUP_WINDOW_MS = 1_800_000;  // 30 min — recentlySentReplies safety net
const A11Y_DB_RACE_WINDOW_MS = 30_000;   // 30 s  — fast-path→DB catch-up race window

const recentlySentReplies = new Map<string, RecentEntry[]>();   // wxid -> normalized outbound texts (dedup bot's own)
const a11yDispatchedContent = new Map<string, RecentEntry[]>(); // wxid -> normalized contents already dispatched via a11y
// Per-chat normalized text of the most recent visible bubble (bot's reply OR last dispatch).
// Items appearing below this marker on the next poll are the only candidates for dispatch.
const a11yChatBottom = new Map<string, string>();

function normalizeBubbleText(s: string): string {
  // WeChat tends to append "\n " to bubble labels; long bubbles are also
  // truncated in atspi. Collapse runs of whitespace to a single space so
  // recordings and a11y reads compare consistently.
  return s.replace(/\s+/g, " ").trim();
}

function bubblesMatch(a: string, b: string): boolean {
  // Both inputs already normalized.
  if (a === b) return true;
  // a11y may truncate long bubbles. If either is a prefix of the other
  // (and not trivially short), treat as the same bubble.
  if (a.length >= 12 && b.length >= 12) {
    if (a.startsWith(b) || b.startsWith(a)) return true;
  }
  return false;
}

// Unique negative localId per a11y-dispatched message, so openclaw's
// inbound MessageSid dedup (wechat:<chat>:<localId>) doesn't collapse
// every a11y message into one. Real WeChat localIds are positive.
let a11yLocalIdCounter = -1;
function nextA11yLocalId(): number {
  const id = a11yLocalIdCounter;
  a11yLocalIdCounter -= 1;
  // Wrap if it ever gets near Number.MIN_SAFE_INTEGER (never realistic)
  if (a11yLocalIdCounter < -1_000_000_000) a11yLocalIdCounter = -1;
  return id;
}

const A11Y_TIMESTAMP_ROW_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const A11Y_MEDIA_TAG_RE = /\[(?:Image|Audio|Video|File|Transfer|Red\s*packet)/i;
const A11Y_AUDIO_NAME_RE = /^Audio\d+/i;

function cleanupRecent(map: Map<string, RecentEntry[]>): void {
  const cutoff = Date.now() - A11Y_DEDUP_WINDOW_MS;
  for (const [k, arr] of map.entries()) {
    const fresh = arr.filter((e) => e.ts >= cutoff);
    if (fresh.length === 0) map.delete(k);
    else map.set(k, fresh);
  }
}

function recordRecent(map: Map<string, RecentEntry[]>, key: string, text: string): void {
  const arr = map.get(key) ?? [];
  arr.push({ text, ts: Date.now() });
  map.set(key, arr);
}

function recentContains(
  map: Map<string, RecentEntry[]>,
  key: string,
  text: string,
  windowMs: number = A11Y_DEDUP_WINDOW_MS,
): boolean {
  const arr = map.get(key);
  if (!arr) return false;
  const cutoff = Date.now() - windowMs;
  return arr.some((e) => e.ts >= cutoff && bubblesMatch(e.text, text));
}

// History context markers (match openclaw's built-in markers)
const HISTORY_CONTEXT_MARKER = "[Chat messages since your last reply - for context]";
const CURRENT_MESSAGE_MARKER = "[Current message - respond to this]";

export interface WeChatMonitorOptions {
  account: ResolvedWeChatAccount;
  abortSignal: AbortSignal;
  runtime: any; // PluginRuntime
  setStatus: (next: any) => void;
  log?: { info?: (...args: any[]) => void; error?: (...args: any[]) => void };
  cfg: any; // OpenClawConfig
}

type ProcessedMessage = {
  msg: Message;
  rawBody: string;
  commandBody: string;
  mediaPath?: string;
  mediaMime?: string;
  senderName: string;
  senderId: string;
  isGroup: boolean;
  timestamp: number;
  hasMedia: boolean;
  isMentioned: boolean;
};

/**
 * A11y fast-path: dispatch a single DM text message constructed from
 * the a11y tree (no DB query, no chat-select). Reuses dispatchSegment
 * by building a stub Message with localId=-1 — the DB path will see
 * the real message ~9s later and skip it via a11yDispatchedContent dedup.
 */
async function dispatchA11yTextMessage(
  client: WeChatClient,
  account: ResolvedWeChatAccount,
  cfg: any,
  chat: Chat,
  content: string,
  log?: { info?: (...args: any[]) => void; error?: (...args: any[]) => void },
): Promise<void> {
  const core = getWeChatRuntime();
  const chatId = chat.username ?? chat.id;
  const liveAccount = resolveWeChatAccount(cfg as Record<string, unknown>, account.accountId) ?? account;
  const storeAllowFrom = await core.channel.pairing
    .readAllowFromStore({ channel: "wechat", accountId: liveAccount.accountId, env: process.env })
    .catch(() => [] as string[]);
  const policy = resolveWeChatPolicyContext({
    account: liveAccount,
    cfg: cfg as any,
    chatId,
    storeAllowFrom,
  });
  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg,
    surface: "wechat",
  });

  const access = resolveWeChatInboundAccessDecision({
    isGroup: false,
    senderId: chatId,
    policy,
  });
  if (!access.allowed) {
    log?.info?.(
      `[wechat:${liveAccount.accountId}] a11y fast-path: blocked by policy (${access.reason}) for ${chatId}`,
    );
    return;
  }

  const now = Date.now();
  const localId = nextA11yLocalId();
  const stubMsg: Message = {
    localId,
    serverId: localId,
    chatId,
    sender: chatId,
    senderName: chat.name,
    type: 1,
    kind: "text",
    content,
    timestamp: new Date(now).toISOString(),
    isSelf: false,
  };
  const pm: ProcessedMessage = {
    msg: stubMsg,
    rawBody: content,
    commandBody: normalizeWeChatCommandBody(content, { isGroup: false, wasMentioned: false }),
    senderName: chat.name,
    senderId: chatId,
    isGroup: false,
    timestamp: now,
    hasMedia: false,
    isMentioned: false,
  };

  await dispatchSegment(
    [pm],
    client,
    chatId,
    chat,
    liveAccount,
    policy,
    storeAllowFrom,
    allowTextCommands,
    cfg,
    log,
    undefined,
  );
}

/**
 * Try the frame-aware fast send first (skips chat-select / send_message plan).
 * Falls back to the existing `sendMessage` HTTP route on any failure.
 * DM only for phase 1 — groups don't get standalone frames by display name.
 */
async function sendTextWithFastFallback(
  client: WeChatClient,
  chat: Chat,
  chatId: string,
  text: string,
  log?: { info?: (...args: any[]) => void; error?: (...args: any[]) => void },
): Promise<void> {
  const isGroup = chatId.includes("@chatroom");
  if (!isGroup && chat.name) {
    try {
      const fast = await client.sendFast({ frameName: chat.name, text });
      if (fast.ok) return;
      log?.info?.(
        `[wechat] sendFast skipped, falling back to sendMessage: ${fast.error ?? "unknown"}`,
      );
    } catch (err) {
      log?.info?.(`[wechat] sendFast threw, falling back: ${err}`);
    }
  }
  // Crucially: respect SendResult.success. Rust SendMessagePlan can return
  // success=false (chat-select missed, send button never re-enabled, etc.)
  // and historically we silently ignored it — caller would see "Queue end"
  // with no error, lastSeenId would advance, and the user would never get
  // the reply. Throw so the outer pipeline reports the failure and the
  // catch-up loop retries on the next poll.
  const result = await client.sendMessage({ chatId, text });
  if (!result.success) {
    throw new Error(`sendMessage failed: ${result.error ?? "unknown"}`);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Poll for media data, retrying until data is available or max attempts reached.
 */
async function pollMedia(
  client: WeChatClient,
  chatId: string,
  localId: number,
  log?: { info?: (...args: any[]) => void; error?: (...args: any[]) => void },
  maxAttempts = 15,
  intervalMs = 1000,
): Promise<MediaResult | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await client.getMedia(chatId, localId);
    if (result.type === "unsupported") {
      // Server knows this message type has no media — no point retrying
      return null;
    }
    if (result.data) {
      return result;
    }
    if (attempt < maxAttempts) {
      log?.info?.(`[media] Attempt ${attempt}/${maxAttempts} for ${chatId}:${localId} returned no data, retrying...`);
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
  return null;
}

function enqueueWeChatSystemEvent(text: string, contextKey: string): void {
  try {
    const core = getWeChatRuntime();
    core.system.enqueueSystemEvent(text, {
      sessionKey: "agent:main:main",
      contextKey,
    });
  } catch {
    // Don't crash the monitor if system event fails
  }
}

export async function startWeChatMonitor(
  opts: WeChatMonitorOptions,
): Promise<void> {
  const { account, abortSignal, setStatus, log } = opts;
  const client = new WeChatClient({ baseUrl: account.serverUrl, token: account.token });

  // Track last-seen message ID per chat. Persisted across gateway restarts
  // so msgs already handed off to the LLM aren't re-dispatched after a
  // restart re-seeds in-memory state.
  const lastSeenId = await loadLastSeenFromDisk(account.accountId, log);

  // Buffer non-mentioned group messages for catch-up context
  const groupHistory = new Map<string, ProcessedMessage[]>();
  const GROUP_HISTORY_LIMIT = 50;
  let lastAuthCheck = 0;
  let prevStatus: AuthStatus["status"] | undefined = undefined;

  // Report initial status as running
  setStatus({
    accountId: account.accountId,
    running: true,
    connected: true,
    linked: true,
  });

  while (!abortSignal.aborted) {
    try {
      // Reload config each iteration so hot-reloads take effect
      const cfg = getWeChatRuntime().config.loadConfig();

      // ---- Auth polling (every authPollIntervalMs) ----
      const now = Date.now();
      if (now - lastAuthCheck >= account.authPollIntervalMs) {
        lastAuthCheck = now;
        try {
          const auth = await client.authStatus();
          const isLinked = auth.status === "logged_in";
          setStatus({
            accountId: account.accountId,
            running: true,
            connected: true,
            linked: isLinked,
            authStatus: auth.status,
          });

          // Notify agent proactively on meaningful auth transitions
          if (prevStatus === "logged_in" && !isLinked) {
            const msg = auth.status === "app_not_running"
              ? "[WeChat] Application stopped. It will restart automatically — credentials may be cached, so you can try reconnecting using the wechat_login tool."
              : "[WeChat] Session ended. You can try reconnecting using the wechat_login tool — if credentials are cached, login may complete automatically.";
            enqueueWeChatSystemEvent(msg, "wechat:auth_lost");
          } else if (prevStatus === undefined && !isLinked) {
            enqueueWeChatSystemEvent(
              "[WeChat] Not logged in. Use the wechat_login tool to authenticate — if credentials are cached from a previous session, login may complete automatically.",
              "wechat:auth_required",
            );
          }
          prevStatus = auth.status;

          if (!isLinked) {
            log?.info?.(`[wechat:${account.accountId}] Not authenticated (status: ${auth.status})`);
            await sleep(account.pollIntervalMs, abortSignal);
            continue;
          }
        } catch (err) {
          setStatus({
            accountId: account.accountId,
            running: true,
            connected: false,
            linked: false,
            lastError: String(err),
          });
          if (prevStatus === "logged_in") {
            enqueueWeChatSystemEvent(
              "[WeChat] Cannot reach agent-wechat server. The container may have stopped.",
              "wechat:server_unreachable",
            );
          }
          prevStatus = undefined;
          log?.error?.(
            `[wechat:${account.accountId}] Auth check failed: ${err}`,
          );
          await sleep(account.pollIntervalMs, abortSignal);
          continue;
        }
      }

      // ---- A11y fast-path probe ----
      // Triggers auto-double-click on any chat that has an unread badge in
      // the main window but no independent frame yet, then (for already-open
      // chats) reads new messages directly from the a11y tree — typically
      // ~9s ahead of WCDB's batched SessionTable flush.
      let a11yState: A11yState | null = null;
      const a11yT0 = Date.now();
      try {
        a11yState = await client.wechatA11yState({
          autoOpen: true,
          includeMessages: true,
        });
        if (a11yState.error) {
          log?.info?.(
            `[wechat:${account.accountId}] a11y_state error: ${a11yState.error} (${Date.now() - a11yT0}ms)`,
          );
          a11yState = null;
        } else if (a11yState.opened.length > 0) {
          log?.info?.(
            `[wechat:${account.accountId}] a11y auto-opened ${a11yState.opened.length} chat window(s): ${a11yState.opened.join(", ")}`,
          );
        }
      } catch (err) {
        log?.info?.(
          `[wechat:${account.accountId}] a11y_state failed: ${err} (${Date.now() - a11yT0}ms)`,
        );
      }

      // ---- Message polling ----
      let chats: Chat[];
      try {
        chats = await client.listChats(50);
      } catch (err) {
        log?.error?.(
          `[wechat:${account.accountId}] Failed to list chats: ${err}`,
        );
        await sleep(account.pollIntervalMs, abortSignal);
        continue;
      }

      // ---- A11y fast-path dispatch (DM text only, phase 1) ----
      // For each chat that has an unread badge AND an open independent window,
      // diff the messages list-items vs the last seen set. Newly-arrived
      // plain-text items get dispatched immediately — bypassing SessionTable's
      // ~9s flush lag. The eventual DB-path processUnreadChat will see these
      // same messages later and skip them via a11yDispatchedContent dedup in
      // prepareMessage.
      //
      // Escape hatch: set OPENCLAW_WECHAT_A11Y_DISABLE=1 on the gateway env
      // to skip the fast-path entirely and fall back to the polling/DB path.
      // The DB path already has a working isSelf filter, so this kills the
      // self-echo loop you get when bot-outbound messages are sent through
      // channels that don't reseat the a11yChatBottom marker (e.g. a sibling
      // openclaw extension calling sendMessage directly without going through
      // sendTextWithFastFallback). Cost: replies wait one DB poll instead of
      // showing up via a11y inside ~1s.
      if (
        process.env.OPENCLAW_WECHAT_A11Y_DISABLE !== "1" &&
        a11yState &&
        a11yState.chatsWithUnread.length > 0
      ) {
        // Map a11y display name → Chat. Build TWO sets: dispatchable
        // (DM, non-ignored) and ignoredNames (so we can silently skip
        // official accounts / system chats / groups without log spam).
        const nameToChat = new Map<string, Chat>();
        const ignoredNames = new Set<string>();
        for (const c of chats) {
          const wxid = c.username ?? c.id;
          if (!wxid) continue;
          if (!c.name) continue;
          if (wxid.includes("@chatroom") || isAutomationIgnoredChatId(wxid)) {
            ignoredNames.add(c.name);
            continue;
          }
          nameToChat.set(c.name, c);
        }

        for (const unreadChat of a11yState.chatsWithUnread) {
          if (abortSignal.aborted) break;
          if (ignoredNames.has(unreadChat.name)) continue; // silent: group/official/system
          if (!unreadChat.open) {
            log?.info?.(
              `[wechat:${account.accountId}] a11y fast-path skip ${unreadChat.name}: window not open`,
            );
            continue;
          }
          const chat = nameToChat.get(unreadChat.name);
          if (!chat) {
            // Likely a chat that hasn't been written to SessionTable yet
            // (so listChats can't resolve its wxid). Quiet: this is expected
            // when WCDB hasn't flushed; the DB path will handle it later.
            continue;
          }
          const wxid = chat.username ?? chat.id;
          const items = a11yState.messagesPerFrame[unreadChat.name];
          if (!items || items.length === 0) continue; // no messages list yet

          // Sort by bounds.y ascending → visual top-to-bottom (oldest first, newest last).
          const ordered = [...items]
            .map((it) => ({ raw: it.name, y: it.bounds?.y ?? 0 }))
            .sort((a, b) => a.y - b.y);
          // Drop timestamp / media / empty / payment bubbles up-front so the
          // bottom marker is the LAST DISPATCHABLE bubble — otherwise a stray
          // timestamp row at the end would shift the marker and re-dispatch
          // the bubble above it forever.
          const eligible: Array<{ trimmed: string; norm: string }> = [];
          for (const it of ordered) {
            if (A11Y_TIMESTAMP_ROW_RE.test(it.raw.trim())) continue;
            const trimmed = it.raw.replace(/\n\s*$/, "").trim();
            if (trimmed.length === 0) continue;
            if (A11Y_MEDIA_TAG_RE.test(trimmed)) continue;
            if (A11Y_AUDIO_NAME_RE.test(trimmed)) continue;
            if (trimmed.startsWith("Image") && trimmed.length < 20) continue;
            if (trimmed.startsWith("[Red packet")) continue;
            if (trimmed.startsWith("￥")) continue;
            // Location share (msgType=48): the a11y label is just "Location"
            // + POI name + address, losing the lat/lng/scale in the real XML
            // payload. Skip here so the DB catch-up picks up the full <msg>
            // <location x=... y=... .../></msg> blob.
            if (trimmed.startsWith("Location")) continue;
            eligible.push({ trimmed, norm: normalizeBubbleText(trimmed) });
          }
          if (eligible.length === 0) continue;

          // High-water mark: items below the previously-recorded bottom
          // bubble are the new ones. Anything at-or-above (including bot's
          // own replies, since the send path updates the marker) is skipped.
          const bottomMarker = a11yChatBottom.get(wxid);
          let candidates: Array<{ trimmed: string; norm: string }>;
          let markerFound = false;
          if (bottomMarker) {
            let idx = -1;
            for (let i = eligible.length - 1; i >= 0; i--) {
              if (bubblesMatch(eligible[i].norm, bottomMarker)) {
                idx = i;
                break;
              }
            }
            if (idx >= 0) {
              candidates = eligible.slice(idx + 1);
              markerFound = true;
            } else {
              // Marker scrolled off (chat scrolled, bot restart, etc.):
              // fall back to the unread-badge slice. Conservative — may
              // re-dispatch a small window once, then the marker reseats.
              candidates = eligible.slice(-unreadChat.unread);
            }
          } else {
            // First observation for this chat — trust the unread badge.
            candidates = eligible.slice(-unreadChat.unread);
          }

          // Always reseat the marker to the current bottom-most eligible
          // bubble, regardless of whether anything got dispatched. This is
          // what stops repeat dispatches at the 2-min TTL boundary.
          const lastEligible = eligible[eligible.length - 1];
          a11yChatBottom.set(wxid, lastEligible.norm);

          for (const item of candidates) {
            // Defense-in-depth: bot's own reply, in case the send path's
            // marker reseat hasn't landed yet (e.g. media-only reply).
            // NOTE: we do NOT also reject against a11yDispatchedContent
            // here. The marker already gives us "consecutive duplicates
            // only" semantics; rejecting on a 30-min text ring would kill
            // legitimate user repeats like: "2" → bot reply → "2".
            if (recentContains(recentlySentReplies, wxid, item.norm)) continue;

            // Recorded for the DB catch-up loop to skip the same text when
            // WCDB flushes ~9s later (the A11Y_DB_RACE_WINDOW_MS lookup).
            recordRecent(a11yDispatchedContent, wxid, item.norm);
            log?.info?.(
              `[wechat:${account.accountId}] a11y fast-path dispatching to ${unreadChat.name} (unread=${unreadChat.unread}, marker=${markerFound ? "hit" : "miss"}): ${item.trimmed.slice(0, 60)}`,
            );
            try {
              await dispatchA11yTextMessage(client, account, cfg, chat, item.trimmed, log);
            } catch (err) {
              log?.error?.(
                `[wechat:${account.accountId}] a11y fast-path dispatch failed: ${err}`,
              );
            }
          }
        }

        cleanupRecent(recentlySentReplies);
        cleanupRecent(a11yDispatchedContent);
      }

      // Filter to chats with unreads (skip system / service accounts).
      // Further drop chats whose lastMsgLocalId is already <= lastSeenId —
      // those are stuck-on-screen unread badges (e.g. when bot answers
      // NO_REPLY: WeChat still shows unread but we've already processed
      // / deduped the message). Logging them every tick spams the log.
      const unreadChats = chats.filter(
        (c) => c.unreadCount > 0 && !isAutomationIgnoredChatId(c.username ?? c.id),
      );
      const actionableUnreadChats = unreadChats.filter((c) => {
        const prevSeen = lastSeenId.get(c.username ?? c.id);
        if (prevSeen === undefined) return true;
        if (!c.lastMsgLocalId) return true;
        return c.lastMsgLocalId > prevSeen;
      });
      if (actionableUnreadChats.length > 0) {
        log?.info?.(
          `[wechat:${account.accountId}] ${actionableUnreadChats.length} chat(s) with unreads`,
        );
      }

      if (actionableUnreadChats.length > 0) {
        for (const chat of actionableUnreadChats) {
          if (abortSignal.aborted) break;
          const chatId = chat.username ?? chat.id;
          const prevSeen = lastSeenId.get(chatId);
          if (prevSeen !== undefined && chat.lastMsgLocalId && chat.lastMsgLocalId <= prevSeen) {
            continue;
          }
          await processUnreadChat(
            client,
            chat,
            lastSeenId,
            account,
            cfg,
            log,
            undefined,
            groupHistory,
            GROUP_HISTORY_LIMIT,
          );
        }
      }

      // ---- Seed lastSeenId for first-time-seen chats with no unread ----
      // On startup, a11y `autoOpen: true` may have opened a chat window and
      // cleared its unread badge before the JS code observes it, so
      // unreadCount=0 even though the chat has messages newer than anything
      // the (in-memory) lastSeenId map knows about. Without seeding, the
      // catch-up loop below would skip the chat forever (prevSeen===undefined),
      // and new messages would silently be missed. Seed to lastMsgLocalId-1
      // so the catch-up loop fires once for the newest message and
      // processUnreadChat takes over from there. Chats with unread>0 are left
      // alone — processUnreadChat's firstPoll path seeds them correctly.
      for (const chat of chats) {
        const chatId = chat.username ?? chat.id;
        if (!chatId) continue;
        if (lastSeenId.has(chatId)) continue;
        if (!chat.lastMsgLocalId) continue;
        if (chat.unreadCount > 0) continue;
        if (isAutomationIgnoredChatId(chatId)) continue;
        const seedId = Math.max(0, chat.lastMsgLocalId - 1);
        await setLastSeenAndPersist(account.accountId, lastSeenId, chatId, seedId, log);
      }

      // ---- Catch-up: check tracked chats where lastMsgLocalId advanced past lastSeenId ----
      for (const chat of chats) {
        if (abortSignal.aborted) break;
        const chatId = chat.username ?? chat.id;
        if (isAutomationIgnoredChatId(chatId)) continue; // skip system / official accounts
        const prevSeen = lastSeenId.get(chatId);
        if (prevSeen === undefined) continue; // not tracked yet
        if (unreadChats.some((c) => (c.username ?? c.id) === chatId)) continue; // already processed
        if (!chat.lastMsgLocalId || chat.lastMsgLocalId <= prevSeen) continue; // nothing new

        log?.info?.(
          `[wechat:${account.accountId}] Catch-up: ${chatId} lastMsgLocalId=${chat.lastMsgLocalId} > lastSeenId=${prevSeen}`,
        );
        await processUnreadChat(client, chat, lastSeenId, account, cfg, log, true, groupHistory, GROUP_HISTORY_LIMIT);
      }
    } catch (err) {
      log?.error?.(
        `[wechat:${account.accountId}] Monitor error: ${err}`,
      );
    }

    await sleep(account.pollIntervalMs, abortSignal);
  }

  setStatus({
    accountId: account.accountId,
    running: false,
    connected: false,
  });
}

/**
 * Pre-process a single message: download media, build rawBody, resolve sender info.
 */
async function prepareMessage(
  client: WeChatClient,
  msg: Message,
  chatId: string,
  chat: Chat,
  liveAccount: ResolvedWeChatAccount,
  policy: WeChatPolicyContext,
  log?: { info?: (...args: any[]) => void; error?: (...args: any[]) => void },
): Promise<ProcessedMessage | null> {
  const core = getWeChatRuntime();

  // Skip self-sent messages
  if (msg.isSelf) {
    log?.info?.(`[wechat:${liveAccount.accountId}] Skipping self-sent msg ${msg.localId}`);
    return null;
  }

  // Skip if already dispatched via a11y fast path within the WCDB flush
  // race window (~9s). Using a short window — not the long safety-net TTL —
  // so that a user who legitimately repeats the same text minutes later
  // doesn't get silently dropped here.
  if (msg.kind === "text" && msg.content) {
    if (
      recentContains(
        a11yDispatchedContent,
        chatId,
        normalizeBubbleText(msg.content),
        A11Y_DB_RACE_WINDOW_MS,
      )
    ) {
      log?.info?.(
        `[wechat:${liveAccount.accountId}] Skipping msg ${msg.localId} — already dispatched via a11y fast path`,
      );
      return null;
    }
  }

  const isGroup = chatId.includes("@chatroom");
  const senderId = msg.sender ?? chatId;
  const senderName = msg.senderName ?? msg.sender ?? chat.name;
  const wasMentioned = isGroup && (msg.isMentioned === true);

  const access = resolveWeChatInboundAccessDecision({
    isGroup,
    senderId,
    policy,
  });
  if (!access.allowed) {
    log?.info?.(
      `[wechat:${liveAccount.accountId}] Blocked by policy (${access.reason}) from ${senderId}`,
    );
    return null;
  }

  // Attempt media download for supported types
  let mediaPath: string | undefined;
  let mediaMime: string | undefined;
  let hasMedia = false;

  const baseType = msg.type & 0x7fffffff;
  const isPaymentMessage = msg.kind === "transfer" || msg.kind === "red_packet";
  // Type 49 (appmsg) may contain file attachments — the server resolves subtypes
  // and returns type="file" for subtype 6. Try fetching media for type 49 as well.
  const mayHaveMedia = !isPaymentMessage && (MEDIA_TYPES.has(baseType) || baseType === 49);

  if (mayHaveMedia) {
    log?.info?.(`[wechat:${liveAccount.accountId}] Checking media for msg ${msg.localId} (type ${baseType})`);
    try {
      const result = await pollMedia(client, chatId, msg.localId, log);
      if (result && result.data && result.type !== "unsupported") {
        hasMedia = true;
        log?.info?.(`[wechat:${liveAccount.accountId}] Media result: type=${result.type}, format=${result.format}, hasData=${!!result.data}, filename=${result.filename}`);
        const mimeMap: Record<string, string> = {
          jpeg: "image/jpeg",
          jpg: "image/jpeg",
          png: "image/png",
          gif: "image/gif",
          mp3: "audio/mpeg",
          pdf: "application/pdf",
          doc: "application/msword",
          docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          xls: "application/vnd.ms-excel",
          xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          ppt: "application/vnd.ms-powerpoint",
          pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          zip: "application/zip",
          txt: "text/plain",
        };
        mediaMime = mimeMap[result.format] ?? `application/${result.format || "octet-stream"}`;
        const buf = Buffer.from(result.data!, "base64");
        const saved = await core.channel.media.saveMediaBuffer(
          buf,
          mediaMime,
          "inbound",
          undefined,
          result.filename,
        );
        mediaPath = saved?.path;
        log?.info?.(`[wechat:${liveAccount.accountId}] Saved media to ${mediaPath}`);
      } else if (MEDIA_TYPES.has(baseType)) {
        // Image/voice expected media but got nothing
        hasMedia = true;
        log?.info?.(`[wechat:${liveAccount.accountId}] Media not available after retries for msg ${msg.localId}`);
      }
    } catch (err) {
      log?.error?.(`[wechat:${liveAccount.accountId}] Media download failed: ${err}`);
    }
  }

  const timestamp = new Date(msg.timestamp).getTime();
  let rawBody = formatPaymentBody(msg) ?? msg.content ?? "";
  if (mediaPath && mediaMime) {
    if (!rawBody) {
      if (mediaMime.startsWith("audio/")) {
        rawBody = "<media:audio>";
      } else if (mediaMime.startsWith("image/")) {
        rawBody = "<media:image>";
      } else {
        rawBody = "<media:file>";
      }
    } else if (!mediaMime.startsWith("image/") && !mediaMime.startsWith("audio/")) {
      // For file attachments, content is the filename — annotate it
      rawBody = `[File: ${rawBody}]`;
    }
  }

  // Append reply context for quote/reply messages
  if (msg.reply) {
    const replySender = msg.reply.sender ?? "unknown sender";
    const quotedBody = msg.reply.content.length > 50
      ? msg.reply.content.slice(0, 50) + "..."
      : msg.reply.content;
    const replyBlock = `[Replying to ${replySender}]\n${quotedBody}\n[/Replying]`;
    rawBody = rawBody ? `${rawBody}\n\n${replyBlock}` : replyBlock;
  }

  return {
    msg,
    rawBody,
    commandBody: normalizeWeChatCommandBody(rawBody, {
      isGroup,
      wasMentioned,
    }),
    mediaPath,
    mediaMime,
    senderName,
    senderId,
    isGroup,
    timestamp,
    hasMedia,
    isMentioned: wasMentioned,
  };
}

async function prepareMessagesForChat(
  client: WeChatClient,
  newMessages: Message[],
  chatId: string,
  chat: Chat,
  liveAccount: ResolvedWeChatAccount,
  policy: WeChatPolicyContext,
  shouldOpen: boolean,
  log?: { info?: (...args: any[]) => void; error?: (...args: any[]) => void },
): Promise<ProcessedMessage[] | null> {
  if (shouldOpen) {
    log?.info?.(
      `[wechat:${liveAccount.accountId}] Opening chat ${chatId} for non-text message processing...`,
    );
    try {
      await client.openChat(chatId, true);
      log?.info?.(`[wechat:${liveAccount.accountId}] Opened chat ${chatId}`);
    } catch (err) {
      log?.error?.(
        `[wechat:${liveAccount.accountId}] Failed to open chat ${chatId}: ${err}`,
      );
      return null;
    }
  }

  const processed: ProcessedMessage[] = [];
  for (const msg of newMessages) {
    log?.info?.(
      `[wechat:${liveAccount.accountId}] Processing msg ${msg.localId}: type=${msg.type}, sender=${msg.sender}, isSelf=${msg.isSelf}, content=${(msg.content || "").slice(0, 50)}`,
    );
    const pm = await prepareMessage(client, msg, chatId, chat, liveAccount, policy, log);
    if (pm) {
      processed.push(pm);
    }
  }

  return processed;
}

/**
 * Split processed messages into batches where each batch has at most one media message.
 * When a second media is encountered, flush the current batch and start a new one.
 */
function buildSegments(processed: ProcessedMessage[]): ProcessedMessage[][] {
  const segments: ProcessedMessage[][] = [];
  let currentBatch: ProcessedMessage[] = [];
  let mediaCount = 0;

  for (const pm of processed) {
    if (pm.hasMedia && mediaCount >= 1) {
      // Second media in this batch — flush and start new batch
      segments.push(currentBatch);
      currentBatch = [pm];
      mediaCount = 1;
    } else {
      if (pm.hasMedia) mediaCount++;
      currentBatch.push(pm);
    }
  }

  if (currentBatch.length > 0) {
    segments.push(currentBatch);
  }

  return segments;
}

/**
 * Dispatch a segment of one or more messages as a single LLM call.
 */
async function dispatchSegment(
  segment: ProcessedMessage[],
  client: WeChatClient,
  chatId: string,
  chat: Chat,
  liveAccount: ResolvedWeChatAccount,
  policy: WeChatPolicyContext,
  storeAllowFrom: string[],
  allowTextCommands: boolean,
  cfg: any,
  log?: { info?: (...args: any[]) => void; error?: (...args: any[]) => void },
  remainingSegments?: number,
): Promise<boolean> {
  const core = getWeChatRuntime();
  const lastMsg = segment[segment.length - 1];
  const { isGroup, senderId, senderName, timestamp, rawBody, commandBody, msg } = lastMsg;

  // Find the media attachment in this batch (at most one per batch)
  const mediaMsg = segment.find((pm) => pm.mediaPath);
  const mediaPath = mediaMsg?.mediaPath;
  const mediaMime = mediaMsg?.mediaMime;

  log?.info?.(
    `[wechat:${liveAccount.accountId}] Dispatching segment: ${segment.length} msg(s), last=${msg.localId}` +
    `${mediaPath ? ` media=${mediaPath}` : ""}`,
  );

  const hasControlCommand =
    allowTextCommands && core.channel.commands.isControlCommandMessage(commandBody, cfg);
  const commandAuthorized = await resolveWeChatCommandAuthorization({
    cfg,
    rawBody: commandBody,
    isGroup,
    senderId,
    dmPolicy: policy.dmPolicy,
    allowFromForCommands: isGroup ? policy.effectiveGroupAllowFrom : policy.effectiveAllowFrom,
    deps: {
      shouldComputeCommandAuthorized: (raw, loadedCfg) =>
        core.channel.commands.shouldComputeCommandAuthorized(raw, loadedCfg),
      resolveCommandAuthorizedFromAuthorizers: (params) =>
        core.channel.commands.resolveCommandAuthorizedFromAuthorizers(params),
      readAllowFromStore: async () => storeAllowFrom,
    },
  });
  if (isGroup && allowTextCommands && hasControlCommand && commandAuthorized !== true) {
    log?.info?.(
      `[wechat:${liveAccount.accountId}] Dropping unauthorized group control command from ${senderId} in ${chatId}`,
    );
    return false;
  }

  const mentionGate = resolveWeChatMentionGate({
    isGroup,
    requireMention: policy.requireMention,
    canDetectMention: true,
    wasMentioned: segment.some((pm) => pm.isMentioned),
    allowTextCommands,
    hasControlCommand,
    commandAuthorized: commandAuthorized === true,
  });
  if (isGroup && mentionGate.shouldSkip) {
    log?.info?.(
      `[wechat:${liveAccount.accountId}] Skipping group segment (mention required) in ${chatId}`,
    );
    return false;
  }

  try {
    // Resolve routing using the last (triggering) message
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "wechat",
      accountId: liveAccount.accountId,
      peer: {
        kind: isGroup ? "group" : "direct",
        id: isGroup ? chatId : senderId,
      },
    });

    const fromLabel = isGroup
      ? `group:${chat.name || chatId}`
      : senderName || `user:${senderId}`;
    const storePath = core.channel.session.resolveStorePath(
      cfg.session?.store,
      { agentId: route.agentId },
    );

    const envelopeOptions =
      core.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const previousTimestamp =
      core.channel.session.readSessionUpdatedAt({
        storePath,
        sessionKey: route.sessionKey,
      });

    // Build body — with history context if batching multiple messages
    let body: string;
    let inboundHistory: Array<{ sender: string; body: string; timestamp?: number }> | undefined;

    if (segment.length === 1) {
      // Single message — format as today
      body = core.channel.reply.formatAgentEnvelope({
        channel: "WeChat",
        from: fromLabel,
        timestamp,
        previousTimestamp,
        envelope: envelopeOptions,
        body: isGroup ? `${senderName}: ${rawBody}` : rawBody,
      });
    } else {
      // Multi-message batch: earlier messages become history context
      const historyMessages = segment.slice(0, -1);

      // Format history entries
      const historyLines = historyMessages.map((pm) => {
        const entryBody = pm.isGroup ? `${pm.senderName}: ${pm.rawBody}` : pm.rawBody;
        return core.channel.reply.formatAgentEnvelope({
          channel: "WeChat",
          from: fromLabel,
          timestamp: pm.timestamp,
          envelope: envelopeOptions,
          body: entryBody,
        });
      });

      // Format current (last) message
      const currentLine = core.channel.reply.formatAgentEnvelope({
        channel: "WeChat",
        from: fromLabel,
        timestamp,
        previousTimestamp,
        envelope: envelopeOptions,
        body: isGroup ? `${senderName}: ${rawBody}` : rawBody,
      });

      // Combine with history context markers
      body = [
        HISTORY_CONTEXT_MARKER,
        ...historyLines,
        "",
        CURRENT_MESSAGE_MARKER,
        currentLine,
      ].join("\n");

      // Structured history for InboundHistory field
      inboundHistory = historyMessages.map((pm) => ({
        sender: pm.senderName,
        body: pm.rawBody,
        timestamp: pm.timestamp,
      }));
    }

    // For non-final batches, instruct agent to suppress reply (NO_REPLY token)
    if (remainingSegments && remainingSegments > 0) {
      body += `\n\n[More messages incoming — respond only with NO_REPLY]`;
    }

    // Build inbound context
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: rawBody,
      RawBody: rawBody,
      CommandBody: commandBody,
      InboundHistory: inboundHistory,
      From: isGroup ? `wechat:group:${chatId}` : `wechat:${senderId}`,
      To: `wechat:${chatId}`,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      ConversationLabel: fromLabel,
      SenderName: senderName || undefined,
      SenderId: senderId,
      Provider: "wechat",
      Surface: "wechat",
      MessageSid: `wechat:${chatId}:${msg.localId}`,
      WasMentioned: isGroup ? mentionGate.effectiveWasMentioned : undefined,
      CommandAuthorized: commandAuthorized,
      OriginatingChannel: "wechat",
      OriginatingTo: `wechat:${chatId}`,
      ...(msg.payment
        ? {
            PaymentKind: msg.payment.kind,
            PaymentLocalId: msg.localId,
            PaymentAmountText: msg.payment.amountText,
            PaymentAmountCents: msg.payment.amountCents,
            PaymentCurrency: msg.payment.currency,
            PaymentIsReceived: msg.isReceived,
            PaymentTransactionId: msg.payment.transactionId,
            PaymentTransferId: msg.payment.transferId,
            PaymentSendId: msg.payment.sendId,
            PaymentPayMsgId: msg.payment.payMsgId,
          }
        : {}),
      ...(mediaPath ? { MediaPath: mediaPath, MediaUrl: mediaPath, MediaType: mediaMime } : {}),
      ...(msg.reply ? {
        ReplyToBody: msg.reply.content.length > 50 ? msg.reply.content.slice(0, 50) + "..." : msg.reply.content,
        ReplyToSender: msg.reply.sender,
      } : {}),
    });

    // Record session
    await core.channel.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      onRecordError: (err: unknown) => {
        log?.error?.(
          `[wechat:${liveAccount.accountId}] Failed updating session meta: ${String(err)}`,
        );
      },
    });

    // Dispatch reply
    const { onModelSelected, ...prefixOptions } = createChannelReplyPipeline({
      cfg,
      agentId: route.agentId,
      channel: "wechat",
      accountId: liveAccount.accountId,
    });

    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        ...prefixOptions,
        deliver: async (payload: any) =>
          runSerializedWeChatOperation(
            liveAccount.accountId,
            chatId,
            `deliver reply to ${chatId}`,
            async () => {
              const mediaList: string[] = payload.mediaUrls?.length
                ? payload.mediaUrls
                : payload.mediaUrl
                  ? [payload.mediaUrl]
                  : [];

              const tableMode = core.channel.text.resolveMarkdownTableMode({
                cfg,
                channel: "wechat",
                accountId: liveAccount.accountId,
              });
              const text = core.channel.text.convertMarkdownTables(
                payload.text ?? "",
                tableMode,
              );

              if (mediaList.length > 0) {
                for (const mediaUrl of mediaList) {
                  try {
                    const fsmod = await import("fs/promises");
                    const pathmod = await import("path");

                    let base64: string;
                    let mimeType: string;
                    let filename: string;
                    if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
                      const res = await fetch(mediaUrl);
                      const buffer = await res.arrayBuffer();
                      base64 = Buffer.from(buffer).toString("base64");
                      mimeType = res.headers.get("content-type") ?? "application/octet-stream";
                      const urlPath = new URL(mediaUrl).pathname;
                      filename = pathmod.basename(urlPath) || "file";
                    } else {
                      const buf = await fsmod.readFile(mediaUrl);
                      base64 = buf.toString("base64");
                      filename = pathmod.basename(mediaUrl);
                      const ext = pathmod.extname(mediaUrl).toLowerCase().replace(".", "");
                      const extMime: Record<string, string> = {
                        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
                        gif: "image/gif", webp: "image/webp",
                      };
                      mimeType = extMime[ext] ?? "application/octet-stream";
                    }

                    const isImage = mimeType.startsWith("image/");
                    const sendResult = isImage
                      ? await client.sendMessage({ chatId, image: { data: base64, mimeType } })
                      : await client.sendMessage({ chatId, file: { data: base64, filename } });
                    if (!sendResult.success) {
                      throw new Error(
                        `sendMessage(${isImage ? "image" : "file"}) failed: ${sendResult.error ?? "unknown"}`,
                      );
                    }
                  } catch (err) {
                    log?.error?.(`[wechat:${liveAccount.accountId}] Failed to send media: ${err}`);
                  }
                }
                // Send text caption separately if present
                if (text) {
                  await sendTextWithFastFallback(client, chat, chatId, text, log);
                  const norm = normalizeBubbleText(text);
                  recordRecent(recentlySentReplies, chatId, norm);
                  // Reseat the fast-path marker on the bot's own bubble so
                  // the next a11y poll won't read it as a new inbound msg.
                  a11yChatBottom.set(chatId, norm);
                }
              } else if (text) {
                await sendTextWithFastFallback(client, chat, chatId, text, log);
                const norm = normalizeBubbleText(text);
                recordRecent(recentlySentReplies, chatId, norm);
                a11yChatBottom.set(chatId, norm);
              }
            },
            log,
          ),
        onError: (err: unknown, info: any) => {
          log?.error?.(
            `[wechat:${liveAccount.accountId}] ${info.kind} reply failed: ${String(err)}`,
          );
        },
      },
      replyOptions: {
        onModelSelected,
        disableBlockStreaming: resolveWeChatDisableBlockStreaming(
          liveAccount.blockStreaming,
        ),
      },
    });

    // Record activity
    core.channel.activity?.record?.({
      channel: "wechat",
      accountId: liveAccount.accountId,
      direction: "inbound",
      at: timestamp,
    });

    return true;
  } catch (err) {
    log?.error?.(
      `[wechat:${liveAccount.accountId}] Failed to dispatch segment (last msg ${msg.localId}): ${err}`,
    );
    return false;
  }
}

function bufferGroupHistory(
  groupHistory: Map<string, ProcessedMessage[]>,
  chatId: string,
  pm: ProcessedMessage,
  limit: number,
): void {
  const history = groupHistory.get(chatId) ?? [];
  history.push(pm);
  while (history.length > limit) {
    history.shift();
  }
  // LRU: refresh key insertion order
  groupHistory.delete(chatId);
  groupHistory.set(chatId, history);
  // Evict oldest groups if too many tracked
  if (groupHistory.size > 1000) {
    const first = groupHistory.keys().next().value;
    if (first) groupHistory.delete(first);
  }
}

async function processUnreadChat(
  client: WeChatClient,
  chat: Chat,
  lastSeenId: Map<string, number>,
  account: ResolvedWeChatAccount,
  cfg: any,
  log?: { info?: (...args: any[]) => void; error?: (...args: any[]) => void },
  skipOpen?: boolean,
  groupHistory?: Map<string, ProcessedMessage[]>,
  groupHistoryLimit?: number,
): Promise<void> {
  const core = getWeChatRuntime();
  // Re-resolve account from hot-reloaded config so policy changes take effect
  const liveAccount =
    resolveWeChatAccount(cfg as Record<string, unknown>, account.accountId) ??
    account;
  const chatId = chat.username ?? chat.id;
  const storeAllowFrom = await core.channel.pairing
    .readAllowFromStore({ channel: "wechat", accountId: liveAccount.accountId, env: process.env })
    .catch(() => [] as string[]);
  const policy = resolveWeChatPolicyContext({
    account: liveAccount,
    cfg: cfg as any,
    chatId,
    storeAllowFrom,
  });
  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg,
    surface: "wechat",
  });

  // Determine how many messages to fetch
  const firstPoll = !lastSeenId.has(chatId);
  const prevLastSeen = lastSeenId.get(chatId) ?? 0;
  const fetchLimit = Math.max(chat.unreadCount, 20);

  let messages: Message[];
  try {
    messages = await client.listMessages(chatId, fetchLimit);
  } catch (err) {
    log?.error?.(
      `[wechat:${liveAccount.accountId}] Failed to list messages for ${chatId}: ${err}`,
    );
    return;
  }

  log?.info?.(
    `[wechat:${liveAccount.accountId}] ${chatId}: fetched ${messages.length} msgs, firstPoll=${firstPoll}, prevLastSeen=${prevLastSeen}, unreadCount=${chat.unreadCount}`,
  );

  if (messages.length === 0) return;

  // On first poll, only process the last `unreadCount` messages
  // and seed lastSeenId from the rest
  let newMessages: Message[];
  if (firstPoll) {
    messages.sort((a, b) => a.localId - b.localId);
    const unread = chat.unreadCount ?? 0;
    if (unread > 0 && unread < messages.length) {
      newMessages = messages.slice(-unread);
      const seenMax = messages[messages.length - unread - 1].localId;
      await setLastSeenAndPersist(liveAccount.accountId, lastSeenId, chatId, seenMax, log);
    } else if (unread >= messages.length) {
      // All fetched messages are unread
      newMessages = messages;
    } else {
      // No unreads — just seed lastSeenId, don't process anything
      const maxId = messages[messages.length - 1].localId;
      await setLastSeenAndPersist(liveAccount.accountId, lastSeenId, chatId, maxId, log);
      return;
    }
  } else {
    newMessages = messages.filter((m) => m.localId > prevLastSeen);
    if (newMessages.length === 0) {
      // Don't update lastSeenId — if session.db reports a newer message
      // (via lastMsgLocalId) that hasn't appeared in message_N.db yet,
      // the catch-up loop will re-fire on the next poll.
      return;
    }
    newMessages.sort((a, b) => a.localId - b.localId);
  }

  log?.info?.(
    `[wechat:${liveAccount.accountId}] ${chatId}: ${newMessages.length} new msg(s) to process`,
  );

  const hasNonTextMessages = requiresChatOpenForMessages(newMessages);
  const processed = hasNonTextMessages
    ? await runSerializedWeChatOperation(
        liveAccount.accountId,
        chatId,
        `prepare non-text messages in ${chatId}`,
        () =>
          prepareMessagesForChat(
            client,
            newMessages,
            chatId,
            chat,
            liveAccount,
            policy,
            !skipOpen,
            log,
          ),
        log,
      )
    : await prepareMessagesForChat(
        client,
        newMessages,
        chatId,
        chat,
        liveAccount,
        policy,
        false,
        log,
      );
  if (!processed) {
    return;
  }

  // Group history catch-up: buffer or inject based on mention status
  const isGroup = chatId.includes("@chatroom");
  let clearBufferedHistory = false;
  const hasControlCommandInWindow =
    allowTextCommands &&
    processed.some((pm) => core.channel.commands.isControlCommandMessage(pm.commandBody, cfg));
  if (isGroup && groupHistory) {
    if (policy.requireMention) {
      const hasMention = processed.some(pm => pm.isMentioned);
      if (!hasMention && !hasControlCommandInWindow) {
        // No mention — buffer all messages and skip dispatch
        const limit = groupHistoryLimit ?? 50;
        for (const pm of processed) {
          bufferGroupHistory(groupHistory, chatId, pm, limit);
        }
        log?.info?.(`[wechat:${liveAccount.accountId}] Buffered ${processed.length} msg(s) for group history in ${chatId}`);
        const maxId = Math.max(...newMessages.map((m) => m.localId));
        await setLastSeenAndPersist(liveAccount.accountId, lastSeenId, chatId, maxId, log);
        return;
      }

      if (hasMention) {
        clearBufferedHistory = true;
        // Mention found — pull buffered history and prepend
        const buffered = groupHistory.get(chatId) ?? [];
        if (buffered.length > 0) {
          // Mark buffered messages as mentioned so they remain historical context.
          for (const pm of buffered) {
            pm.isMentioned = true;
          }
          processed.unshift(...buffered);
          log?.info?.(
            `[wechat:${liveAccount.accountId}] Injected ${buffered.length} buffered msg(s) as history in ${chatId}`,
          );
        }

        // Strip media from all but the latest message that has it (across entire combined list)
        let latestMediaIdx = -1;
        for (let i = processed.length - 1; i >= 0; i--) {
          if (processed[i].mediaPath) {
            latestMediaIdx = i;
            break;
          }
        }
        for (let i = 0; i < processed.length; i++) {
          if (processed[i].mediaPath && i !== latestMediaIdx) {
            processed[i] = {
              ...processed[i],
              mediaPath: undefined,
              mediaMime: undefined,
              hasMedia: false,
            };
          }
        }
      }
    } else {
      // Mention is disabled for this group; clear stale buffered entries once we reply.
      clearBufferedHistory = true;
    }
  }

  // Split into segments at media boundaries and dispatch each
  let allDispatched = true;
  if (processed.length > 0) {
    const segments = hasControlCommandInWindow
      ? processed.map((pm) => [pm])
      : buildSegments(processed);
    log?.info?.(
      `[wechat:${liveAccount.accountId}] ${chatId}: ${processed.length} dispatchable msg(s) in ${segments.length} segment(s)`,
    );
    for (let i = 0; i < segments.length; i++) {
      const remaining = segments.length - i - 1;
      const dispatched = await dispatchSegment(
        segments[i],
        client,
        chatId,
        chat,
        liveAccount,
        policy,
        storeAllowFrom,
        allowTextCommands,
        cfg,
        log,
        hasControlCommandInWindow ? undefined : remaining,
      );
      if (!dispatched) {
        allDispatched = false;
      }
    }
    if (clearBufferedHistory && allDispatched && groupHistory) {
      groupHistory.set(chatId, []);
    }
  }

  // Only advance lastSeenId when every segment landed. If any send failed,
  // leave it where it was so the next catch-up poll retries this batch —
  // the alternative ("Queue end" + silent loss) is the bug we're fixing.
  // processed.length === 0 (e.g. all messages self-sent / filtered) keeps
  // allDispatched=true, so we still advance past those.
  if (allDispatched) {
    const maxId = Math.max(...newMessages.map((m) => m.localId));
    await setLastSeenAndPersist(liveAccount.accountId, lastSeenId, chatId, maxId, log);
  } else {
    log?.info?.(
      `[wechat:${liveAccount.accountId}] ${chatId}: keeping lastSeenId=${prevLastSeen} (some segments failed; will retry on next poll)`,
    );
  }
}
