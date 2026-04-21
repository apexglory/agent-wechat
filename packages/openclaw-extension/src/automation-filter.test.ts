import test from "node:test";
import assert from "node:assert/strict";
import {
  canProcessMessageWithoutOpening,
  isAutomationIgnoredChatId,
  requiresChatOpenForMessages,
} from "./automation-filter.ts";

test("isAutomationIgnoredChatId filters system and official chats", () => {
  assert.equal(isAutomationIgnoredChatId("newsapp"), true);
  assert.equal(isAutomationIgnoredChatId("gh_78dc74638eaa"), true);
  assert.equal(isAutomationIgnoredChatId("brandservicesessionholder"), true);
  assert.equal(isAutomationIgnoredChatId("wxid_123"), false);
  assert.equal(isAutomationIgnoredChatId("room@chatroom"), false);
});

test("canProcessMessageWithoutOpening only allows text messages", () => {
  assert.equal(canProcessMessageWithoutOpening({ kind: "text" }), true);
  assert.equal(canProcessMessageWithoutOpening({ kind: "app" }), false);
  assert.equal(canProcessMessageWithoutOpening({ kind: "transfer" }), false);
  assert.equal(canProcessMessageWithoutOpening({ kind: "image" }), false);
});

test("requiresChatOpenForMessages opens whenever any non-text message is present", () => {
  assert.equal(requiresChatOpenForMessages([{ kind: "text" }]), false);
  assert.equal(
    requiresChatOpenForMessages([{ kind: "text" }, { kind: "transfer" }]),
    true,
  );
  assert.equal(
    requiresChatOpenForMessages([{ kind: "reply" }, { kind: "text" }]),
    true,
  );
});
