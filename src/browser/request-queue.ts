/** Self-contained factory: also serialized into the managed browser page. */
export function createRequestQueue(env: {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  load: () => any;
  save: (s: any) => void;
}) {
  const old = env.load();
  const state = {
    starts: [] as number[],
    pauses: {} as Record<string, string>,
    notBefore: 0,
    started: 0,
    completed: 0,
    failed: 0,
    ...old,
  };
  const legacyBlocked = typeof state.blocked === "string" ? state.blocked : "";
  const storedPauses = old?.pauses;
  if (storedPauses === undefined)
    state.pauses = legacyBlocked ? { legacy: legacyBlocked } : {};
  else if (
    !storedPauses ||
    typeof storedPauses !== "object" ||
    Array.isArray(storedPauses) ||
    !Object.values(storedPauses).every(
      (reason) => typeof reason === "string" && reason,
    )
  )
    throw Error("请求队列持久化状态损坏");
  const blocked = () => Object.values(state.pauses).join("；");
  if (
    !Array.isArray(state.starts) ||
    !state.starts.every(Number.isFinite) ||
    !Number.isFinite(state.notBefore)
  )
    throw Error("请求队列持久化状态损坏");
  let tail: Promise<unknown> = Promise.resolve();
  const persist = () =>
    env.save(structuredClone({ ...state, blocked: blocked() }));
  const check = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
    if (blocked()) throw Error(blocked());
  };
  return {
    snapshot: () => structuredClone({ ...state, blocked: blocked() }),
    pause: (reason: string, reasonId = "legacy") => {
      state.pauses[reasonId] = reason;
      persist();
    },
    resume: (reasonId: string) => {
      if (!Object.hasOwn(state.pauses, reasonId)) return false;
      delete state.pauses[reasonId];
      persist();
      return true;
    },
    resumeReasons: (reasonIds: string[]) => {
      const resumed: string[] = [];
      for (const reasonId of reasonIds)
        if (Object.hasOwn(state.pauses, reasonId)) {
          delete state.pauses[reasonId];
          resumed.push(reasonId);
        }
      if (resumed.length) persist();
      return resumed;
    },
    cooldown: (ms: number) => {
      state.notBefore = Math.max(state.notBefore, env.now() + Math.max(0, ms));
      persist();
    },
    run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      const task = tail.then(async () => {
        check(signal);
        for (;;) {
          check(signal);
          const now = env.now();
          state.starts = state.starts.filter((x: number) => x > now - 1000);
          const last = state.starts.at(-1);
          const ready = Math.max(
            state.notBefore,
            last === undefined ? now : last + 334,
            state.starts.length >= 3
              ? state.starts[state.starts.length - 3] + 1001
              : now,
          );
          if (ready <= now) break;
          await env.sleep(ready - now);
        }
        check(signal);
        const at = env.now();
        state.starts = state.starts.filter((x: number) => x > at - 1000);
        state.starts.push(at);
        state.started++;
        persist();
        try {
          const value = await operation();
          state.completed++;
          persist();
          return value;
        } catch (e) {
          state.failed++;
          persist();
          throw e;
        }
      });
      tail = task.catch(() => {});
      return task;
    },
  };
}
