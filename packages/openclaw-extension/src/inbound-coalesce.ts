// Per-session inbound debounce + serialization for WeChat agent dispatch.
//
// Problem this solves: users on WeChat naturally send several messages in
// quick succession ("不需要" / "不行" / "再看看别的"). Today every inbound
// message triggers its own agent turn — and because the agent runs are not
// strictly serialized end-to-end at the OpenClaw runtime layer, a slow turn
// for msg N can finish *after* the fast turn for msg N+1, scrambling reply
// order. Even when ordering holds, three turns for three lines wastes tokens
// and produces three disconnected replies instead of one informed answer.
//
// Strategy:
//   - Per session (account + chat) we hold a small pending list of messages.
//   - When a new message is enqueued we (re)arm a debounce timer.
//   - When the timer fires we drain the pending list as ONE merged segment
//     and call the dispatchSegment closure provided by the caller.
//   - Only one dispatch per session may be in flight at a time. If new
//     messages arrive during dispatch they queue into a fresh pending list
//     and a new debounce window starts as soon as the dispatch finishes.
//
// Important invariant: messages enqueued together must be presented to the
// agent as the *current turn* (multiple lines), NOT as untrusted history.
// Treating them as history is what the buildSegments comment in monitor.ts
// warns against (2026-05-21 customer-service漏单 incident). The merged
// segment is rendered with a new "burst" marker that explicitly tells the
// agent SOP "these N lines are all part of the current message".
//
// This module is intentionally agnostic to the actual ProcessedMessage shape
// — it deals in a generic <T> so it can be unit-tested without pulling in
// the WeChat runtime. monitor.ts binds T = ProcessedMessage at the call
// site.

type Logger = {
  info?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
};

type DispatchFn<T> = (segment: T[]) => Promise<boolean>;

// Per-message callback fired once the merged dispatch that carried this
// message settles, with the dispatch outcome (true = dispatchSegment returned
// true). This is what lets callers commit their "message handled" bookkeeping
// (lastSeenId advance, a11y dedup suppress-ring) ONLY after the async dispatch
// actually succeeds — instead of speculatively at enqueue time, which silently
// drops the message if the dispatch later fails or hangs. Fires for EVERY
// drained message regardless of which closure won the flush, so cross-path
// merges (a11y fast-path + DB catch-up sharing a session key) each settle
// their own bookkeeping correctly.
type SettleFn = (ok: boolean) => void;

interface PendingItem<T> {
  value: T;
  onSettled?: SettleFn;
}

interface SessionState<T> {
  pending: PendingItem<T>[];
  debounceTimer: ReturnType<typeof setTimeout> | undefined;
  inflightDispatch: Promise<boolean> | undefined;
  // The dispatch closure captures the caller's context (client, chat, cfg
  // snapshot, etc.). Each enqueue overwrites it so the next flush uses the
  // freshest context — config can hot-reload between polls and we want the
  // latest policy / account snapshot when the flush eventually fires.
  latestDispatchFn: DispatchFn<T> | undefined;
}

const sessions = new Map<string, SessionState<any>>();

function getOrCreateState<T>(sessionKey: string): SessionState<T> {
  let state = sessions.get(sessionKey) as SessionState<T> | undefined;
  if (!state) {
    state = {
      pending: [],
      debounceTimer: undefined,
      inflightDispatch: undefined,
      latestDispatchFn: undefined,
    };
    sessions.set(sessionKey, state);
  }
  return state;
}

function maybeCleanup(sessionKey: string): void {
  const state = sessions.get(sessionKey);
  if (!state) return;
  if (
    state.pending.length === 0 &&
    !state.debounceTimer &&
    !state.inflightDispatch
  ) {
    sessions.delete(sessionKey);
  }
}

function armDebounceTimer<T>(
  sessionKey: string,
  debounceMs: number,
  log: Logger | undefined,
): void {
  const state = sessions.get(sessionKey) as SessionState<T> | undefined;
  if (!state) return;
  // While a dispatch is in flight we do NOT arm a new timer — runFlush will
  // re-arm one when the in-flight call settles.
  if (state.inflightDispatch) return;

  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer);
  }
  state.debounceTimer = setTimeout(() => {
    const s = sessions.get(sessionKey) as SessionState<T> | undefined;
    if (!s) return;
    s.debounceTimer = undefined;
    void runFlush<T>(sessionKey, debounceMs, log);
  }, debounceMs);
}

async function runFlush<T>(
  sessionKey: string,
  debounceMs: number,
  log: Logger | undefined,
): Promise<void> {
  const state = sessions.get(sessionKey) as SessionState<T> | undefined;
  if (!state) return;
  if (state.inflightDispatch) return; // re-entry guard

  // Drain everything currently pending. New messages arriving during the
  // dispatch will accumulate in the (now empty) pending list and get a
  // fresh debounce window in the finally block below.
  const drained = state.pending;
  const dispatchFn = state.latestDispatchFn;
  state.pending = [];
  state.latestDispatchFn = undefined;

  if (!dispatchFn || drained.length === 0) {
    maybeCleanup(sessionKey);
    return;
  }

  const segment = drained.map((d) => d.value);

  if (segment.length > 1) {
    log?.info?.(
      `[inbound-coalesce] ${sessionKey}: flushing burst of ${segment.length} messages as one turn`,
    );
  }

  const work: Promise<boolean> = (async () => {
    try {
      return await dispatchFn(segment);
    } catch (err) {
      log?.error?.(
        `[inbound-coalesce] ${sessionKey}: dispatch threw: ${String(err)}`,
      );
      return false;
    }
  })();
  state.inflightDispatch = work;

  let ok = false;
  try {
    ok = await work;
  } finally {
    state.inflightDispatch = undefined;
    // Settle every drained message with the dispatch outcome BEFORE re-arming,
    // so callers commit/roll-back their bookkeeping (lastSeenId, dedup rings)
    // exactly once per message and in lockstep with the real result. A settler
    // that throws must not abort the rest or leave the session wedged.
    for (const d of drained) {
      try {
        d.onSettled?.(ok);
      } catch (err) {
        log?.error?.(
          `[inbound-coalesce] ${sessionKey}: onSettled threw: ${String(err)}`,
        );
      }
    }
    // New messages may have arrived while we were dispatching. Start a new
    // debounce window so they get a chance to coalesce too.
    if (state.pending.length > 0) {
      armDebounceTimer<T>(sessionKey, debounceMs, log);
    } else {
      maybeCleanup(sessionKey);
    }
  }
}

export interface EnqueueOptions {
  debounceMs: number;
  log?: Logger;
}

/**
 * Push a single inbound message into the per-session coalesce queue.
 *
 * This is fire-and-forget — the actual dispatchFn is invoked asynchronously
 * once the debounce window closes and any prior dispatch for the same
 * session has settled. The caller must NOT depend on dispatch ordering
 * across distinct session keys.
 *
 * dispatchFn receives the merged segment of all messages collected during
 * one debounce window. The closure should capture whatever transient
 * context (client, chat, cfg snapshot, policy) it needs at enqueue time;
 * the most recent dispatchFn passed for a given session wins.
 *
 * onSettled (optional) fires once, with the dispatch outcome, after the merged
 * dispatch that carried THIS message settles — even if a later enqueue's
 * dispatchFn is the one that actually ran the flush. Use it to commit
 * per-message bookkeeping only on real success (see SettleFn).
 */
export function enqueueCoalescedMessage<T>(
  sessionKey: string,
  message: T,
  dispatchFn: DispatchFn<T>,
  opts: EnqueueOptions,
  onSettled?: SettleFn,
): void {
  const state = getOrCreateState<T>(sessionKey);
  state.pending.push({ value: message, onSettled });
  state.latestDispatchFn = dispatchFn;
  armDebounceTimer<T>(sessionKey, opts.debounceMs, opts.log);
}

// -------- Test helpers --------
// Exposed only so unit tests can run a deterministic flush instead of
// waiting for setTimeout to fire. Not part of the public runtime API.

export function __testForceFlush<T>(
  sessionKey: string,
  debounceMs: number,
  log?: Logger,
): Promise<void> {
  const state = sessions.get(sessionKey) as SessionState<T> | undefined;
  if (!state) return Promise.resolve();
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = undefined;
  }
  return runFlush<T>(sessionKey, debounceMs, log);
}

export function __testReset(): void {
  for (const state of sessions.values()) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
  }
  sessions.clear();
}

export function __testPeek(sessionKey: string): {
  pendingCount: number;
  hasTimer: boolean;
  hasInflight: boolean;
} | null {
  const state = sessions.get(sessionKey);
  if (!state) return null;
  return {
    pendingCount: state.pending.length,
    hasTimer: !!state.debounceTimer,
    hasInflight: !!state.inflightDispatch,
  };
}
