// ============================================================
// A11y fast-path echo-guard state (shared across the extension).
//
// The a11y fast-path reads chat bubbles straight off the visible window's
// a11y tree and dispatches them as inbound messages. WeChat's a11y tree
// can't tell inbound from outbound, so the ONLY thing keeping the bot's own
// reply bubbles from being read back as fresh user messages is this state:
//
//   a11yChatBottom         — per-chat (wxid) high-water marker: the normalized
//                            text of the most recent visible bubble. Items
//                            below it on the next poll are the dispatch
//                            candidates; anything at-or-above (incl. the bot's
//                            own replies) is skipped.
//   recentlySentReplies    — ring of bot outbound texts per wxid; defense in
//                            depth against echoing a bot bubble if the marker
//                            reseat hasn't landed yet.
//   a11yDispatchedContent  — texts already dispatched via the fast-path, used
//                            by the DB catch-up loop to skip the same message
//                            once WCDB flushes it ~9s later.
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
export const a11yDispatchedContent = new Map<string, RecentEntry[]>(); // wxid -> normalized contents already dispatched via a11y
// Per-chat normalized text of the most recent visible bubble (bot's reply OR last dispatch).
// Items appearing below this marker on the next poll are the only candidates for dispatch.
export const a11yChatBottom = new Map<string, string>();

export function normalizeBubbleText(s: string): string {
  // WeChat tends to append "\n " to bubble labels; long bubbles are also
  // truncated in atspi. Collapse runs of whitespace to a single space so
  // recordings and a11y reads compare consistently.
  return s.replace(/\s+/g, " ").trim();
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

// Record a bot outbound text so the a11y fast-path won't read its own bubble
// back as a new inbound message. MUST be called by every outbound text path
// (the monitor's inline reply AND OpenClaw's async outbound adapter), keyed by
// the destination wxid.
export function noteOutboundText(chatId: string, text: string): void {
  if (!text) return;
  const norm = normalizeBubbleText(text);
  recordRecent(recentlySentReplies, chatId, norm);
  // Reseat the fast-path marker onto the bot's own bubble so the next a11y
  // poll treats it as already-seen rather than a fresh inbound message.
  a11yChatBottom.set(chatId, norm);
}
