import { WeChatClient } from "@apexglory/agent-wechat2-shared";
import type { LoginSubscriptionEvent } from "@apexglory/agent-wechat2-shared";

type ActiveLogin = {
  accountId: string;
  handle: { close: () => void };
  startedAt: number;
  qrData?: string;
  qrDataUrl?: string;
  message?: string;
  connected: boolean;
  error?: string;
  done: boolean;
  resolveWait?: (result: { connected: boolean; message: string }) => void;
};

const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const activeLogins = new Map<string, ActiveLogin>();

function cleanupStale() {
  const now = Date.now();
  for (const [key, login] of activeLogins) {
    if (now - login.startedAt > ACTIVE_LOGIN_TTL_MS) {
      login.handle.close();
      activeLogins.delete(key);
    }
  }
}

/**
 * Start a login session for the two-phase gateway flow.
 * Opens a WebSocket, waits for the first actionable event (qr, phone_confirm,
 * login_success, or error), then returns the initial result.
 * The WebSocket is stashed so loginWait() can continue reading events.
 */
export function loginStart(
  client: WeChatClient,
  accountId: string,
  opts?: { timeoutMs?: number; force?: boolean },
): Promise<{ qrDataUrl?: string; message: string }> {
  cleanupStale();

  // Close any existing login for this account
  const existing = activeLogins.get(accountId);
  if (existing) {
    existing.handle.close();
    activeLogins.delete(accountId);
  }

  return new Promise((resolve, reject) => {
    let resolved = false;

    const login: ActiveLogin = {
      accountId,
      handle: null!,
      startedAt: Date.now(),
      connected: false,
      done: false,
    };

    const handle = client.loginSubscribe({
      timeoutMs: opts?.timeoutMs,
      newAccount: opts?.force,
      onEvent: (event) => {
        handleEvent(login, event);

        // Resolve the start promise on first actionable event
        if (!resolved) {
          switch (event.type) {
            case "qr":
              resolved = true;
              resolve({
                qrDataUrl: event.qrDataUrl,
                message: "Scan QR code with WeChat",
              });
              break;
            case "phone_confirm":
              resolved = true;
              resolve({
                message: event.message || "Confirm login on your phone",
              });
              break;
            case "login_success":
              resolved = true;
              resolve({
                message: "Already logged in",
              });
              break;
            case "error":
              resolved = true;
              reject(new Error(event.message));
              break;
            case "login_timeout":
              resolved = true;
              resolve({
                message: "Login timed out",
              });
              break;
          }
        }
      },
      onError: (err) => {
        login.error = err.message;
        login.done = true;
        if (!resolved) {
          resolved = true;
          reject(err);
        }
        // Resolve any pending wait
        login.resolveWait?.({ connected: false, message: err.message });
      },
      onClose: () => {
        login.done = true;
        if (!resolved) {
          resolved = true;
          reject(new Error("WebSocket closed before login completed"));
        }
        // Resolve any pending wait if not already done
        if (login.resolveWait) {
          login.resolveWait({
            connected: login.connected,
            message: login.error || (login.connected ? "Login successful" : "Connection closed"),
          });
        }
      },
    });

    login.handle = handle;
    activeLogins.set(accountId, login);
  });
}

/**
 * Wait for an in-progress login to complete (second phase of gateway flow).
 * Returns when login_success, login_timeout, or error is received.
 */
export function loginWait(
  accountId: string,
  _opts?: { timeoutMs?: number },
): Promise<{ connected: boolean; message: string }> {
  const login = activeLogins.get(accountId);
  if (!login) {
    return Promise.resolve({
      connected: false,
      message: "No active login session",
    });
  }

  // Already completed
  if (login.done) {
    activeLogins.delete(accountId);
    return Promise.resolve({
      connected: login.connected,
      message: login.error || (login.connected ? "Login successful" : "Login failed"),
    });
  }

  return new Promise((resolve) => {
    login.resolveWait = (result) => {
      activeLogins.delete(accountId);
      resolve(result);
    };
  });
}

/**
 * Get the current state of an active login session (if any).
 * Used by agent tools to poll without blocking.
 */
export function getActiveLoginState(accountId: string): {
  active: boolean;
  qrData?: string;
  message?: string;
  connected?: boolean;
  done?: boolean;
  error?: string;
} {
  cleanupStale();
  const login = activeLogins.get(accountId);
  if (!login) return { active: false };
  if (login.done) {
    activeLogins.delete(accountId);
  }
  return {
    active: true,
    qrData: login.qrData,
    message: login.message,
    connected: login.connected,
    done: login.done,
    error: login.error,
  };
}

/**
 * Cancel/reset any active login for the given account.
 */
export function loginReset(accountId: string): void {
  const login = activeLogins.get(accountId);
  if (login) {
    login.handle.close();
    activeLogins.delete(accountId);
  }
}

/**
 * Run a full terminal login flow. Calls onEvent for each login event,
 * resolves when login completes or fails.
 */
export function loginTerminal(
  client: WeChatClient,
  opts: {
    timeoutMs?: number;
    newAccount?: boolean;
    onEvent: (event: LoginSubscriptionEvent) => void;
  },
): Promise<{ connected: boolean; message: string }> {
  return new Promise((resolve, reject) => {
    const handle = client.loginSubscribe({
      timeoutMs: opts.timeoutMs,
      newAccount: opts.newAccount,
      onEvent: (event) => {
        opts.onEvent(event);

        switch (event.type) {
          case "login_success":
            handle.close();
            resolve({ connected: true, message: "Login successful" });
            break;
          case "login_timeout":
            handle.close();
            resolve({ connected: false, message: "Login timed out" });
            break;
          case "error":
            handle.close();
            resolve({ connected: false, message: event.message });
            break;
        }
      },
      onError: (err) => {
        reject(err);
      },
      onClose: () => {
        // If the WS closes without a terminal event, treat as failure
        resolve({ connected: false, message: "Connection closed" });
      },
    });
  });
}

function handleEvent(login: ActiveLogin, event: LoginSubscriptionEvent) {
  switch (event.type) {
    case "qr":
      login.qrData = event.qrData;
      login.qrDataUrl = event.qrDataUrl;
      login.message = "Scan QR code with WeChat";
      break;
    case "phone_confirm":
      login.message = event.message || "Confirm login on your phone";
      break;
    case "login_success":
      login.connected = true;
      login.done = true;
      login.message = "Login successful";
      login.resolveWait?.({ connected: true, message: "Login successful" });
      break;
    case "login_timeout":
      login.done = true;
      login.message = "Login timed out";
      login.resolveWait?.({ connected: false, message: "Login timed out" });
      break;
    case "error":
      login.error = event.message;
      login.done = true;
      login.resolveWait?.({ connected: false, message: event.message });
      break;
    case "status":
      login.message = event.message;
      break;
  }
}
