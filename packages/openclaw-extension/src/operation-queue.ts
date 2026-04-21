type Logger = { info?: (...args: any[]) => void; error?: (...args: any[]) => void };

const OPERATION_SWITCH_COALESCE_MS = 0;

type QueueEntry = {
  operationId?: string;
  label: string;
  execute: () => Promise<void>;
  log?: Logger;
};

type AccountQueue = {
  activeOperationId?: string;
  anchorOperationId?: string;
  pending: QueueEntry[];
  running: boolean;
};

const accountQueues = new Map<string, AccountQueue>();

function normalizeOperationId(operationId: string | null | undefined): string | undefined {
  if (typeof operationId !== "string") {
    return undefined;
  }
  const normalized = operationId.trim();
  return normalized || undefined;
}

export function findInsertionIndexForOperation(
  pendingOperationIds: ReadonlyArray<string | undefined>,
  anchorOperationId: string | undefined,
  operationId: string | undefined,
): number {
  if (!operationId) {
    return pendingOperationIds.length;
  }

  if (anchorOperationId === operationId) {
    let index = 0;
    while (index < pendingOperationIds.length && pendingOperationIds[index] === operationId) {
      index += 1;
    }
    return index;
  }

  for (let index = 0; index < pendingOperationIds.length; index += 1) {
    if (pendingOperationIds[index] !== operationId) {
      continue;
    }

    let insertAt = index + 1;
    while (insertAt < pendingOperationIds.length && pendingOperationIds[insertAt] === operationId) {
      insertAt += 1;
    }
    return insertAt;
  }

  return pendingOperationIds.length;
}

function getOrCreateAccountQueue(accountId: string): AccountQueue {
  const existing = accountQueues.get(accountId);
  if (existing) {
    return existing;
  }

  const created: AccountQueue = {
    activeOperationId: undefined,
    anchorOperationId: undefined,
    pending: [],
    running: false,
  };
  accountQueues.set(accountId, created);
  return created;
}

function enqueueOperation(accountQueue: AccountQueue, entry: QueueEntry): void {
  const insertAt = findInsertionIndexForOperation(
    accountQueue.pending.map((pendingEntry) => pendingEntry.operationId),
    accountQueue.activeOperationId ?? accountQueue.anchorOperationId,
    entry.operationId,
  );
  accountQueue.pending.splice(insertAt, 0, entry);
}

async function waitForMatchingOperationsToArrive(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, OPERATION_SWITCH_COALESCE_MS);
  });
}

async function drainAccountQueue(accountId: string, accountQueue: AccountQueue): Promise<void> {
  while (accountQueue.pending.length > 0) {
    const entry = accountQueue.pending.shift();
    if (!entry) {
      break;
    }

    accountQueue.activeOperationId = entry.operationId;
    accountQueue.anchorOperationId = entry.operationId;
    entry.log?.info?.(`[wechat:${accountId}] Queue start: ${entry.label}`);

    try {
      await entry.execute();
    } finally {
      entry.log?.info?.(`[wechat:${accountId}] Queue end: ${entry.label}`);
      accountQueue.activeOperationId = undefined;
    }

    const nextOperationId = accountQueue.pending[0]?.operationId;
    if (
      accountQueue.anchorOperationId &&
      nextOperationId &&
      nextOperationId !== accountQueue.anchorOperationId
    ) {
      await waitForMatchingOperationsToArrive();
    }
  }

  accountQueue.running = false;
  accountQueue.anchorOperationId = undefined;
  if (accountQueue.pending.length === 0 && accountQueue.activeOperationId == null) {
    accountQueues.delete(accountId);
  }
}

function ensureDrainStarted(accountId: string, accountQueue: AccountQueue): void {
  if (accountQueue.running) {
    return;
  }

  accountQueue.running = true;
  void drainAccountQueue(accountId, accountQueue);
}

export async function runSerializedWeChatOperation<T>(
  accountId: string,
  operationId: string | null | undefined,
  label: string,
  work: () => Promise<T>,
  log?: Logger,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const accountQueue = getOrCreateAccountQueue(accountId);
    enqueueOperation(accountQueue, {
      operationId: normalizeOperationId(operationId),
      label,
      execute: async () => {
        try {
          resolve(await work());
        } catch (error) {
          reject(error);
        }
      },
      log,
    });
    ensureDrainStarted(accountId, accountQueue);
  });
}
