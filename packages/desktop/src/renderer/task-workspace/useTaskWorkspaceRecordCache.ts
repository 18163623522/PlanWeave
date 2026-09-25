import type {
  DesktopBridgeApi,
  DesktopRunRecord,
  TaskWorkspaceRunDetail,
  TaskWorkspaceRunDetailInput
} from "@planweave-ai/runtime";
import { useCallback, useEffect, useRef, useState } from "react";

export type TaskWorkspaceRecordLoad = {
  authorityKey: string;
  blockRef: string | null;
  error: string | null;
  item: TaskWorkspaceRunDetail["item"] | null;
  key: string;
  record: DesktopRunRecord | null;
  status: "idle" | "loading" | "ready" | "error";
};

type RecordIdentity = TaskWorkspaceRunDetailInput & {
  authorityKey: string;
  blockRef: string;
};

type CacheOptions = {
  recordCapacity?: number;
  scrollCapacity?: number;
};

const recordCacheCapacity = 8;
const scrollCacheCapacity = 32;

export const idleTaskWorkspaceRecordLoad: TaskWorkspaceRecordLoad = {
  authorityKey: "",
  blockRef: null,
  error: null,
  item: null,
  key: "",
  record: null,
  status: "idle"
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveCapacity(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function touch<K, V>(entries: Map<K, V>, key: K, value: V): void {
  entries.delete(key);
  entries.set(key, value);
}

function trimOldest<K, V>(entries: Map<K, V>, capacity: number): void {
  while (entries.size > capacity) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) return;
    entries.delete(oldest);
  }
}

function recordSelectionKey(authorityKey: string, blockRef: string, recordId: string): string {
  return `${authorityKey}\u0000${blockRef}\u0000${recordId}`;
}

function validateDetail(
  identity: RecordIdentity,
  detail: TaskWorkspaceRunDetail
): TaskWorkspaceRecordLoad {
  const record = detail.record;
  if (
    detail.projectRoot !== identity.projectRoot ||
    detail.canvasId !== identity.canvasId ||
    detail.taskId !== identity.taskId ||
    detail.blockRef !== identity.blockRef ||
    record.recordId !== identity.recordId ||
    record.ref !== identity.blockRef ||
    record.taskId !== identity.taskId ||
    detail.item.run.record.recordId !== identity.recordId ||
    detail.item.run.record.ref !== identity.blockRef ||
    detail.item.run.record.taskId !== identity.taskId
  ) {
    throw new Error("Selected run record does not match its Task Workspace navigation identity.");
  }
  return {
    authorityKey: identity.authorityKey,
    blockRef: detail.blockRef,
    error: null,
    item: detail.item,
    key: identity.recordId,
    record,
    status: "ready"
  };
}

export class TaskWorkspaceRecordCache {
  readonly #recordCapacity: number;
  readonly #scrollCapacity: number;
  #authorityKey = "";
  #generation = 0;
  #records = new Map<string, { freshnessKey: string; load: TaskWorkspaceRecordLoad }>();
  #pending = new Map<string, { freshnessKey: string; request: Promise<TaskWorkspaceRecordLoad> }>();
  #scrollPositions = new Map<string, number>();

  constructor(options: CacheOptions = {}) {
    this.#recordCapacity = positiveCapacity(
      options.recordCapacity ?? recordCacheCapacity,
      "recordCapacity"
    );
    this.#scrollCapacity = positiveCapacity(
      options.scrollCapacity ?? scrollCacheCapacity,
      "scrollCapacity"
    );
  }

  setAuthority(authorityKey: string): void {
    if (this.#authorityKey === authorityKey) return;
    this.#authorityKey = authorityKey;
    this.#generation += 1;
    this.#records.clear();
    this.#pending.clear();
    this.#scrollPositions.clear();
  }

  getRecord(
    authorityKey: string,
    blockRef: string,
    recordId: string,
    freshnessKey = ""
  ): TaskWorkspaceRecordLoad | null {
    if (authorityKey !== this.#authorityKey) return null;
    const cacheKey = recordSelectionKey(authorityKey, blockRef, recordId);
    const cached = this.#records.get(cacheKey);
    const pending = this.#pending.get(cacheKey);
    if (pending && pending.freshnessKey !== freshnessKey) this.#pending.delete(cacheKey);
    if (!cached) return null;
    if (cached.freshnessKey !== freshnessKey) {
      this.#records.delete(cacheKey);
      return null;
    }
    touch(this.#records, cacheKey, cached);
    return cached.load;
  }

  loadRecord(
    identity: RecordIdentity,
    readDetail: () => Promise<TaskWorkspaceRunDetail>,
    freshnessKey = ""
  ): Promise<TaskWorkspaceRecordLoad> {
    if (identity.authorityKey !== this.#authorityKey) {
      return Promise.reject(new Error("Task Workspace record authority is no longer active."));
    }
    const cached = this.getRecord(
      identity.authorityKey,
      identity.blockRef,
      identity.recordId,
      freshnessKey
    );
    if (cached) return Promise.resolve(cached);
    const cacheKey = recordSelectionKey(
      identity.authorityKey,
      identity.blockRef,
      identity.recordId
    );
    // Pending reads stay outside the fulfilled-record LRU until they settle, so they remain
    // coalesced and cannot be evicted into duplicate, unarbitrated requests.
    const pending = this.#pending.get(cacheKey);
    if (pending?.freshnessKey === freshnessKey) return pending.request;
    if (pending) this.#pending.delete(cacheKey);

    const generation = this.#generation;
    const request = readDetail().then((detail) => {
      const loaded = validateDetail(identity, detail);
      if (
        generation === this.#generation &&
        identity.authorityKey === this.#authorityKey &&
        this.#pending.get(cacheKey)?.request === request
      ) {
        touch(this.#records, cacheKey, { freshnessKey, load: loaded });
        trimOldest(this.#records, this.#recordCapacity);
      }
      return loaded;
    });
    this.#pending.set(cacheKey, { freshnessKey, request });
    const clearPending = () => {
      if (this.#pending.get(cacheKey)?.request === request) {
        this.#pending.delete(cacheKey);
      }
    };
    void request.then(clearPending, clearPending);
    return request;
  }

  getScrollTop(authorityKey: string, blockRef: string, recordId: string): number {
    if (authorityKey !== this.#authorityKey) return 0;
    const cacheKey = recordSelectionKey(authorityKey, blockRef, recordId);
    const scrollTop = this.#scrollPositions.get(cacheKey);
    if (scrollTop === undefined) return 0;
    touch(this.#scrollPositions, cacheKey, scrollTop);
    return scrollTop;
  }

  setScrollTop(authorityKey: string, blockRef: string, recordId: string, scrollTop: number): void {
    if (authorityKey !== this.#authorityKey) return;
    touch(
      this.#scrollPositions,
      recordSelectionKey(authorityKey, blockRef, recordId),
      Math.max(0, scrollTop)
    );
    trimOldest(this.#scrollPositions, this.#scrollCapacity);
  }
}

type UseTaskWorkspaceRecordCacheOptions = {
  api: Pick<DesktopBridgeApi, "getTaskWorkspaceRunDetail"> | null;
  authorityKey: string;
  enabled: boolean;
  freshnessKey: string;
  identity: Omit<RecordIdentity, "authorityKey"> | null;
  onRecordReady: (load: TaskWorkspaceRecordLoad) => void;
  syntheticLoad: TaskWorkspaceRecordLoad | null;
};

export function useTaskWorkspaceRecordCache(options: UseTaskWorkspaceRecordCacheOptions): {
  getRunScrollTop: (recordId: string) => number;
  onRunScrollTopChange: (recordId: string, scrollTop: number) => void;
  recordLoad: TaskWorkspaceRecordLoad;
} {
  const cacheRef = useRef<TaskWorkspaceRecordCache | null>(null);
  if (cacheRef.current === null) cacheRef.current = new TaskWorkspaceRecordCache();
  const cache = cacheRef.current;
  const { api, authorityKey, enabled, freshnessKey, identity, syntheticLoad } = options;
  cache.setAuthority(authorityKey);
  const selectionKey = identity
    ? recordSelectionKey(authorityKey, identity.blockRef, identity.recordId)
    : "";
  const activeSelectionKey = useRef(`${selectionKey}\u0000${freshnessKey}`);
  activeSelectionKey.current = `${selectionKey}\u0000${freshnessKey}`;
  const selectionRequest = useRef(0);
  const onRecordReadyRef = useRef(options.onRecordReady);
  onRecordReadyRef.current = options.onRecordReady;
  const [recordLoadState, setRecordLoadState] = useState({
    freshnessKey: "",
    load: idleTaskWorkspaceRecordLoad
  });
  const setRecordLoad = useCallback(
    (load: TaskWorkspaceRecordLoad) => setRecordLoadState({ freshnessKey, load }),
    [freshnessKey]
  );

  useEffect(() => {
    const request = ++selectionRequest.current;
    if (!enabled || !identity) {
      setRecordLoad(idleTaskWorkspaceRecordLoad);
      return;
    }
    if (syntheticLoad) {
      setRecordLoad(syntheticLoad);
      return;
    }
    if (!api) {
      setRecordLoad({
        ...idleTaskWorkspaceRecordLoad,
        authorityKey,
        blockRef: identity.blockRef,
        error: "Task Workspace bridge is unavailable.",
        key: identity.recordId,
        status: "error"
      });
      return;
    }
    const cached = cache.getRecord(
      authorityKey,
      identity.blockRef,
      identity.recordId,
      freshnessKey
    );
    if (cached) {
      setRecordLoad(cached);
      onRecordReadyRef.current(cached);
      return;
    }
    setRecordLoad({
      ...idleTaskWorkspaceRecordLoad,
      authorityKey,
      blockRef: identity.blockRef,
      key: identity.recordId,
      status: "loading"
    });
    const runDetailInput: TaskWorkspaceRunDetailInput = {
      canvasId: identity.canvasId,
      projectRoot: identity.projectRoot,
      recordId: identity.recordId,
      taskId: identity.taskId
    };
    void cache
      .loadRecord(
        { ...identity, authorityKey },
        () => api.getTaskWorkspaceRunDetail(runDetailInput),
        freshnessKey
      )
      .then((loaded) => {
        if (
          selectionRequest.current !== request ||
          `${selectionKey}\u0000${freshnessKey}` !== activeSelectionKey.current
        )
          return;
        setRecordLoad(loaded);
        onRecordReadyRef.current(loaded);
      })
      .catch((error: unknown) => {
        if (
          selectionRequest.current !== request ||
          `${selectionKey}\u0000${freshnessKey}` !== activeSelectionKey.current
        )
          return;
        setRecordLoad({
          ...idleTaskWorkspaceRecordLoad,
          authorityKey,
          blockRef: identity.blockRef,
          error: errorMessage(error),
          key: identity.recordId,
          status: "error"
        });
      });
  }, [
    api,
    authorityKey,
    cache,
    enabled,
    freshnessKey,
    identity,
    selectionKey,
    setRecordLoad,
    syntheticLoad
  ]);

  const getRunScrollTop = useCallback(
    (recordId: string) => cache.getScrollTop(authorityKey, identity?.blockRef ?? "", recordId),
    [authorityKey, cache, identity?.blockRef]
  );
  const onRunScrollTopChange = useCallback(
    (recordId: string, scrollTop: number) =>
      cache.setScrollTop(authorityKey, identity?.blockRef ?? "", recordId, scrollTop),
    [authorityKey, cache, identity?.blockRef]
  );
  const cachedRecordLoad =
    enabled && identity && !syntheticLoad
      ? cache.getRecord(authorityKey, identity.blockRef, identity.recordId, freshnessKey)
      : null;
  const currentRecordLoad =
    identity &&
    recordLoadState.freshnessKey === freshnessKey &&
    recordLoadState.load.authorityKey === authorityKey &&
    recordLoadState.load.blockRef === identity.blockRef &&
    recordLoadState.load.key === identity.recordId
      ? recordLoadState.load
      : idleTaskWorkspaceRecordLoad;
  const visibleRecordLoad = syntheticLoad ?? cachedRecordLoad ?? currentRecordLoad;
  return { getRunScrollTop, onRunScrollTopChange, recordLoad: visibleRecordLoad };
}
