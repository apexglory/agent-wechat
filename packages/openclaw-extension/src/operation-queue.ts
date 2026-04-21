const queueTails = new Map<string, Promise<void>>();

type Logger = { info?: (...args: any[]) => void; error?: (...args: any[]) => void };

export async function runSerializedWeChatOperation<T>(
  accountId: string,
  label: string,
  work: () => Promise<T>,
  log?: Logger,
): Promise<T> {
  const prev = queueTails.get(accountId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    log?.info?.(`[wechat:${accountId}] Queue start: ${label}`);
    try {
      return await work();
    } finally {
      log?.info?.(`[wechat:${accountId}] Queue end: ${label}`);
    }
  });

  const settled = run.then(() => undefined, () => undefined);
  queueTails.set(accountId, settled);

  try {
    return await run;
  } finally {
    if (queueTails.get(accountId) === settled) {
      queueTails.delete(accountId);
    }
  }
}
