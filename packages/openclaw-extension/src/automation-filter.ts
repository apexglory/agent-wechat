import type { Message } from "@agent-wechat/shared";

// Keep this list aligned with the system/internal usernames filtered by the Rust contact API.
// These chats are not meaningful automation targets and should never be opened by the monitor.
const SYSTEM_CHAT_IDS = new Set([
  "qmessage",
  "floatbottle",
  "medianote",
  "notifymessage",
  "weixin",
  "fmessage",
  "filehelper",
  "newsapp",
  "tmessage",
  "mphelper",
  "qqmail",
  "weixingongzhong",
  "qqsafe",
  "exmail_tool",
  "lbsapp",
  "pc_qq",
  "brandservicesessionholder",
]);

export function isAutomationIgnoredChatId(chatId: string): boolean {
  return chatId.startsWith("gh_") || SYSTEM_CHAT_IDS.has(chatId);
}

export function canProcessMessageWithoutOpening(msg: Pick<Message, "kind">): boolean {
  return msg.kind === "text";
}

export function requiresChatOpenForMessages(
  messages: Array<Pick<Message, "kind">>,
): boolean {
  return messages.some((msg) => !canProcessMessageWithoutOpening(msg));
}
