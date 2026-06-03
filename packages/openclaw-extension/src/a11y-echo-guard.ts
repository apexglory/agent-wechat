// ============================================================
// A11y fast-path echo-guard state (shared across the extension).
//
// The a11y fast-path reads chat bubbles straight off the visible window's
// a11y tree and dispatches them as inbound messages. WeChat's a11y tree
// can't tell inbound from outbound, so the ONLY thing keeping the bot's own
// reply bubbles from being read back as fresh user messages is this state:
//
//   a11yChatBottom         — per-chat (wxid) high-water marker. Records the
//                            normalized text of the most recent visible bubble
//                            AND, when the fast-path set it, the eligible-list
//                            length at that moment. Next-tick lookup tries
//                            positional first (eligible[oldLen-1].text matches
//                            markerText → slice from oldLen) and falls back to
//                            backwards text search on mismatch — this is the
//                            only way to disambiguate consecutive identical-
//                            text bubbles, which a pure text marker collapses
//                            into "I've already seen this" → next user repeat
//                            never dispatches and the DB row gets eaten by
//                            consumeRecent.
//   recentlySentReplies    — ring of bot outbound texts per wxid; defense in
//                            depth against echoing a bot bubble if the marker
//                            reseat hasn't landed yet.
//   a11yDispatchedContent  — texts SUCCESSFULLY dispatched via the fast-path,
//                            used by the DB catch-up loop to skip the same
//                            message once WCDB flushes it ~9s later. Recorded
//                            only after dispatch returns — otherwise a failed
//                            fast-path send would silently suppress the eventual
//                            DB row and the message would be permanently lost.
//   a11yPendingDbConfirm   — texts the fast-path ATTEMPTED to dispatch (success
//                            or failure), per wxid. While any entry is live,
//                            processUnreadChat's empty-fetch lastSeenId advance
//                            is deferred: WCDB may have flushed session.db
//                            (lastMsgLocalId ↑) before the Msg_* row, and
//                            advancing here would skip the row when it lands.
//                            Cleared by prepareMessage when the matching DB
//                            row finally goes through.
//
// CRITICAL: this state MUST be reseated by EVERY outbound text path, not just
// the monitor's inline reply. The agent's replies are delivered asynchronously
// through OpenClaw's outbound adapter (channel.ts), which is a separate code
// path; if it doesn't call noteOutboundText() the bot's own bubble surfaces
// below the stale marker on the next a11y poll and gets dispatched back to the
// agent as a brand-new inbound message — the self-echo loop. That's why this
// lives in its own module instead of being private to monitor.ts.
// ============================================================

export type RecentEntry = { text: string; ts: number };

export const A11Y_DEDUP_WINDOW_MS = 1_800_000; // 30 min — recentlySentReplies safety net
export const A11Y_DB_RACE_WINDOW_MS = 180_000; // 3 min — fast-path→DB catch-up race window
// 60 s — defer fast-path on marker miss while a send may still be unrendered.
// Was 15 s; bumped 2026-05-25 after watching wxid_xxoxed61kmwv22 dispatch the
// same "咋样" six times at ~30 s intervals because sendFast had reported ok
// for the first five sends (xdotool exit-0) but wechat never registered the
// Enter, so the bot's reply bubble never appeared in a11y and every following
// marker lookup missed → fell back to slice(-unread) → re-dispatched. 60 s
// covers two full poll cycles past a Queue end so a marker miss within that
// window is overwhelmingly "send actually failed" rather than "bubble still
// rendering". The DB path (lastSeenId-filtered) backstops anything legitimate
// that arrives during the defer window.
export const A11Y_PENDING_SEND_WINDOW_MS = 60_000;

export const recentlySentReplies = new Map<string, RecentEntry[]>(); // wxid -> normalized outbound texts (dedup bot's own)
export const a11yDispatchedContent = new Map<string, RecentEntry[]>(); // wxid -> normalized contents successfully dispatched via a11y
// Per-chat fast-path dispatch attempts (success OR failure) awaiting WCDB to
// flush the corresponding Msg_* row. Empty-fetch lastSeenId advance defers
// while any entry is live; entries are consumed when the matching DB row goes
// through prepareMessage (and time-out via cleanupRecent as a safety net).
export const a11yPendingDbConfirm = new Map<string, RecentEntry[]>();
// Per-chat marker. `text` is the most recent visible bubble (bot's reply OR
// last dispatched). `eligibleLen` is the size of the fast-path's `eligible`
// list when the marker was set — only the fast-path knows this, so callers
// outside it (e.g. noteOutboundText) leave it undefined to force the next-
// tick lookup into backwards text search.
export type ChatBottomMarker = { text: string; eligibleLen?: number };
export const a11yChatBottom = new Map<string, ChatBottomMarker>();

export function normalizeBubbleText(s: string): string {
  // WeChat tends to append "\n " to bubble labels; long bubbles are also
  // truncated in atspi. Normalize so an a11y read and the WCDB content
  // compare equal even for SHORT messages (e.g. "饿了"), where bubblesMatch
  // requires exact post-normalization equality (no prefix tolerance < 12 chars):
  //   - NFC so composed/decomposed Unicode forms match,
  //   - strip zero-width chars + BOM (a11y sometimes injects U+200B/U+FEFF
  //     that the WCDB content doesn't carry),
  //   - strip C0/C1 control bytes (keep \t \n \r — folded by the collapse below),
  //   - collapse runs of whitespace to a single space.
  return s
    .normalize("NFC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function bubblesMatch(a: string, b: string): boolean {
  // Both inputs already normalized.
  if (a === b) return true;
  // a11y may truncate long bubbles. If either is a prefix of the other
  // (and not trivially short), treat as the same bubble.
  if (a.length >= 12 && b.length >= 12) {
    if (a.startsWith(b) || b.startsWith(a)) return true;
  }
  return false;
}

export function cleanupRecent(map: Map<string, RecentEntry[]>): void {
  const cutoff = Date.now() - A11Y_DEDUP_WINDOW_MS;
  for (const [k, arr] of map.entries()) {
    const fresh = arr.filter((e) => e.ts >= cutoff);
    if (fresh.length === 0) map.delete(k);
    else map.set(k, fresh);
  }
}

export function recordRecent(map: Map<string, RecentEntry[]>, key: string, text: string): void {
  const arr = map.get(key) ?? [];
  arr.push({ text, ts: Date.now() });
  map.set(key, arr);
}

export function recentContains(
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

// True if `map` has any entry for `key` within `windowMs`. Used by the
// empty-fetch path in processUnreadChat to decide whether to defer the
// lastSeenId advance (waiting for an outstanding fast-path attempt's DB row
// to land).
export function hasUnconsumedEntries(
  map: Map<string, RecentEntry[]>,
  key: string,
  windowMs: number = A11Y_DEDUP_WINDOW_MS,
): boolean {
  const arr = map.get(key);
  if (!arr || arr.length === 0) return false;
  const cutoff = Date.now() - windowMs;
  return arr.some((e) => e.ts >= cutoff);
}

// Like recentContains, but removes the matched entry so it can only suppress
// ONE later occurrence. The DB catch-up loop uses this to skip the single
// WCDB row that mirrors an a11y-dispatched message, while still letting a
// genuine user repeat ("2" → bot reply → "2") through: the first DB row
// consumes the entry, the second finds none and dispatches. This is more
// correct than a pure time-window guard, which would silently drop the repeat.
export function consumeRecent(
  map: Map<string, RecentEntry[]>,
  key: string,
  text: string,
  windowMs: number = A11Y_DEDUP_WINDOW_MS,
): boolean {
  const arr = map.get(key);
  if (!arr) return false;
  const cutoff = Date.now() - windowMs;
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    if (e.ts >= cutoff && bubblesMatch(e.text, text)) {
      arr.splice(i, 1);
      if (arr.length === 0) map.delete(key);
      else map.set(key, arr);
      return true;
    }
  }
  return false;
}

// Slack for clock granularity between the WCDB create_time (Unix SECONDS, so
// floored — can read up to ~1 s earlier than the real send) and the gateway's
// Date.now() fast-path dispatch stamp. Kept small so a genuine fast repeat
// isn't swallowed; the consume-once semantics is the primary repeat guard.
export const A11Y_TS_EPSILON_MS = 2_000;

// Like consumeRecent, but gates on the WCDB message's own create_time instead
// of a wall-clock receive window. Suppress iff a matching a11y-dispatched entry
// exists AND the DB row was SENT at-or-before that dispatch (+ epsilon).
//
// Why this is more robust than consumeRecent's `e.ts >= now - windowMs`:
// WCDB's batched flush can surface a row long after the fast-path dispatched it
// (observed 44 s; can exceed the old 3-min window under load → the entry had
// expired → the row dispatched a second time). create_time does NOT move with
// flush lag — for the SAME message it is always ≤ the dispatch stamp — so this
// check is immune to how late the row lands. A genuine LATER repeat carries a
// create_time well past the dispatch stamp, so it still falls through and
// dispatches (preserving the "2" → reply → "2" case). cleanupRecent's 30-min
// GC bounds memory; the timestamp gate, not the GC window, decides matches.
export function consumeByCreateTime(
  map: Map<string, RecentEntry[]>,
  key: string,
  text: string,
  msgCreateTimeMs: number,
  epsilonMs: number = A11Y_TS_EPSILON_MS,
): boolean {
  const arr = map.get(key);
  if (!arr) return false;
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    if (msgCreateTimeMs <= e.ts + epsilonMs && bubblesMatch(e.text, text)) {
      arr.splice(i, 1);
      if (arr.length === 0) map.delete(key);
      else map.set(key, arr);
      return true;
    }
  }
  return false;
}

// Record a bot outbound text so the a11y fast-path won't read its own bubble
// back as a new inbound message. MUST be called by every outbound text path
// (the monitor's inline reply AND OpenClaw's async outbound adapter), keyed by
// the destination wxid.
//
// CRITICAL ORDERING: call this BEFORE awaiting the send, not after. Since
// agent-server commit b03369e (2026-05-25) the rust send_to_frame sleeps
// 500 ms post-Return to verify the bubble landed via a11y — meaning the
// bubble is rendered (and visible to the TS-side fast-path a11y poll) well
// before the send promise resolves. Recording after the await leaves a
// guaranteed ~500 ms window where recentlySentReplies is empty and the bot's
// own bubble gets dispatched back as a fresh inbound (= self-echo loop).
// On send failure, callers should clearOutboundText to revert this entry so
// it doesn't suppress a hypothetical exactly-matching user message for 30 min.
export function noteOutboundText(chatId: string, text: string): void {
  if (!text) return;
  const norm = normalizeBubbleText(text);
  recordRecent(recentlySentReplies, chatId, norm);
  // Reseat the fast-path marker onto the bot's own bubble so the next a11y
  // poll treats it as already-seen rather than a fresh inbound message. No
  // eligibleLen: caller doesn't know it, so the next-tick lookup falls back
  // to backwards text search (which works fine for the unique bot text).
  a11yChatBottom.set(chatId, { text: norm });
}

// Revert the recentlySentReplies entry seeded by a prior noteOutboundText
// call when the send turned out to fail. Without this, a failed send leaves
// a 30-min ghost entry that would suppress a legitimate user message whose
// text happens to match the unsent bot reply. The marker is left alone:
// the next a11y poll will marker-miss and recover via the usual paths.
export function clearOutboundText(chatId: string, text: string): void {
  if (!text) return;
  const norm = normalizeBubbleText(text);
  consumeRecent(recentlySentReplies, chatId, norm);
}
