import type { UpdateHandoff } from './update-handoff';

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
  let sealed = false;
  let pending: Promise<void> | undefined;
  let preparingUpdate = false;
  let pendingUpdateHandoff: UpdateHandoff | undefined;

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
    if (sealed) return Promise.reject(new Error('AgentSwitcher 已退出'));
    return track(work);
  }

  async function drainOperations(): Promise<void> {
    if (!operations.size) return;
    options.onWaiting?.(true);
    while (operations.size) await Promise.allSettled([...operations]);
    options.onWaiting?.(false);
  }

  async function request(): Promise<{ ready: boolean }> {
    await drainOperations();
    if ((options.hasDrafts() || options.isDownloading()) && !await options.confirm()) return { ready: false };
    await drainOperations();
    await options.cleanup();
    while (operations.size) await drainOperations();
    return { ready: true };
  }

  function finishQuit(): Promise<void> {
    if (pending) return pending;
    if (ready) return Promise.resolve();
    closing = true;
    pending = (async () => {
      if (!(await request()).ready) return;
      // A completion microtask can register a commit as request resolves.
      // Seal synchronously with this final check, before launching or quitting.
      while (operations.size) await drainOperations();
      sealed = true;
      if (pendingUpdateHandoff) {
        await pendingUpdateHandoff.launch();
        pendingUpdateHandoff = undefined; // The helper now owns the stage.
      }
      ready = true;
      options.quit();
    })().catch(error => {
      ready = false;
      options.onError(error instanceof Error ? error : new Error(String(error)));
    }).finally(async () => {
      try { await pendingUpdateHandoff?.dispose(); }
      catch (error) { options.onError(error instanceof Error ? error : new Error(String(error))); }
      finally {
        pendingUpdateHandoff = undefined;
        if (!ready) { sealed = false; closing = false; }
        pending = undefined;
      }
    });
    return pending;
  }

  async function installUpdate(prepare: () => Promise<UpdateHandoff>) {
    if (preparingUpdate || closing) throw new Error('正在准备退出或安装更新');
    preparingUpdate = true;
    try {
      // An ordinary Cmd+Q during staging must wait for ownership of the stage.
      await run(async () => { pendingUpdateHandoff = await prepare(); });
      if (!closing) options.quit(); // Enters before-quit just like a menu or keyboard quit.
      await pending;
    } finally { preparingUpdate = false; }
  }

  return { run, trackCritical, finishQuit, installUpdate, isClosing: () => closing, canQuit: () => ready };
}
