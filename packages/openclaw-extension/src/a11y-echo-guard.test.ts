import { test } from "node:test";
import assert from "node:assert/strict";
import {
  a11yChatBottom,
  a11yDispatchedContent,
  consumeRecent,
  noteOutboundText,
  recentContains,
  recentlySentReplies,
  recordRecent,
} from "./a11y-echo-guard.ts";

test("noteOutboundText reseats the marker and records the reply", () => {
  const wxid = "wxid_test_note";
  noteOutboundText(wxid, "订单状态还是已支付\n ");
  // Marker normalized (whitespace collapsed) so the next a11y read matches.
  assert.equal(a11yChatBottom.get(wxid), "订单状态还是已支付");
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
