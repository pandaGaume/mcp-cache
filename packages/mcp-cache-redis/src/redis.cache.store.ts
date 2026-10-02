import {
    CacheError,
    checkWrites,
    decodeCursor,
    encodeCursor,
    formatInstant,
    invalid,
    isNormalizedWrite,
    normalizeWrite,
    parseIds,
    parseLimit,
    parseRoot,
    type CacheGetItem,
    type ICacheCapabilities,
    type ICacheDeleteResult,
    type ICacheGetResult,
    type ICacheScanRequest,
    type ICacheScanResult,
    type ICacheSetResult,
    type ICacheStore,
    type ICacheWrite,
    type IRejectedWrite,
} from "@cyanmycelium/mcp-cache";
import type { UnsId } from "@cyanmycelium/mcp-uns";
import { createClient } from "redis";

/**
 * The Redis commands the store uses, and nothing else. `fromNodeRedis` adapts
 * a node-redis client; a test can hand in a fake.
 */
export interface IRedisCommands {
    /** `SET key value [PX ttlMs]`. */
    set(key: string, value: string, ttlMs: number | null): Promise<unknown>;
    mGet(keys: string[]): Promise<(string | null)[]>;
    /** `UNLINK`: the number of keys that existed. */
    unlink(keys: string[]): Promise<number>;
    /** `SCAN cursor MATCH pattern COUNT count`; cursor `"0"` starts, and ends, the iteration. */
    scan(cursor: string, match: string, count: number): Promise<{ cursor: string; keys: string[] }>;
    close(): Promise<void>;
}

/** The node-redis client methods `fromNodeRedis` calls; any connected node-redis 5+ client has them, whatever its modules or RESP version. */
export interface INodeRedisClient {
    set(key: string, value: string, options?: { expiration: { type: "PX"; value: number } }): Promise<unknown>;
    mGet(keys: string[]): Promise<unknown>;
    unlink(keys: string[]): Promise<unknown>;
    scan(cursor: string, options: { MATCH: string; COUNT: number }): Promise<{ cursor: unknown; keys: readonly unknown[] }>;
    close(): Promise<unknown>;
}

/** Adapts a connected node-redis client. Commands issued in the same tick are pipelined by the client. */
export function fromNodeRedis(client: INodeRedisClient): IRedisCommands {
    return {
        set: (key, value, ttlMs) => (ttlMs === null ? client.set(key, value) : client.set(key, value, { expiration: { type: "PX", value: ttlMs } })),
        mGet: async (keys) => (await client.mGet(keys)) as (string | null)[],
        unlink: async (keys) => Number(await client.unlink(keys)),
        scan: async (cursor, match, count) => {
            const reply = await client.scan(cursor, { MATCH: match, COUNT: count });
            return { cursor: String(reply.cursor), keys: reply.keys.map(String) };
        },
        close: async () => {
            await client.close();
        },
    };
}

export interface IRedisCacheStoreOptions {
    readonly id?: string;
    /** Prepended to every UNS id to form the Redis key. Default `mcp-cache:`. Two caches on one database need two prefixes. */
    readonly prefix?: string;
    readonly defaultTtlMs?: number | null;
    /**
     * Whether the server may drop live keys under memory pressure. Default
     * `true`: a `maxmemory-policy` other than `noeviction` is the norm for a
     * cache, and the store cannot always read it (`CONFIG` is often disabled).
     */
    readonly evicts?: boolean;
    readonly limits?: Partial<ICacheCapabilities["limits"]>;
    /** Close the Redis client with the store. Default `true` when the store created it. */
    readonly ownsClient?: boolean;
}

const DEFAULT_LIMITS: ICacheCapabilities["limits"] = {
    maxIdsPerCall: 1_000,
    maxValueBytes: 1_048_576,
    maxTtlMs: null,
    maxScanItems: 1_000,
};

/** One stored entry: when, until when, and the value, already JSON. */
interface IEnvelope {
    readonly s: number;
    readonly e: number | null;
    readonly v: unknown;
}

function escapeGlob(text: string): string {
    return text.replace(/[*?[\]\\]/g, (char) => `\\${char}`);
}

/**
 * cache.v1 on Redis: one cache shared by every process that reaches the
 * server, expiry kept by the server (`SET ... PX`).
 *
 * Each id is one string key, `<prefix><uns id>`, holding a small JSON
 * envelope with the value and its timestamps, so `storedAt` and `expiresAt`
 * come back without extra round trips. A scan is a Redis `SCAN`, filtered to
 * whole UNS segments: like `SCAN`, it promises no order and may repeat an id.
 */
export class RedisCacheStore implements ICacheStore {
    readonly id: string;
    private readonly _redis: IRedisCommands;
    private readonly _prefix: string;
    private readonly _capabilities: ICacheCapabilities;
    private readonly _ownsClient: boolean;
    private _closed = false;

    constructor(redis: IRedisCommands, options: IRedisCacheStoreOptions = {}) {
        this.id = options.id ?? "redis";
        this._redis = redis;
        this._prefix = options.prefix ?? "mcp-cache:";
        this._ownsClient = options.ownsClient ?? false;
        this._capabilities = {
            interface: "cache.v1",
            store: "redis",
            shared: true,
            durability: "server",
            defaultTtlMs: options.defaultTtlMs ?? null,
            evicts: options.evicts ?? true,
            limits: { ...DEFAULT_LIMITS, ...options.limits },
        };
        const { defaultTtlMs, limits } = this._capabilities;
        if (limits.maxTtlMs !== null && (defaultTtlMs === null || defaultTtlMs > limits.maxTtlMs)) {
            throw new Error(`redis cache "${this.id}": with maxTtlMs ${limits.maxTtlMs}, defaultTtlMs must be set and at most that`);
        }
    }

    /**
     * Connects with node-redis and returns a store that closes the connection
     * with itself. `url` is a standard Redis URL: `redis://host:6379`, or
     * `rediss://host:6380` for TLS. `password` (and `username`, for an ACL
     * user) may be given apart, so a key full of `+`, `/` and `=` needs no URL
     * encoding.
     */
    static async connectAsync(
        url: string,
        options: Omit<IRedisCacheStoreOptions, "ownsClient"> & { readonly username?: string; readonly password?: string } = {}
    ): Promise<RedisCacheStore> {
        const { username, password, ...storeOptions } = options;
        const client = createClient({ url, ...(username ? { username } : {}), ...(password ? { password } : {}) });
        await client.connect();
        return new RedisCacheStore(fromNodeRedis(client), { ...storeOptions, ownsClient: true });
    }

    async getCapabilitiesAsync(signal?: AbortSignal): Promise<ICacheCapabilities> {
        this._enter(signal);
        return structuredClone(this._capabilities);
    }

    async getAsync(ids: readonly UnsId[], signal?: AbortSignal): Promise<ICacheGetResult> {
        this._enter(signal);
        const parsed = parseIds(ids, this._capabilities.limits.maxIdsPerCall);
        const raw = await this._call(() => this._redis.mGet(parsed.map((id) => this._key(id))));
        const now = Date.now();
        const items: CacheGetItem[] = parsed.map((id, index) => {
            const envelope = this._open(raw[index]);
            // The server expires the key; the envelope guards the instant between its clock and ours.
            if (!envelope || (envelope.e !== null && envelope.e <= now)) return { id, hit: false };
            return { id, hit: true, value: envelope.v, storedAt: formatInstant(envelope.s), expiresAt: envelope.e === null ? null : formatInstant(envelope.e) };
        });
        return { items };
    }

    async setAsync(entries: readonly ICacheWrite[], signal?: AbortSignal): Promise<ICacheSetResult> {
        this._enter(signal);
        const now = Date.now();
        const writes: Promise<unknown>[] = [];
        const rejected: IRejectedWrite[] = [];
        checkWrites(entries, this._capabilities.limits.maxIdsPerCall).forEach((entry, index) => {
            const write = normalizeWrite(entry, this._capabilities);
            if (!isNormalizedWrite(write)) {
                rejected.push({ index, error: write });
                return;
            }
            const expiresAt = write.ttlMs === null ? null : now + write.ttlMs;
            // The value is spliced in already encoded: it is parsed once, on read.
            writes.push(this._redis.set(this._key(write.id), `{"s":${now},"e":${expiresAt ?? "null"},"v":${write.json}}`, write.ttlMs));
        });
        await this._call(() => Promise.all(writes));
        return { stored: writes.length, rejected };
    }

    async deleteAsync(ids: readonly UnsId[], signal?: AbortSignal): Promise<ICacheDeleteResult> {
        this._enter(signal);
        const parsed = parseIds(ids, this._capabilities.limits.maxIdsPerCall);
        const deleted = await this._call(() => this._redis.unlink(parsed.map((id) => this._key(id))));
        return { deleted, errors: [] };
    }

    async scanAsync(request: ICacheScanRequest, signal?: AbortSignal): Promise<ICacheScanResult> {
        this._enter(signal);
        const root = parseRoot(request.root);
        const limit = parseLimit(request.limit, this._capabilities.limits.maxScanItems);

        // Our cursor: Redis's, plus ids a previous SCAN returned beyond the page size.
        let redisCursor = "0";
        let pending: string[] = [];
        if (request.cursor !== undefined) {
            const state = decodeCursor(request.cursor);
            if (typeof state.c !== "string" || !Array.isArray(state.p) || !state.p.every((id) => typeof id === "string")) throw invalid("cursor is not one this store issued");
            redisCursor = state.c;
            pending = state.p as string[];
        }

        if (pending.length < limit && !(request.cursor !== undefined && redisCursor === "0")) {
            const match = `${escapeGlob(this._prefix)}${root ? escapeGlob(root.id) : ""}*`;
            const reply = await this._call(() => this._redis.scan(redisCursor, match, limit));
            redisCursor = reply.cursor;
            const ids = reply.keys
                .map((key) => key.slice(this._prefix.length))
                // MATCH is a glob: uns://a/b* also matches uns://a/bc. Keep whole segments.
                .filter((id) => !root || id === root.id || id.startsWith(`${root.id}/`));
            pending = pending.concat(await this._live(ids));
        }

        const page = pending.slice(0, limit);
        const rest = pending.slice(limit);
        const done = redisCursor === "0" && rest.length === 0;
        return { ids: page, cursor: done ? null : encodeCursor({ c: redisCursor, p: rest }) };
    }

    async closeAsync(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        if (this._ownsClient) await this._redis.close();
    }

    private _key(id: UnsId): string {
        return `${this._prefix}${id}`;
    }

    /** SCAN may hand back a key that expired a moment ago: keep the ids still alive. */
    private async _live(ids: string[]): Promise<string[]> {
        if (ids.length === 0) return ids;
        const raw = await this._call(() => this._redis.mGet(ids.map((id) => this._key(id))));
        const now = Date.now();
        return ids.filter((_, index) => {
            const envelope = this._open(raw[index]);
            return envelope !== undefined && (envelope.e === null || envelope.e > now);
        });
    }

    private _open(raw: string | null | undefined): IEnvelope | undefined {
        if (raw === null || raw === undefined) return undefined;
        try {
            const envelope = JSON.parse(raw) as IEnvelope;
            return typeof envelope.s === "number" && "v" in envelope ? envelope : undefined;
        } catch {
            // A foreign key under our prefix: not ours, so not cached.
            return undefined;
        }
    }

    private async _call<T>(command: () => Promise<T>): Promise<T> {
        try {
            return await command();
        } catch (error) {
            throw new CacheError("store_unavailable", `redis cache "${this.id}": ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private _enter(signal: AbortSignal | undefined): void {
        signal?.throwIfAborted();
        if (this._closed) throw new CacheError("store_unavailable", `cache store "${this.id}" is closed`);
    }
}
