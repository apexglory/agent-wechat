import { test } from "node:test";
import assert from "node:assert/strict";
import {
  a11yChatBottom,
  a11yDispatchedContent,
  a11yPendingDbConfirm,
  bubblesMatch,
  consumeByCreateTime,
  consumeRecent,
  hasUnconsumedEntries,
  matchesByCreateTime,
  noteOutboundText,
  normalizeBubbleText,
  recentContains,
  recentlySentReplies,
  recordRecent,
} from "./a11y-echo-guard.ts";

test("noteOutboundText reseats the marker and records the reply", () => {
  const wxid = "wxid_test_note";
  noteOutboundText(wxid, "订单状态还是已支付\n ");
  // Marker normalized (whitespace collapsed) so the next a11y read matches.
  assert.deepEqual(a11yChatBottom.get(wxid), { text: "订单状态还是已支付" });
  // recentlySentReplies guards the same text as a bot bubble.
  assert.equal(recentContains(recentlySentReplies, wxid, "订单状态还是已支付"), true);
});

test("noteOutboundText ignores empty text", () => {
  const wxid = "wxid_test_empty";
  noteOutboundText(wxid, "");
  assert.equal(a11yChatBottom.has(wxid), false);
});

test("consumeRecent suppresses exactly one occurrence (DB-race dedup)", () => {
  const wxid = "wxid_test_consume";
  recordRecent(a11yDispatchedContent, wxid, "我有20元券吗");
  // First DB row mirroring the a11y dispatch is skipped...
  assert.equal(consumeRecent(a11yDispatchedContent, wxid, "我有20元券吗"), true);
  // ...and a genuine later repeat of the same text is NOT dropped.
  assert.equal(consumeRecent(a11yDispatchedContent, wxid, "我有20元券吗"), false);
});

test("consumeRecent respects the time window", () => {
  const wxid = "wxid_test_window";
  recordRecent(a11yDispatchedContent, wxid, "hello world long enough");
  // Negative window → cutoff is in the future, so the fresh entry counts as
  // already expired → no match (and it is not consumed).
  assert.equal(consumeRecent(a11yDispatchedContent, wxid, "hello world long enough", -1), false);
  // Still present for a normal-window lookup.
  assert.equal(consumeRecent(a11yDispatchedContent, wxid, "hello world long enough", 60_000), true);
});

test("hasUnconsumedEntries reflects pending fast-path dispatches", () => {
  const wxid = "wxid_test_pending";
  // Empty map → no pending.
  assert.equal(hasUnconsumedEntries(a11yPendingDbConfirm, wxid), false);
  recordRecent(a11yPendingDbConfirm, wxid, "在么");
  assert.equal(hasUnconsumedEntries(a11yPendingDbConfirm, wxid), true);
  // Negative window expires every entry → false even though arr is non-empty.
  assert.equal(hasUnconsumedEntries(a11yPendingDbConfirm, wxid, -1), false);
  // consumeRecent removes the entry → false again.
  assert.equal(consumeRecent(a11yPendingDbConfirm, wxid, "在么", 60_000), true);
  assert.equal(hasUnconsumedEntries(a11yPendingDbConfirm, wxid), false);
});

test("consumeRecent on identical-text repeats suppresses exactly N rows (regression for fix #2)", () => {
  // Models the post-fix flow for the "user sends '在么' three times in a row"
  // scenario: the fast-path positional lookup correctly diffs each repeat into
  // a fresh candidate, recording one a11yDispatchedContent entry per
  // dispatched bubble. When WCDB later flushes all three Msg_* rows, each row
  // should consume exactly one entry — no more, no less — so all three are
  // suppressed (and a true fourth repeat after the window would dispatch).
  const wxid = "wxid_test_repeats";
  recordRecent(a11yDispatchedContent, wxid, "在么");
  recordRecent(a11yDispatchedContent, wxid, "在么");
  recordRecent(a11yDispatchedContent, wxid, "在么");
  assert.equal(consumeRecent(a11yDispatchedContent, wxid, "在么"), true);
  assert.equal(consumeRecent(a11yDispatchedContent, wxid, "在么"), true);
  assert.equal(consumeRecent(a11yDispatchedContent, wxid, "在么"), true);
  // Fourth DB row finds no entry → not suppressed (a genuine new "在么").
  assert.equal(consumeRecent(a11yDispatchedContent, wxid, "在么"), false);
});

test("normalizeBubbleText makes a11y/WCDB short text compare equal (A1)", () => {
  // a11y injects a zero-width space + trailing newline; WCDB content is clean.
  // Short text has NO prefix tolerance in bubblesMatch, so they must normalize
  // to byte-identical or the DB-race dedup misses → double dispatch of "饿了".
  const a11yRead = normalizeBubbleText("\u997f\u200b\u4e86\n ");
  const dbContent = normalizeBubbleText("饿了");
  assert.equal(a11yRead, "饿了");
  assert.equal(a11yRead, dbContent);
  assert.equal(bubblesMatch(a11yRead, dbContent), true);
  // NFC: composed vs decomposed Unicode forms normalize equal ("é").
  assert.equal(normalizeBubbleText("cafe\u0301"), normalizeBubbleText("caf\u00e9"));
});

test("consumeByCreateTime gates on WCDB create_time, immune to flush lag (A2)", () => {
  const wxid = "wxid_test_ctime";
  recordRecent(a11yDispatchedContent, wxid, "饿了");
  const ts = a11yDispatchedContent.get(wxid)![0]!.ts;
  // Same message: WCDB create_time is at/just-before the fast-path dispatch
  // stamp. Even if the row only surfaces minutes later (flush lag affects when
  // we SEE it, not create_time), it must still be suppressed.
  assert.equal(consumeByCreateTime(a11yDispatchedContent, wxid, "饿了", ts - 500), true);
  // A genuine later repeat (create_time well past the dispatch stamp) is NOT
  // suppressed...
  recordRecent(a11yDispatchedContent, wxid, "饿了");
  const ts2 = a11yDispatchedContent.get(wxid)![0]!.ts;
  assert.equal(consumeByCreateTime(a11yDispatchedContent, wxid, "饿了", ts2 + 60_000), false);
  // ...and the entry remains for its real (same-time) DB row.
  assert.equal(consumeByCreateTime(a11yDispatchedContent, wxid, "饿了", ts2), true);
});

test("matchesByCreateTime reports a match without consuming it (defer-until-confirmed)", () => {
  const wxid = "wxid_test_match";
  recordRecent(a11yPendingDbConfirm, wxid, "三杯奶茶");
  const ts = a11yPendingDbConfirm.get(wxid)![0]!.ts;

  // The landed DB row (create_time at/just-before the dispatch stamp) matches —
  // and matching MUST be repeatable across polls, so it does not remove the
  // entry the way consumeByCreateTime would.
  assert.equal(matchesByCreateTime(a11yPendingDbConfirm, wxid, "三杯奶茶", ts - 500), true);
  assert.equal(matchesByCreateTime(a11yPendingDbConfirm, wxid, "三杯奶茶", ts - 500), true);
  assert.equal(a11yPendingDbConfirm.get(wxid)?.length, 1, "entry survives repeated matches");

  // A genuine later repeat (create_time well past the dispatch stamp) does NOT
  // match, so it isn't deferred.
  assert.equal(matchesByCreateTime(a11yPendingDbConfirm, wxid, "三杯奶茶", ts + 60_000), false);
  // No entry at all → no match.
  assert.equal(matchesByCreateTime(a11yDispatchedContent, wxid, "三杯奶茶", ts), false);

  consumeRecent(a11yPendingDbConfirm, wxid, "三杯奶茶");
});
