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
  isAutomationIgnoredChatName,
  requiresChatOpenForMessages,
} from "./automation-filter.js";
import { runSerializedWeChatOperation } from "./operation-queue.ts";
import {
  enqueueCoalescedMessage,
  type EnqueueOptions,
} from "./inbound-coalesce.ts";

// How long to wait for additional messages from the same user before
// dispatching to the agent. 800ms is a balance: long enough to absorb
// "user typed three lines back-to-back" naturally (typical inter-message
// gap on WeChat mobile is 200-600ms), short enough that a single message
// still feels responsive (the agent only starts thinking after this).
// Also gives the next monitor poll cycle a chance to add late-arriving
// messages to the same batch (default poll interval is 500ms).
const INBOUND_COALESCE_DEBOUNCE_MS = 800;
import {
  A11Y_DB_RACE_WINDOW_MS,
  A11Y_PENDING_SEND_WINDOW_MS,
  a11yChatBottom,
  a11yDispatchedContent,
  a11yPendingDbConfirm,
  bubblesMatch,
  cleanupRecent,
  clearOutboundText,
  consumeByCreateTime,
  consumeRecent,
  hasUnconsumedEntries,
  matchesByCreateTime,
  normalizeBubbleText,
  noteOutboundText,
  recentContains,
  recentlySentReplies,
  recordRecent,
} from "./a11y-echo-guard.ts";
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

// A11y fast-path echo-guard state (markers + dedup rings) lives in its own
// module so EVERY outbound text path can reseat it — including OpenClaw's async
// outbound adapter in channel.ts, which delivers the agent's replies and is a
// separate code path from the inline reply below. See a11y-echo-guard.ts.

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

// These match WeChat's ENGLISH accessibility placeholder labels for non-text
// bubbles. The a11y fast-path SKIPS them and leaves the real message to the DB
// catch-up path, which has the true msg.kind + the XML payload (amount, memo,
// lat/lng, media bytes) that the a11y label throws away.
//
// The whole a11y pipeline already assumes English AX labels (see the
// "unread message(s)" parsing in agent-server's wechat_a11y.rs). If WeChat's UI
// language or these strings change, these skips silently stop firing — confirm
// against a live a11y dump.
//
// Bias: OVER-matching here is safe under the current dual-source design — a
// skipped bubble is still delivered (a few seconds later) by the DB path.
// UNDER-matching is the bug: the placeholder gets dispatched as a text message
// AND the DB path re-sends the real message (duplicate + garbage text).
const A11Y_TIMESTAMP_ROW_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const A11Y_MEDIA_TAG_RE =
  /\[(?:Image|Photo|Audio|Voice|Video|File|Transfer|Red\s*packet|Sticker|Emoji|Link|Mini\s*Program|Music|Location|Card|Contact\s*Card|Chat\s*History|Channels?|Note|Live)/i;
const A11Y_AUDIO_NAME_RE = /^Audio\d+/i;

// History context markers (match openclaw's built-in markers)
const HISTORY_CONTEXT_MARKER = "[Chat messages since your last reply - for context]";
const CURRENT_MESSAGE_MARKER = "[Current message - respond to this]";

// Burst marker — used when the inbound-coalesce module merges several
// rapid-fire messages from the same user into one dispatch. Critically
// different from HISTORY_CONTEXT_MARKER: every line under the burst marker
// is part of the CURRENT turn (all actionable, none are untrusted history).
// The SOP files in workspace-qiafan2-bot / workspace-qiafan2-service must
// recognise this marker and treat the listed messages as one user turn with
// multiple lines.
const BURST_CURRENT_MESSAGES_MARKER =
  "[Current turn - user sent N messages in quick succession; treat every line below as part of the same user turn]";

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

  // Commit the DB-suppress ring ONLY when the dispatch actually succeeds, and
  // clear the pending-confirm entry (seeded by the caller before this call) on
  // failure so the DB catch-up stops deferring and recovers the message. This
  // is the whole point of routing through onSettled rather than recording
  // a11yDispatchedContent eagerly: a dispatch that fails or hangs must NOT
  // leave a suppress entry that silently drops the real WCDB row.
  const norm = normalizeBubbleText(content);
  const settle = (ok: boolean): void => {
    if (ok) {
      recordRecent(a11yDispatchedContent, chatId, norm);
    } else {
      consumeRecent(a11yPendingDbConfirm, chatId, norm);
      log?.info?.(
        `[wechat:${liveAccount.accountId}] a11y fast-path dispatch did not land for ${chatId}; cleared pending so DB catch-up can recover: ${content.slice(0, 60)}`,
      );
    }
  };

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

  // Route through inbound-coalesce so a11y-bursts (e.g. user typing 3
  // lines in rapid succession, each picked up by the a11y diff before the
  // DB-path catch-up runs) merge into a single agent turn. Control
  // commands stay on the synchronous path so they take effect immediately.
  const isCtrl =
    allowTextCommands &&
    core.channel.commands.isControlCommandMessage(pm.commandBody, cfg);
  if (isCtrl) {
    const ok = await dispatchSegment(
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
    settle(ok);
  } else {
    const sessionKey = `${liveAccount.accountId}::${chatId}`;
    enqueueCoalescedMessage<ProcessedMessage>(
      sessionKey,
      pm,
      async (mergedSegment) => {
        return await dispatchSegment(
          mergedSegment,
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
      },
      { debounceMs: INBOUND_COALESCE_DEBOUNCE_MS, log },
      // onSettled — fires with the real dispatch outcome (after the debounce +
      // serialized dispatch), even if a later enqueue's closure ran the flush.
      settle,
    );
  }
}

// A failed agent reply is NOT recovered by the catch-up loop: that loop only
// re-processes inbound messages, while the generated reply text is discarded
// once the turn ends (the inbound is already marked dispatched). So a single
// transient send miss = a permanently lost reply. These misses are almost
// always UI-automation hiccups (chat-select missed the target, window lost
// focus mid-SendMessagePlan, xdotool couldn't find the frame) that clear by
// the next attempt, so we retry in place before giving up.
const SEND_MAX_ATTEMPTS = 3;
const SEND_RETRY_DELAY_MS = 1500;

/** Errors where retrying is pointless — fail fast instead of burning attempts. */
function isFatalSendError(error: string | undefined): boolean {
  if (!error) return false;
  return /NOT_LOGGED_IN|No session available/i.test(error);
}

/**
 * Try the frame-aware fast send first (skips chat-select / send_message plan).
 * Falls back to the existing `sendMessage` HTTP route on any failure, and
 * retries the whole thing on transient failures (see SEND_MAX_ATTEMPTS above).
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
  let lastError = "unknown";
  for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt++) {
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
    // Authoritative path: respect SendResult.success. Rust SendMessagePlan can
    // return success=false (chat-select missed, send button never re-enabled,
    // etc.) — re-running it re-does open_chat, which usually recovers on the
    // next attempt. Only after exhausting attempts do we throw, so the outer
    // pipeline still reports a genuinely undeliverable reply.
    const result = await client.sendMessage({ chatId, text });
    if (result.success) return;
    lastError = result.error ?? "unknown";
    if (isFatalSendError(lastError)) break;
    if (attempt < SEND_MAX_ATTEMPTS) {
      log?.info?.(
        `[wechat] sendMessage failed (attempt ${attempt}/${SEND_MAX_ATTEMPTS}): ${lastError}; retrying in ${SEND_RETRY_DELAY_MS}ms`,
      );
      await sleep(SEND_RETRY_DELAY_MS);
    }
  }
  throw new Error(`sendMessage failed after ${SEND_MAX_ATTEMPTS} attempt(s): ${lastError}`);
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

  // Sticky deny-list of display names whose wxid we've ever seen match
  // `isAutomationIgnoredChatId` (e.g. `gh_*` official accounts). The a11y
  // auto-open path (Rust) leads WCDB's batched SessionTable flush by ~9s,
  // while the per-poll skip-list below is sourced from `listChats` (WCDB) —
  // so on a *fresh* gh_ message the live a11y tree already shows the unread
  // badge before WCDB lists the session, the name is missing from this
  // poll's projection, and the chat gets auto-clicked open (which navigates
  // the main window into the official-account list and wedges all further
  // automation). Accumulating names sticky across polls closes that race:
  // once a gh_ chat has been listed even once, its name stays skipped even
  // in the WCDB-lag window. Official-account names are stable and few, so
  // the set stays tiny.
  const stickyAutoOpenSkipNames = new Set<string>();
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

      // ---- Message polling ----
      // listChats first so we can project wxid-based ignore rules (e.g.
      // anything starting with `gh_`) into a display-name deny list for
      // the a11y probe below — the Rust auto-open path only sees display
      // names from the a11y tree and would otherwise click a `gh_*` chat
      // open before the TS-side wxid filter ever runs (which has caused
      // wechat to disconnect on some official-account windows).
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

      for (const c of chats) {
        const wxid = c.username ?? c.id;
        if (!wxid || !c.name) continue;
        if (wxid.includes("@chatroom")) continue;
        if (isAutomationIgnoredChatId(wxid)) stickyAutoOpenSkipNames.add(c.name);
      }
      // Union of names seen this poll and every prior poll — see
      // `stickyAutoOpenSkipNames` above for why the sticky accumulation is
      // required (WCDB lag vs a11y lead).
      const autoOpenSkipNames = [...stickyAutoOpenSkipNames];

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
          autoOpenSkipNames,
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
          if (isAutomationIgnoredChatName(unreadChat.name)) continue;
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
          //
          // Two-stage lookup:
          //   (1) Positional — if the marker carries an eligibleLen recorded
          //       by a prior fast-path tick AND the bubble at that index still
          //       matches the marker text, slice from oldLen. This is the ONLY
          //       correct path for consecutive identical-text bubbles ("在么"
          //       → "在么" sent twice in a row): pure text search picks the
          //       LATEST match, hiding the user's second send and letting
          //       consumeRecent eat the eventual DB row → message lost.
          //   (2) Backwards text search — fallback for chat reflow / scroll
          //       and for markers set by noteOutboundText (which doesn't know
          //       eligibleLen since the bot reply hasn't rendered yet).
          const bottomMarker = a11yChatBottom.get(wxid);
          let candidates: Array<{ trimmed: string; norm: string }> = [];
          let markerFound = false;
          let deferredForPendingSend = false;
          if (bottomMarker) {
            const oldLen = bottomMarker.eligibleLen;
            const positionalHit =
              typeof oldLen === "number" &&
              oldLen >= 1 &&
              oldLen <= eligible.length &&
              bubblesMatch(eligible[oldLen - 1].norm, bottomMarker.text);
            if (positionalHit) {
              candidates = eligible.slice(oldLen as number);
              markerFound = true;
            } else {
              let idx = -1;
              for (let i = eligible.length - 1; i >= 0; i--) {
                if (bubblesMatch(eligible[i].norm, bottomMarker.text)) {
                  idx = i;
                  break;
                }
              }
              if (idx >= 0) {
                candidates = eligible.slice(idx + 1);
                markerFound = true;
              } else {
                // Marker not in eligible. Two reasons to be careful before
                // falling back to slice(-unread):
                //   (a) chat scrolled / restart — marker truly stale → fallback
                //   (b) send just completed and the bubble hasn't rendered in
                //       a11y yet → fallback would RE-DISPATCH the inbound msg
                //       that triggered the send (saw this 2026-05-19 20:06:39:
                //       Queue end 20:06:38.604, fast-path 511ms later, marker
                //       points to bot's not-yet-rendered reply, missed → fell
                //       back → second dispatch of "有啥料可以加").
                // Distinguish via recentlySentReplies: if anything's been sent
                // in the last A11Y_PENDING_SEND_WINDOW_MS, treat as (b) and
                // DEFER (skip this poll, leave marker as-is so next poll picks
                // up the bubble when it renders).
                const cutoff = Date.now() - A11Y_PENDING_SEND_WINDOW_MS;
                const pendingArr = recentlySentReplies.get(wxid);
                const pendingSend = pendingArr?.some((e) => e.ts >= cutoff) ?? false;
                if (pendingSend) {
                  log?.info?.(
                    `[wechat:${account.accountId}] a11y fast-path defer ${unreadChat.name}: marker miss but recent send within ${A11Y_PENDING_SEND_WINDOW_MS / 1000}s; bubble likely still rendering`,
                  );
                  candidates = [];
                  deferredForPendingSend = true;
                } else {
                  candidates = eligible.slice(-unreadChat.unread);
                }
              }
            }
          } else if (lastSeenId.has(wxid)) {
            // We know this chat from a prior run (lastSeenId is on disk) but
            // the in-memory a11yChatBottom map is empty — gateway just
            // restarted. The visible bubbles include messages that were
            // already dispatched before the restart, but fast-path has no
            // way to tell them apart from genuinely new ones (the persisted
            // signal is per-msg localId, the marker is per-bubble text).
            // Skip dispatch this poll; the DB catch-up loop will fire for
            // anything with localId > lastSeenId, which is what we want.
            // Marker still gets reseated below so the NEXT poll runs the
            // normal marker-hit path. Cost: one user message arriving
            // mid-restart waits ~5–10s for DB flush instead of ~1s for
            // fast-path. Saw the alternative on qiafan-bot 2026-05-21
            // 17:34:11: restart at 17:33:58 → marker undefined → fallback
            // slice(-unread) → re-dispatched "霸王茶姬都有啥" that the
            // pre-restart catch-up had already handled.
            log?.info?.(
              `[wechat:${account.accountId}] a11y fast-path defer ${unreadChat.name}: post-restart cold-start (marker lost, lastSeenId persisted); DB catch-up will handle`,
            );
            candidates = [];
          } else {
            // First observation for a chat we've never seen — trust the
            // unread badge.
            candidates = eligible.slice(-unreadChat.unread);
          }

          // candidates is always a SUFFIX of eligible — both the positional
          // and text-search paths slice from some index toward the end. The
          // start index in eligible is therefore (length - candidates.length).
          // Tracking it lets us reseat the marker with the correct eligibleLen
          // after a partial-batch failure (see below).
          const candidateStart = eligible.length - candidates.length;
          let lastHandledIdx = -1;
          let dispatchFailed = false;
          for (let i = 0; i < candidates.length; i++) {
            const item = candidates[i];
            const eligibleIdx = candidateStart + i;
            // Defense-in-depth: bot's own reply, in case the send path's
            // marker reseat hasn't landed yet (e.g. media-only reply). The
            // marker should still advance past it (the bubble is accounted
            // for), so update lastHandledIdx before continuing.
            // NOTE: we do NOT also reject against a11yDispatchedContent
            // here. The marker already gives us "consecutive duplicates
            // only" semantics; rejecting on a 30-min text ring would kill
            // legitimate user repeats like: "2" → bot reply → "2".
            if (recentContains(recentlySentReplies, wxid, item.norm)) {
              lastHandledIdx = eligibleIdx;
              continue;
            }
            // Pending-DB-confirm is recorded BEFORE dispatch so the DB
            // catch-up DEFERS this row (and its lastSeenId advance) until the
            // dispatch settles: the empty-fetch path waits for the Msg_* row,
            // and the non-empty path holds the landed row (see processUnreadChat
            // + matchesByCreateTime). a11yDispatchedContent is NOT recorded
            // here — that now happens in dispatchA11yTextMessage's onSettled
            // ONLY on a real successful dispatch, with the pending entry cleared
            // on failure so the row recovers via the DB path instead of being
            // silently suppressed by a speculative entry.
            recordRecent(a11yPendingDbConfirm, wxid, item.norm);
            log?.info?.(
              `[wechat:${account.accountId}] a11y fast-path dispatching to ${unreadChat.name} (unread=${unreadChat.unread}, marker=${markerFound ? "hit" : "miss"}): ${item.trimmed.slice(0, 60)}`,
            );
            try {
              await dispatchA11yTextMessage(client, account, cfg, chat, item.trimmed, log);
            } catch (err) {
              // Synchronous failure (policy resolve / enqueue threw) — the
              // dispatch never scheduled, so onSettled will never fire. Clear
              // the pending entry we just seeded so the DB catch-up stops
              // deferring and recovers the message. Don't reseat the marker
              // past this candidate and don't drain the rest of the batch —
              // the next a11y tick retries from here (order matters for the
              // marker logic).
              consumeRecent(a11yPendingDbConfirm, wxid, item.norm);
              log?.error?.(
                `[wechat:${account.accountId}] a11y fast-path dispatch failed: ${err}`,
              );
              dispatchFailed = true;
              break;
            }
            lastHandledIdx = eligibleIdx;
          }

          // Reseat the marker. Skip on pending-send defer so the bot-reply
          // marker stays put.
          //   - Some candidate handled: marker = that bubble, eligibleLen
          //     set so the next tick's positional lookup uses it directly.
          //   - No candidates AND no failure: marker = current bottom.
          //   - All candidates failed (lastHandledIdx === -1 + dispatchFailed):
          //     leave marker untouched → next tick retries the entire batch.
          if (!deferredForPendingSend) {
            if (lastHandledIdx >= 0) {
              a11yChatBottom.set(wxid, {
                text: eligible[lastHandledIdx].norm,
                eligibleLen: lastHandledIdx + 1,
              });
            } else if (!dispatchFailed) {
              const lastEligible = eligible[eligible.length - 1];
              a11yChatBottom.set(wxid, {
                text: lastEligible.norm,
                eligibleLen: eligible.length,
              });
            }
          }
        }

        cleanupRecent(recentlySentReplies);
        cleanupRecent(a11yDispatchedContent);
        cleanupRecent(a11yPendingDbConfirm);
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

  // Skip if already dispatched via a11y fast path. consumeByCreateTime removes
  // the matched entry so it suppresses exactly ONE WCDB row — a user who later
  // repeats the same text isn't silently dropped (the repeat finds no entry
  // and dispatches). It gates on the WCDB row's OWN create_time vs the a11y
  // dispatch stamp, NOT on a wall-clock receive window: WCDB's batched flush
  // can surface this row long after the fast-path dispatched it (observed 44s,
  // can exceed the old 3-min window under load → double-dispatch). create_time
  // doesn't move with flush lag, so this is immune to how late the row lands.
  //
  // Always also consume a11yPendingDbConfirm (whether or not the dispatch-
  // content ring suppresses): the empty-fetch defer in processUnreadChat is
  // gated on pending entries, and once the DB row has materialized there's
  // no reason to keep blocking lastSeenId advance for it. A failed fast-path
  // attempt leaves a pending entry with NO matching dispatched-content entry,
  // so this branch takes the suppress-or-not decision purely from
  // a11yDispatchedContent while still clearing the pending defer.
  if (msg.kind === "text" && msg.content) {
    const norm = normalizeBubbleText(msg.content);
    // create_time is RFC3339 from WCDB (seconds granularity). If it can't be
    // parsed, fall back to "now" so the entry still has a chance to match a
    // freshly-flushed row (consume-once remains the backstop against dupes).
    const parsed = Date.parse(msg.timestamp);
    const msgCreateTimeMs = Number.isNaN(parsed) ? Date.now() : parsed;
    consumeByCreateTime(a11yPendingDbConfirm, chatId, norm, msgCreateTimeMs);
    if (consumeByCreateTime(a11yDispatchedContent, chatId, norm, msgCreateTimeMs)) {
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
 * One segment per processed message — every inbound message gets its own LLM
 * turn.
 *
 * Used to fold multiple consecutive messages into a single batch where only
 * the trailing message got CURRENT_MESSAGE_MARKER and the earlier ones got
 * HISTORY_CONTEXT_MARKER. The SOP treats history as untrusted (defense against
 * group/quote/forward-injected write intents), so anything actionable in the
 * earlier messages was silently dropped. Saw this 2026-05-21 on qiafan-bot:
 * customer service sent "021840... 已下单 21元" then "164770... 接单" 12s
 * apart; the first message's write intent was lost and the order's
 * external_paid_amount_cent stayed 0.
 *
 * One-per-segment trade-offs:
 * - Group chat is explicitly out of scope (DMs only), so we don't need
 *   batching for "user typed three lines in a row".
 * - Consecutive identical bubbles are already filtered at the a11y marker
 *   layer before they reach this function, so a "在么/在么/在么" burst still
 *   only triggers one LLM call.
 * - Image + caption arrives as a single Message object with both media and
 *   text — no segment-level batching needed for that case.
 */
function buildSegments(processed: ProcessedMessage[]): ProcessedMessage[][] {
  return processed.map((pm) => [pm]);
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

    // Build body — burst (multi-message) vs single message.
    //
    // A multi-message segment means the inbound-coalesce module merged
    // several rapid-fire messages from the same user into one dispatch.
    // ALL of them are part of the current turn — none are history. Using
    // HISTORY_CONTEXT_MARKER here is the 2026-05-21 漏单 bug (action intent
    // in the earlier line silently dropped because SOP treats history as
    // untrusted), so we use BURST_CURRENT_MESSAGES_MARKER instead and leave
    // InboundHistory empty.
    let body: string;
    let inboundHistory: Array<{ sender: string; body: string; timestamp?: number }> | undefined;

    if (segment.length === 1) {
      body = core.channel.reply.formatAgentEnvelope({
        channel: "WeChat",
        from: fromLabel,
        timestamp,
        previousTimestamp,
        envelope: envelopeOptions,
        body: isGroup ? `${senderName}: ${rawBody}` : rawBody,
      });
    } else {
      const burstLines = segment.map((pm, idx) => {
        const entryBody = pm.isGroup ? `${pm.senderName}: ${pm.rawBody}` : pm.rawBody;
        return core.channel.reply.formatAgentEnvelope({
          channel: "WeChat",
          from: fromLabel,
          timestamp: pm.timestamp,
          // Only the very first burst line gets previousTimestamp (the
          // "since you last replied" anchor); subsequent lines are part of
          // the same turn so omit it to avoid confusing envelope formatters.
          previousTimestamp: idx === 0 ? previousTimestamp : undefined,
          envelope: envelopeOptions,
          body: entryBody,
        });
      });

      const burstHeader = BURST_CURRENT_MESSAGES_MARKER.replace(
        "N messages",
        `${segment.length} messages`,
      );
      body = [burstHeader, ...burstLines].join("\n");
    }

    // NOTE: the old "[More messages incoming — respond only with NO_REPLY]"
    // suppression token is removed because the inbound-coalesce module
    // merges in-flight messages into a single dispatch; there is no longer
    // such a thing as a "non-final batch" at this layer. dispatchA11yTextMessage
    // (which still calls dispatchSegment directly outside the coalesce path)
    // never passes remainingSegments either, so we just ignore the param.
    void remainingSegments;

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
                  // Echo-guard MUST be seeded before the await — rust
                  // send_to_frame's 500 ms post-Return verify means the
                  // bubble is visible to fast-path a11y polls while the send
                  // promise is still pending. See a11y-echo-guard.ts.
                  noteOutboundText(chatId, text);
                  let sent = false;
                  try {
                    await sendTextWithFastFallback(client, chat, chatId, text, log);
                    sent = true;
                  } finally {
                    if (!sent) clearOutboundText(chatId, text);
                  }
                }
              } else if (text) {
                noteOutboundText(chatId, text);
                let sent = false;
                try {
                  await sendTextWithFastFallback(client, chat, chatId, text, log);
                  sent = true;
                } finally {
                  if (!sent) clearOutboundText(chatId, text);
                }
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

  if (messages.length === 0) {
    // listMessages returned nothing even though session.db's lastMsgLocalId
    // is ahead of our lastSeenId (that's the precondition for catch-up
    // firing). Some system/placeholder chats (e.g. brandsessionholder) sit
    // in this state permanently — without advancing lastSeenId here, the
    // catch-up loop re-fires every pollIntervalMs (500ms), thrashing
    // agent-server with listChats/listMessages/wechatA11yState and turning
    // the autoOpen xdotool click into a constant background storm that
    // races with concurrent SendMessagePlan FSMs. Move lastSeenId up to the
    // session.db tip so the chat stays quiet until WCDB reports a newer
    // localId (i.e. a genuine new message).
    if (chat.lastMsgLocalId && chat.lastMsgLocalId > prevLastSeen) {
      // BUT: if the fast-path attempted to dispatch a message for this chat
      // within the WCDB race window, advancing here would skip the row when
      // it eventually lands in Msg_* (we'd already be past its localId, and
      // prepareMessage's a11y-dispatched dedup would never fire since the
      // row never gets fetched). Defer until the row materializes (and
      // prepareMessage clears the pending entry) or the window times out.
      // For brandsessionholder-style placeholder chats there's no fast-path
      // entry, so the advance still runs as before.
      if (hasUnconsumedEntries(a11yPendingDbConfirm, chatId, A11Y_DB_RACE_WINDOW_MS)) {
        log?.info?.(
          `[wechat:${liveAccount.accountId}] ${chatId}: deferring empty-fetch lastSeenId advance (fast-path attempt awaiting WCDB)`,
        );
        return;
      }
      await setLastSeenAndPersist(
        liveAccount.accountId,
        lastSeenId,
        chatId,
        chat.lastMsgLocalId,
        log,
      );
    }
    return;
  }

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

  // Defer-until-confirmed: if any just-landed row matches an a11y fast-path
  // dispatch that is still in-flight (a11yPendingDbConfirm has it) and NOT yet
  // confirmed (a11yDispatchedContent does not), hold the WHOLE batch — return
  // without advancing lastSeenId — and retry next poll. This closes the race
  // where a slow/hung fast-path dispatch lets the DB row through (double
  // dispatch) or, with the old eager suppress-ring, swallowed it entirely.
  //   - dispatch SUCCEEDS  → onSettled records a11yDispatchedContent → next
  //     poll stops deferring and prepareMessage suppresses the row (single).
  //   - dispatch FAILS     → onSettled clears the pending entry → next poll
  //     stops deferring and dispatches the row here (recovery).
  //   - dispatch HANGS     → pending stays, batch keeps deferring, lastSeenId
  //     never advances → a restart re-fetches and re-delivers it. The match is
  //     gated on the row's own create_time (immune to flush lag) and naturally
  //     bounded by cleanupRecent's 30-min GC of the pending ring.
  // Non-destructive on purpose: the pending entry is consumed exactly once,
  // later, by prepareMessage's consumeByCreateTime when the row is processed.
  for (const m of newMessages) {
    if (m.kind !== "text" || !m.content) continue;
    const norm = normalizeBubbleText(m.content);
    const parsed = Date.parse(m.timestamp);
    const ct = Number.isNaN(parsed) ? Date.now() : parsed;
    if (
      matchesByCreateTime(a11yPendingDbConfirm, chatId, norm, ct) &&
      !matchesByCreateTime(a11yDispatchedContent, chatId, norm, ct)
    ) {
      log?.info?.(
        `[wechat:${liveAccount.accountId}] ${chatId}: deferring batch (lastSeenId held) — fast-path dispatch in-flight/unconfirmed for: ${m.content.slice(0, 60)}`,
      );
      return;
    }
  }

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

  // Dispatch policy:
  //   - DM messages without control commands go through the inbound-coalesce
  //     module: each message is enqueued and the actual agent dispatch runs
  //     asynchronously after a debounce window, merging any messages that
  //     arrive in quick succession into a single agent turn. This eliminates
  //     reply-order races and naturally batches user bursts. lastSeenId is
  //     advanced as soon as the message is enqueued (single dispatch
  //     failures inside coalesce are logged but not retried — UI hiccups
  //     are already covered by SEND_MAX_ATTEMPTS inside the deliver chain).
  //   - Group chats and control commands stay on the synchronous path so
  //     the existing mention / group-history / control-command semantics
  //     (clearBufferedHistory after all dispatched, lastSeenId rewind on
  //     failure) keep working unchanged.
  let allDispatched = true;
  if (processed.length > 0) {
    const useCoalesce = !isGroup && !hasControlCommandInWindow;

    if (useCoalesce) {
      log?.info?.(
        `[wechat:${liveAccount.accountId}] ${chatId}: enqueueing ${processed.length} msg(s) into inbound-coalesce`,
      );
      const sessionKey = `${liveAccount.accountId}::${chatId}`;
      const enqueueOpts: EnqueueOptions = {
        debounceMs: INBOUND_COALESCE_DEBOUNCE_MS,
        log,
      };
      for (const pm of processed) {
        enqueueCoalescedMessage<ProcessedMessage>(
          sessionKey,
          pm,
          // Each enqueue captures a fresh closure with the current cfg /
          // policy / liveAccount snapshot. inbound-coalesce uses the most
          // recent closure for the eventual flush, so config hot-reloads
          // applied between polls take effect for the next dispatch.
          async (mergedSegment) => {
            return await dispatchSegment(
              mergedSegment,
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
          },
          enqueueOpts,
        );
      }
      // Fire-and-forget: allDispatched stays true so lastSeenId advances.
      //
      // KNOWN GAP (tracked follow-up — twin of the a11y dedup-timing fix):
      // lastSeenId advances here at ENQUEUE time, before the coalesced
      // dispatchSegment runs. A pure-DB-path message (one that never went
      // through the a11y fast-path) whose coalesced dispatch later FAILS or
      // HANGS is then silently lost — the row won't be re-fetched (lastSeenId
      // already moved past it) and there's no further fallback channel. The
      // a11y path is now recoverable via onSettled + defer-until-confirmed
      // (see dispatchA11yTextMessage / the defer scan above); this path is
      // not. Fixing it cleanly needs in-flight-localId dedup + advance-on-
      // settle / rewind-on-failure, which changes lastSeenId advance
      // semantics — deferred to its own change with dedicated tests.
    } else {
      const segments = hasControlCommandInWindow
        ? processed.map((pm) => [pm])
        : buildSegments(processed);
      log?.info?.(
        `[wechat:${liveAccount.accountId}] ${chatId}: ${processed.length} dispatchable msg(s) in ${segments.length} segment(s) (sync path: group=${isGroup}, ctrlCmd=${hasControlCommandInWindow})`,
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
