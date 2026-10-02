import type { UnsId } from "@cyanmycelium/mcp-uns";
import { UnsPath } from "@cyanmycelium/mcp-uns";
import type { ICacheStore } from "../contract/cache.store";
import type {
    CacheGetItem,
    ICacheCapabilities,
    ICacheDeleteResult,
    ICacheGetResult,
    ICacheScanRequest,
    ICacheScanResult,
    ICacheSetResult,
    ICacheWrite,
    IRejectedWrite,
} from "../contract/cache.types";
import { CacheError, invalid } from "../contract/errors";
import { checkWrites, decodeCursor, encodeCursor, formatInstant, isNormalizedWrite, normalizeWrite, parseIds, parseLimit, parseRoot } from "../contract/validation";

interface IEntry {
    readonly json: string;
    readonly storedAt: number;
    readonly expiresAt: number | null;
}

export interface IMemoryCacheStoreOptions {
    readonly id?: string;
    /** Live entries kept at most; past it, the least recently used is evicted. Default: unbounded. */
    readonly maxEntries?: number;
    readonly defaultTtlMs?: number | null;
    readonly limits?: Partial<ICacheCapabilities["limits"]>;
    /** Clock, for tests. */
    readonly now?: () => number;
}

const DEFAULT_LIMITS: ICacheCapabilities["limits"] = {
    maxIdsPerCall: 1_000,
    maxValueBytes: 1_048_576,
    maxTtlMs: null,
    maxScanItems: 1_000,
};

/**
 * cache.v1 in one process's memory.
 *
 * Values are kept JSON-encoded, as every store keeps them, so a caller never
 * shares an object with the cache. Expired entries are dropped when touched.
 * Not shared: two processes have two caches. For that, use the Redis store.
 */
export class MemoryCacheStore implements ICacheStore {
    readonly id: string;
    private readonly _capabilities: ICacheCapabilities;
    /** Insertion order is recency order: a touched entry is moved to the end. */
    private readonly _entries = new Map<UnsId, IEntry>();
    private readonly _maxEntries: number;
    private readonly _now: () => number;
    private _closed = false;

    constructor(options: IMemoryCacheStoreOptions = {}) {
        this.id = options.id ?? "memory";
        this._maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY;
        this._now = options.now ?? Date.now;
        this._capabilities = {
            interface: "cache.v1",
            store: "memory",
            shared: false,
            durability: "memory",
            defaultTtlMs: options.defaultTtlMs ?? null,
            evicts: Number.isFinite(this._maxEntries),
            limits: { ...DEFAULT_LIMITS, ...options.limits },
        };
        const { defaultTtlMs, limits } = this._capabilities;
        if (limits.maxTtlMs !== null && (defaultTtlMs === null || defaultTtlMs > limits.maxTtlMs)) {
            throw new Error(`memory cache "${this.id}": with maxTtlMs ${limits.maxTtlMs}, defaultTtlMs must be set and at most that`);
        }
    }

    async getCapabilitiesAsync(signal?: AbortSignal): Promise<ICacheCapabilities> {
        this._enter(signal);
        return structuredClone(this._capabilities);
    }

    async getAsync(ids: readonly UnsId[], signal?: AbortSignal): Promise<ICacheGetResult> {
        this._enter(signal);
        const items: CacheGetItem[] = parseIds(ids, this._capabilities.limits.maxIdsPerCall).map((id) => {
            const entry = this._live(id);
            if (!entry) return { id, hit: false };
            this._entries.delete(id);
            this._entries.set(id, entry);
            return {
                id,
                hit: true,
                value: JSON.parse(entry.json) as unknown,
                storedAt: formatInstant(entry.storedAt),
                expiresAt: entry.expiresAt === null ? null : formatInstant(entry.expiresAt),
            };
        });
        return { items };
    }

    async setAsync(entries: readonly ICacheWrite[], signal?: AbortSignal): Promise<ICacheSetResult> {
        this._enter(signal);
        const now = this._now();
        let stored = 0;
        const rejected: IRejectedWrite[] = [];
        checkWrites(entries, this._capabilities.limits.maxIdsPerCall).forEach((entry, index) => {
            const write = normalizeWrite(entry, this._capabilities);
            if (!isNormalizedWrite(write)) {
                rejected.push({ index, error: write });
                return;
            }
            this._entries.delete(write.id);
            this._entries.set(write.id, { json: write.json, storedAt: now, expiresAt: write.ttlMs === null ? null : now + write.ttlMs });
            stored++;
        });
        while (this._entries.size > this._maxEntries) this._entries.delete(this._entries.keys().next().value as UnsId);
        return { stored, rejected };
    }

    async deleteAsync(ids: readonly UnsId[], signal?: AbortSignal): Promise<ICacheDeleteResult> {
        this._enter(signal);
        let deleted = 0;
        for (const id of parseIds(ids, this._capabilities.limits.maxIdsPerCall)) {
            if (this._live(id)) deleted++;
            this._entries.delete(id);
        }
        return { deleted, errors: [] };
    }

    async scanAsync(request: ICacheScanRequest, signal?: AbortSignal): Promise<ICacheScanResult> {
        this._enter(signal);
        const root = parseRoot(request.root);
        const limit = parseLimit(request.limit, this._capabilities.limits.maxScanItems);
        let after: string | undefined;
        if (request.cursor !== undefined) {
            const state = decodeCursor(request.cursor);
            if (typeof state.after !== "string") throw invalid("cursor is not one this store issued");
            after = state.after;
        }
        const ids = [...this._entries.keys()]
            .filter((id) => (after === undefined || id > after) && (!root || root.contains(UnsPath.parse(id))) && this._live(id) !== undefined)
            .sort();
        const page = ids.slice(0, limit);
        return { ids: page, cursor: ids.length > limit ? encodeCursor({ after: page[page.length - 1] }) : null };
    }

    async closeAsync(): Promise<void> {
        this._closed = true;
        this._entries.clear();
    }

    /** The entry if it is still alive; an expired one is dropped on the way. */
    private _live(id: UnsId): IEntry | undefined {
        const entry = this._entries.get(id);
        if (!entry) return undefined;
        if (entry.expiresAt !== null && entry.expiresAt <= this._now()) {
            this._entries.delete(id);
            return undefined;
        }
        return entry;
    }

    private _enter(signal: AbortSignal | undefined): void {
        signal?.throwIfAborted();
        if (this._closed) throw new CacheError("store_unavailable", `cache store "${this.id}" is closed`);
    }
}
