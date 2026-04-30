import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveWeChatAccount,
  resolveWeChatDisableBlockStreaming,
} from "./types.ts";

test("resolveWeChatDisableBlockStreaming mirrors blockStreaming", () => {
  assert.equal(resolveWeChatDisableBlockStreaming(true), false);
  assert.equal(resolveWeChatDisableBlockStreaming(false), true);
  assert.equal(resolveWeChatDisableBlockStreaming(undefined), undefined);
});

test("resolveWeChatAccount preserves blockStreaming", () => {
  const account = resolveWeChatAccount({
    channels: {
      wechat: {
        serverUrl: "http://localhost:6174",
        blockStreaming: true,
      },
    },
  });

  assert.ok(account);
  assert.equal(account.blockStreaming, true);
});
