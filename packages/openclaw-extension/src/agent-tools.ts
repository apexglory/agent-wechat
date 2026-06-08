import type { ResolvedWeChatAccount } from "./types.js";
import { WeChatClient, type ReceivePaymentResult } from "@apexglory/agent-wechat2-shared";
import { runSerializedWeChatOperation } from "./operation-queue.ts";

// Receiving a transfer drives a single-shot UI plan in agent-server: it clicks
// the transfer bubble EXACTLY ONCE per HTTP call and never re-clicks within a
// run — ClickingReceive only waits for the accept dialog, then fast-fails to
// release the global UI mutex (see receive_transfer.rs). So when the click is
// ineffective (bubble was off-screen, stale bounds, missed hit, WCDB hadn't
// surfaced the receipt yet) the ONLY way to re-click is a fresh call. That
// fresh call used to come solely from the agent deciding to retry — unreliable
// on a money path, so a transient miss could silently leave the money unclaimed
// (observed 2026-06-04: 小水's ¥3.90 received ~8h late). Retry automatically
// here instead: each attempt is a fresh HTTP call (so agent-server re-opens the
// chat and re-clicks the bubble) with the UI mutex released in between.
const RECEIVE_TRANSFER_MAX_ATTEMPTS = 3;
const RECEIVE_TRANSFER_RETRY_DELAY_MS = 1500;

// Outcomes a re-click can't fix — stop immediately rather than burn attempts.
// (success is handled separately.) Everything else — TRANSFER_NOT_RECEIVED, the
// plan getting stuck ("No action selected" / "Max steps reached"), or any
// unknown error — is treated as a transient on-screen failure worth re-clicking.
const TERMINAL_RECEIVE_ERRORS = new Set([
  "TRANSFER_NOT_FOUND", // message isn't in the chat — re-clicking finds nothing
  "MESSAGE_IS_NOT_TRANSFER", // wrong message kind
  "TRANSFER_NOT_RECEIVABLE", // own outgoing transfer
  "NOT_LOGGED_IN",
  "No session available",
]);

function isTerminalReceiveResult(result: ReceivePaymentResult): boolean {
  // agent-server short-circuits on is_received before re-running the plan, so a
  // retry after a real (but mis-reported) success is safe — it returns success
  // without a second click. We still stop on success here to avoid the delay.
  return result.success || TERMINAL_RECEIVE_ERRORS.has(result.error ?? "");
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function createClient(account: ResolvedWeChatAccount) {
  return new WeChatClient({
    baseUrl: account.serverUrl,
    token: account.token,
  });
}

function normalizeChatId(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const chatId = raw.replace(/^wechat:/i, "").trim();
  return chatId || null;
}

export function createWeChatLoginTool(account: ResolvedWeChatAccount) {
  const client = createClient(account);

  return {
    label: "WeChat Login",
    name: "wechat_login",
    description:
      "Check WeChat login status, start a login session, or log out. Calling start again returns the latest state from the existing session. When start returns qrData, generate a QR code image from it and show it to the user so they can scan it with their phone.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "logout", "status"],
        },
        force: {
          type: "boolean",
          description:
            "Log in with a new account (shows QR code even if already logged in)",
        },
        timeoutMs: { type: "number" },
      },
      required: ["action"],
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const args = params as Record<string, unknown>;
      const action = args.action as "start" | "logout" | "status";
      const force = args.force as boolean | undefined;
      const timeoutMs = args.timeoutMs as number | undefined;

      switch (action) {
        case "status": {
          try {
            const auth = await client.authStatus();
            const text = auth.status === "logged_in"
              ? `WeChat is logged in${auth.loggedInUser ? ` as ${auth.loggedInUser}` : ""}.`
              : `WeChat status: ${auth.status.replace(/_/g, " ")}.`;
            return {
              content: [{ type: "text" as const, text }],
              details: auth,
            };
          } catch (err) {
            const text = `Failed to check WeChat status: ${err instanceof Error ? err.message : String(err)}`;
            return {
              content: [{ type: "text" as const, text }],
              details: { error: true },
            };
          }
        }

        case "start": {
          const { getActiveLoginState, loginStart } = await import("./login.js");

          // Check for existing active login session
          const existing = getActiveLoginState(account.accountId);
          if (existing.active && !force) {
            if (existing.done && existing.connected) {
              return {
                content: [
                  { type: "text" as const, text: "Login successful." },
                ],
                details: { state: "done", connected: true },
              };
            }
            if (existing.done) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      existing.error ??
                      existing.message ??
                      "Login session ended.",
                  },
                ],
                details: {
                  state: "done",
                  connected: false,
                  error: existing.error,
                },
              };
            }
            // Still in progress — return cached state
            const parts: string[] = [];
            if (existing.message) parts.push(existing.message);
            if (existing.qrData)
              parts.push(`QR data: ${existing.qrData}`);
            return {
              content: [
                {
                  type: "text" as const,
                  text: parts.join("\n") || "Login in progress...",
                },
              ],
              details: {
                state: existing.qrData ? "qr" : "waiting",
                qrData: existing.qrData,
              },
            };
          }

          // Start a new login session
          try {
            const result = await loginStart(client, account.accountId, {
              timeoutMs,
              force,
            });
            // After loginStart resolves, check state for qrData
            const state = getActiveLoginState(account.accountId);
            if (state.qrData) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `${result.message}\nQR data: ${state.qrData}`,
                  },
                ],
                details: { state: "qr", qrData: state.qrData },
              };
            }
            return {
              content: [
                { type: "text" as const, text: result.message },
              ],
              details: { state: "waiting" },
            };
          } catch (err) {
            const text = `Failed to start WeChat login: ${err instanceof Error ? err.message : String(err)}`;
            return {
              content: [{ type: "text" as const, text }],
              details: { error: true },
            };
          }
        }

        case "logout": {
          try {
            const result = await client.logout();
            const text = result.success
              ? "WeChat logged out successfully."
              : `WeChat logout failed${result.error ? `: ${result.error}` : ""}.`;
            return {
              content: [{ type: "text" as const, text }],
              details: result,
            };
          } catch (err) {
            const text = `Failed to log out of WeChat: ${err instanceof Error ? err.message : String(err)}`;
            return {
              content: [{ type: "text" as const, text }],
              details: { error: true },
            };
          }
        }
      }
    },
  };
}

export function createWeChatReceiveTransferTool(account: ResolvedWeChatAccount) {
  const client = createClient(account);

  return {
    label: "WeChat Transfer",
    name: "wechat_receive_transfer",
    description:
      "Receive an incoming WeChat transfer in a chat. Use this when the current WeChat message is an unreceived transfer. Prefer passing the localId from the transfer message when available. If localId or transactionId are omitted, the latest receivable transfer in the chat is used.",
    parameters: {
      type: "object",
      properties: {
        chatId: {
          type: "string",
          description:
            "WeChat chat ID for the transfer, for example a wxid, a contact username, or a wechat: prefixed chat target from the current conversation context.",
        },
        localId: {
          type: "number",
          description:
            "Optional local message ID for the exact transfer to receive. Prefer the localId shown in the current transfer message when available.",
        },
        transactionId: {
          type: "string",
          description:
            "Optional transfer transaction ID. Use this when localId is unavailable.",
        },
      },
      required: ["chatId"],
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const args = params as Record<string, unknown>;
      const chatId = normalizeChatId(args.chatId);
      const localId = typeof args.localId === "number"
        ? args.localId
        : undefined;
      const transactionId = typeof args.transactionId === "string" &&
          args.transactionId.trim()
        ? args.transactionId.trim()
        : undefined;

      if (!chatId) {
        return {
          content: [{
            type: "text" as const,
            text: "Failed to receive the WeChat transfer: chatId is required.",
          }],
          details: { error: true, reason: "missing_chat_id" },
        };
      }

      try {
        const result = await runSerializedWeChatOperation(
          account.accountId,
          chatId,
          `receive transfer in ${chatId}`,
          async () => {
            let last: ReceivePaymentResult | undefined;
            for (
              let attempt = 1;
              attempt <= RECEIVE_TRANSFER_MAX_ATTEMPTS;
              attempt++
            ) {
              last = await client.receiveTransfer(chatId, transactionId, localId);
              if (isTerminalReceiveResult(last)) {
                return last;
              }
              if (attempt < RECEIVE_TRANSFER_MAX_ATTEMPTS) {
                console.warn(
                  `[wechat:${account.accountId}] receive transfer in ${chatId} not received ` +
                    `(attempt ${attempt}/${RECEIVE_TRANSFER_MAX_ATTEMPTS}, error=${last.error ?? "unknown"}); ` +
                    `re-clicking the transfer bubble`,
                );
                await sleep(RECEIVE_TRANSFER_RETRY_DELAY_MS);
              }
            }
            // Non-null: the loop runs at least once (MAX_ATTEMPTS >= 1).
            return last as ReceivePaymentResult;
          },
        );
        const amount = result.amountText ? ` ${result.amountText}` : "";
        const details = [
          `Received the WeChat transfer${amount} in ${chatId}.`,
          result.localId != null ? `Local ID: ${result.localId}` : undefined,
          result.transactionId
            ? `Transaction ID: ${result.transactionId}`
            : undefined,
          result.transferId ? `Transfer ID: ${result.transferId}` : undefined,
          result.receivedAt ? `Received at: ${result.receivedAt}` : undefined,
        ].filter(Boolean);

        if (result.success) {
          return {
            content: [{ type: "text" as const, text: details.join("\n") }],
            details: result,
          };
        }

        const failureText = `Failed to receive the WeChat transfer in ${chatId}: ${result.error ?? "Unknown error"}.`;
        return {
          content: [{ type: "text" as const, text: failureText }],
          details: result,
        };
      } catch (err) {
        const text = `Failed to receive the WeChat transfer in ${chatId}: ${err instanceof Error ? err.message : String(err)}`;
        return {
          content: [{ type: "text" as const, text }],
          details: { error: true },
        };
      }
    },
  };
}
