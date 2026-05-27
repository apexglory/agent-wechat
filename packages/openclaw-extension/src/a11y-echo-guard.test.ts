import { test } from "node:test";
import assert from "node:assert/strict";
import {
  a11yChatBottom,
  a11yDispatchedContent,
  a11yPendingDbConfirm,
  consumeRecent,
  hasUnconsumedEntries,
  noteOutboundText,
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
