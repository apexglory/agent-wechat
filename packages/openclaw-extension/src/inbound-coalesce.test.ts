import test from "node:test";
import assert from "node:assert/strict";
import {
  enqueueCoalescedMessage,
  __testForceFlush,
  __testReset,
  __testPeek,
} from "./inbound-coalesce.ts";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test.beforeEach(() => {
  __testReset();
});

test("merges burst of 3 messages enqueued within the debounce window into a single dispatch", async () => {
  const dispatchedSegments: number[][] = [];
  const dispatchFn = async (segment: number[]) => {
    dispatchedSegments.push([...segment]);
    return true;
  };

  enqueueCoalescedMessage("sess-1", 1, dispatchFn, { debounceMs: 9999 });
  enqueueCoalescedMessage("sess-1", 2, dispatchFn, { debounceMs: 9999 });
  enqueueCoalescedMessage("sess-1", 3, dispatchFn, { debounceMs: 9999 });

  const peek = __testPeek("sess-1");
  assert.equal(peek?.pendingCount, 3);
  assert.equal(peek?.hasTimer, true);
  assert.equal(peek?.hasInflight, false);

  await __testForceFlush("sess-1", 9999);

  assert.equal(dispatchedSegments.length, 1, "should fire exactly one dispatch");
  assert.deepEqual(dispatchedSegments[0], [1, 2, 3], "should pass all 3 messages in order");
  assert.equal(__testPeek("sess-1"), null, "session state should be cleaned up");
});

test("messages arriving during an in-flight dispatch go into the next batch (no concurrency)", async () => {
  const dispatchedSegments: number[][] = [];
  const firstRelease = createDeferred<void>();
  let firstStarted = false;

  const dispatchFn = async (segment: number[]) => {
    dispatchedSegments.push([...segment]);
    if (!firstStarted) {
      firstStarted = true;
      await firstRelease.promise;
    }
    return true;
  };

  enqueueCoalescedMessage("sess-1", 1, dispatchFn, { debounceMs: 9999 });
  const flushPromise = __testForceFlush("sess-1", 9999);
  // Let the dispatch promise actually start
  await nextTick();
  assert.equal(__testPeek("sess-1")?.hasInflight, true, "first dispatch should be in flight");

  // Enqueue more messages while the first dispatch is blocked
  enqueueCoalescedMessage("sess-1", 2, dispatchFn, { debounceMs: 9999 });
  enqueueCoalescedMessage("sess-1", 3, dispatchFn, { debounceMs: 9999 });
  // Important: while a dispatch is in flight, the new enqueues must NOT
  // arm a debounce timer — runFlush is responsible for re-arming on
  // completion. Otherwise we'd race a parallel dispatch.
  const midPeek = __testPeek("sess-1");
  assert.equal(midPeek?.pendingCount, 2);
  assert.equal(midPeek?.hasInflight, true);
  assert.equal(midPeek?.hasTimer, false);

  // Release the first dispatch
  firstRelease.resolve();
  await flushPromise;
  // The in-flight finally block schedules a new debounce for the queued msgs
  await nextTick();
  await __testForceFlush("sess-1", 9999);

  assert.equal(dispatchedSegments.length, 2, "should fire two dispatches (not concurrent)");
  assert.deepEqual(dispatchedSegments[0], [1]);
  assert.deepEqual(dispatchedSegments[1], [2, 3]);
});

test("distinct session keys dispatch independently and in parallel", async () => {
  const order: string[] = [];
  const aRelease = createDeferred<void>();
  const bRelease = createDeferred<void>();

  enqueueCoalescedMessage(
    "sess-A",
    "a1",
    async (segment) => {
      order.push(`A-start:${segment.join(",")}`);
      await aRelease.promise;
      order.push(`A-end`);
      return true;
    },
    { debounceMs: 9999 },
  );
  enqueueCoalescedMessage(
    "sess-B",
    "b1",
    async (segment) => {
      order.push(`B-start:${segment.join(",")}`);
      await bRelease.promise;
      order.push(`B-end`);
      return true;
    },
    { debounceMs: 9999 },
  );

  const flushA = __testForceFlush("sess-A", 9999);
  const flushB = __testForceFlush("sess-B", 9999);
  await nextTick();

  // Both should be in flight simultaneously (no cross-session blocking)
  assert.ok(order.includes("A-start:a1"));
  assert.ok(order.includes("B-start:b1"));
  assert.equal(__testPeek("sess-A")?.hasInflight, true);
  assert.equal(__testPeek("sess-B")?.hasInflight, true);

  // Release B first — it should finish independently of A
  bRelease.resolve();
  await flushB;
  assert.ok(order.includes("B-end"));
  assert.equal(__testPeek("sess-B"), null, "B should be cleaned up");
  assert.equal(__testPeek("sess-A")?.hasInflight, true, "A still in flight");

  aRelease.resolve();
  await flushA;
  assert.equal(__testPeek("sess-A"), null);
});

test("dispatch throwing does not corrupt state — next batch still runs", async () => {
  let attempts = 0;
  const dispatchFn = async (segment: number[]) => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("simulated dispatch failure");
    }
    return true;
  };

  enqueueCoalescedMessage("sess-1", 1, dispatchFn, { debounceMs: 9999 });
  await __testForceFlush("sess-1", 9999);
  // After failure, session should be clean (the failed batch is gone)
  assert.equal(__testPeek("sess-1"), null);

  enqueueCoalescedMessage("sess-1", 2, dispatchFn, { debounceMs: 9999 });
  await __testForceFlush("sess-1", 9999);
  assert.equal(attempts, 2);
  assert.equal(__testPeek("sess-1"), null);
});

test("late-arriving messages during in-flight dispatch trigger a second flush automatically", async () => {
  const dispatched: number[][] = [];
  const firstRelease = createDeferred<void>();
  let firstStarted = false;
  const dispatchFn = async (segment: number[]) => {
    dispatched.push([...segment]);
    if (!firstStarted) {
      firstStarted = true;
      await firstRelease.promise;
    }
    return true;
  };

  enqueueCoalescedMessage("sess-1", 10, dispatchFn, { debounceMs: 1 });
  // Force the first flush so the dispatch is in-flight
  const flush1 = __testForceFlush("sess-1", 1);
  await nextTick();

  // Enqueue more while in-flight — these arm no timer (in-flight guard)
  enqueueCoalescedMessage("sess-1", 11, dispatchFn, { debounceMs: 1 });

  firstRelease.resolve();
  await flush1;

  // After in-flight finishes, runFlush should have armed a debounce for {11}.
  // Wait for the 1ms timer to fire and the resulting dispatch to settle.
  await new Promise<void>((resolve) => setTimeout(resolve, 30));

  assert.equal(dispatched.length, 2, "should fire exactly two dispatches");
  assert.deepEqual(dispatched[0], [10]);
  assert.deepEqual(dispatched[1], [11]);
  assert.equal(__testPeek("sess-1"), null);
});

test("most recent dispatchFn wins when multiple enqueue calls share a debounce window", async () => {
  const calls: string[] = [];
  const fnOld = async (segment: number[]) => {
    calls.push(`OLD:${segment.join(",")}`);
    return true;
  };
  const fnNew = async (segment: number[]) => {
    calls.push(`NEW:${segment.join(",")}`);
    return true;
  };

  enqueueCoalescedMessage("sess-1", 1, fnOld, { debounceMs: 9999 });
  enqueueCoalescedMessage("sess-1", 2, fnNew, { debounceMs: 9999 });

  await __testForceFlush("sess-1", 9999);
  assert.deepEqual(calls, ["NEW:1,2"]);
});
