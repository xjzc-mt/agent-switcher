interface QuitOptions {
  hasDrafts(): boolean;
  isDownloading(): boolean;
  confirm(): Promise<boolean>;
  cleanup(): Promise<void>;
  quit(): void;
  onError(error: Error): void;
  onWaiting?(waiting: boolean): void;
}

/** Drain existing account writes and active token-commit critical sections before quitting. */
export function createQuitGuard(options: QuitOptions) {
  const operations = new Set<Promise<unknown>>();
  let closing = false;
  let ready = false;
  let pending: Promise<void> | undefined;

  function track<T>(work: () => T | Promise<T>): Promise<T> {
    const operation = Promise.resolve().then(work);
    operations.add(operation);
    const finished = () => { operations.delete(operation); };
    void operation.then(finished, finished);
    return operation;
  }

  function run<T>(work: () => T | Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new Error('正在准备退出 AgentSwitcher，请稍后重试'));
    return track(work);
  }

  /** Used only for committing an already-rotated credential so mid-flight renewals never drop tokens. */
  function trackCritical<T>(work: () => T | Promise<T>): Promise<T> {
    if (ready) return Promise.reject(new Error('AgentSwitcher 已退出'));
    return track(work);
  }

  async function drainOperations(): Promise<void> {
    if (!operations.size) return;
    options.onWaiting?.(true);
    while (operations.size) await Promise.allSettled([...operations]);
    options.onWaiting?.(false);
  }

  function request(): Promise<void> {
    if (pending) return pending;
    if (ready) return Promise.resolve();
    closing = true;
    pending = (async () => {
      await drainOperations();
      if ((options.hasDrafts() || options.isDownloading()) && !await options.confirm()) return;
      await drainOperations();
      await options.cleanup();
      while (operations.size) await drainOperations();
      ready = true;
      options.quit();
    })().catch(error => {
      ready = false;
      options.onError(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => {
      if (!ready) closing = false;
      pending = undefined;
    });
    return pending;
  }

  return { run, trackCritical, request, isClosing: () => closing, canQuit: () => ready };
}
