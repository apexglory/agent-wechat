import test from "node:test";
import assert from "node:assert/strict";
import {
  findInsertionIndexForOperation,
  runSerializedWeChatOperation,
} from "./operation-queue.ts";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

test("findInsertionIndexForOperation keeps matching operations adjacent", () => {
  assert.equal(findInsertionIndexForOperation(["2", "3", "4"], "1", "1"), 0);
  assert.equal(findInsertionIndexForOperation(["1", "1", "2"], "1", "1"), 2);
  assert.equal(findInsertionIndexForOperation(["2", "1", "1", "3"], undefined, "1"), 3);
  assert.equal(findInsertionIndexForOperation(["2", "3", "4"], undefined, "1"), 3);
});

test("runSerializedWeChatOperation inserts matching work right after the active chat", async () => {
  const firstRelease = createDeferred<void>();
  const started: string[] = [];

  const first = runSerializedWeChatOperation(
    "queue-test",
    "1",
    "first chat 1",
    async () => {
      started.push("1a");
      await firstRelease.promise;
      return "1a";
    },
  );

  const second = runSerializedWeChatOperation(
    "queue-test",
    "2",
    "chat 2",
    async () => {
      started.push("2");
      return "2";
    },
  );

  const third = runSerializedWeChatOperation(
    "queue-test",
    "3",
    "chat 3",
    async () => {
      started.push("3");
      return "3";
    },
  );

  const fourth = runSerializedWeChatOperation(
    "queue-test",
    "1",
    "second chat 1",
    async () => {
      started.push("1b");
      return "1b";
    },
  );

  assert.deepEqual(started, ["1a"]);

  firstRelease.resolve();

  const results = await Promise.all([first, second, third, fourth]);
  assert.deepEqual(results, ["1a", "2", "3", "1b"]);
  assert.deepEqual(started, ["1a", "1b", "2", "3"]);
});

test("runSerializedWeChatOperation keeps a short window before switching chats", async () => {
  const firstRelease = createDeferred<void>();
  const started: string[] = [];

  const first = runSerializedWeChatOperation(
    "queue-switch-test",
    "1",
    "first chat 1",
    async () => {
      started.push("1a");
      await firstRelease.promise;
      return "1a";
    },
  );

  const second = runSerializedWeChatOperation(
    "queue-switch-test",
    "2",
    "chat 2",
    async () => {
      started.push("2");
      return "2";
    },
  );

  const third = runSerializedWeChatOperation(
    "queue-switch-test",
    "3",
    "chat 3",
    async () => {
      started.push("3");
      return "3";
    },
  );

  const fourth = new Promise<string>((resolve, reject) => {
    void first.then(() => {
      void runSerializedWeChatOperation(
        "queue-switch-test",
        "1",
        "late chat 1",
        async () => {
          started.push("1b");
          return "1b";
        },
      ).then(resolve, reject);
    }, reject);
  });

  firstRelease.resolve();

  const results = await Promise.all([first, second, third, fourth]);
  assert.deepEqual(results, ["1a", "2", "3", "1b"]);
  assert.deepEqual(started, ["1a", "1b", "2", "3"]);
});
