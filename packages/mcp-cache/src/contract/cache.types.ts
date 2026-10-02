import type { UnsId } from "@cyanmycelium/mcp-uns";
import type { ICacheErrorBody } from "./errors";

/** An id the request named that was refused, or that a store could not process. */
export interface ICacheItemError {
    readonly id: UnsId;
    readonly error: ICacheErrorBody;
}

export function isItemError(item: object): item is ICacheItemError {
    return (item as ICacheItemError).error !== undefined;
}

// ── get ─────────────────────────────────────────────────────────────────────

export interface ICacheHit {
    readonly id: UnsId;
    readonly hit: true;
    /** A JSON value, as it was set. */
    readonly value: unknown;
    /** ISO 8601, UTC, milliseconds. */
    readonly storedAt: string;
    /** `null` when the entry does not expire. */
    readonly expiresAt: string | null;
}

/** Nothing under that id: never set, deleted, expired or evicted. A cache never says which. */
export interface ICacheMiss {
    readonly id: UnsId;
    readonly hit: false;
}

export type CacheGetItem = ICacheHit | ICacheMiss | ICacheItemError;

export interface ICacheGetResult {
    /** One item per requested id, in the order of the request. */
    readonly items: readonly CacheGetItem[];
}

// ── set ─────────────────────────────────────────────────────────────────────

export interface ICacheWrite {
    readonly id: UnsId;
    /** Any JSON value, `null` included. */
    readonly value: unknown;
    /** Time to live. Absent: `defaultTtlMs` of the store, or no expiry when it has none. */
    readonly ttlMs?: number;
}

export interface IRejectedWrite {
    /** Position of the entry in the request. */
    readonly index: number;
    readonly error: ICacheErrorBody;
}

export interface ICacheSetResult {
    readonly stored: number;
    readonly rejected: readonly IRejectedWrite[];
}

// ── delete ──────────────────────────────────────────────────────────────────

export interface ICacheDeleteResult {
    /** Entries that existed and are gone. An id with nothing under it is not an error. */
    readonly deleted: number;
    readonly errors: readonly ICacheItemError[];
}

// ── scan ────────────────────────────────────────────────────────────────────

export interface ICacheScanRequest {
    /** UNS subtree; matches by whole segments (`uns://a/b` covers `uns://a/b/c`, not `uns://a/bc`). */
    readonly root?: UnsId;
    /** At most this many ids per page. Defaults to, and may not exceed, `limits.maxScanItems`. */
    readonly limit?: number;
    readonly cursor?: string;
}

export interface ICacheScanResult {
    /**
     * Live ids under the root. **No order, and an id may appear on two
     * pages**: Redis `SCAN` promises no more, so the contract does not either.
     * A page may be shorter than `limit`, even empty, before the last one.
     */
    readonly ids: readonly UnsId[];
    /** `null` when the scan is complete. */
    readonly cursor: string | null;
}

// ── Capabilities ────────────────────────────────────────────────────────────

export interface ICacheCapabilities {
    readonly interface: "cache.v1";
    /** Backend kind: `memory`, `redis`, ... */
    readonly store: string;
    /** Whether several processes see the same entries. */
    readonly shared: boolean;
    readonly durability: "memory" | "server";
    /** Applied when a write gives no `ttlMs`; `null`: such an entry does not expire. */
    readonly defaultTtlMs: number | null;
    /** Whether the store may drop live entries under memory pressure (LRU, Redis `maxmemory`). */
    readonly evicts: boolean;
    readonly limits: {
        /** Ids per `get` and `delete`, entries per `set`. */
        readonly maxIdsPerCall: number;
        /** UTF-8 bytes of the JSON-encoded value. */
        readonly maxValueBytes: number;
        /** `null`: no ceiling. When set, every entry expires: `defaultTtlMs` is set too, and at most this. */
        readonly maxTtlMs: number | null;
        readonly maxScanItems: number;
    };
}
