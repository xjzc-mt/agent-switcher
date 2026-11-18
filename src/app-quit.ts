interface QuitOptions {
  hasDrafts(): boolean;
  isDownloading(): boolean;
  confirm(): Promise<boolean>;
  cleanup(): Promise<void>;
  quit(): void;
  onError(error: Error): void;
}

/** Drain existing account work before asking about any drafts it produced. */
export function createQuitGuard(options: QuitOptions) {
  const operations = new Set<Promise<unknown>>();
  let closing = false;
  let ready = false;
  let pending: Promise<void> | undefined;

  function run<T>(work: () => T | Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new Error('正在准备退出 AgentSwitcher，请稍后重试'));
    const operation = Promise.resolve().then(work);
    operations.add(operation);
    const finished = () => { operations.delete(operation); };
    void operation.then(finished, finished);
    return operation;
  }

  function request(): Promise<void> {
    if (pending) return pending;
    if (ready) return Promise.resolve();
    closing = true;
    pending = Promise.allSettled([...operations]).then(async () => {
      if ((options.hasDrafts() || options.isDownloading()) && !await options.confirm()) return;
      await options.cleanup();
      ready = true;
      options.quit();
    }).catch(error => {
      ready = false;
      options.onError(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => {
      if (!ready) closing = false;
      pending = undefined;
    });
    return pending;
  }

  return { run, request, isClosing: () => closing, canQuit: () => ready };
}
