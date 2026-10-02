import { UnsPath, type UnsId } from "@cyanmycelium/mcp-uns";
import { CacheError, invalid, type ICacheErrorBody } from "./errors";
import type { ICacheCapabilities } from "./cache.types";

/** Validates the ids of one call: non-empty, canonical UNS ids, no duplicates, within the store's ceiling. */
export function parseIds(ids: unknown, maxIdsPerCall: number): UnsId[] {
    if (!Array.isArray(ids) || ids.length === 0) throw invalid("ids must be a non-empty array of UNS ids");
    if (ids.length > maxIdsPerCall) throw new CacheError("limit_exceeded", `${ids.length} ids sent, the store maximum is ${maxIdsPerCall}`, { detail: { max: maxIdsPerCall } });
    const seen = new Set<string>();
    return ids.map((id) => {
        const path = UnsPath.tryParse(id as UnsId);
        if (!path || path.id !== id) throw invalid(`"${String(id)}" is not a canonical UNS id`);
        if (seen.has(path.id)) throw invalid(`${path.id} appears twice in the request`);
        seen.add(path.id);
        return path.id;
    });
}

export function parseRoot(root: unknown): UnsPath | undefined {
    if (root === undefined) return undefined;
    const path = UnsPath.tryParse(root as UnsId);
    if (!path || path.id !== root) throw invalid(`root "${String(root)}" is not a canonical UNS id`);
    return path;
}

/** Applies the default and the ceiling of a page size. */
export function parseLimit(limit: unknown, max: number): number {
    if (limit === undefined) return max;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) throw invalid("limit must be a positive integer");
    if (limit > max) throw new CacheError("limit_exceeded", `limit ${limit} exceeds the store maximum of ${max}`, { detail: { max } });
    return limit;
}

/** True for a value JSON carries unchanged: no NaN, no Infinity, no undefined, no class instance. */
export function isJsonValue(value: unknown, depth = 0): boolean {
    if (depth > 64) return false;
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
    if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return Object.values(value).every((item) => isJsonValue(item, depth + 1));
    return false;
}

/** A write checked and reduced to what a store files. */
export interface INormalizedWrite {
    readonly id: UnsId;
    /** The value, JSON-encoded: what every store keeps, and what the size limit counts. */
    readonly json: string;
    /** `null`: no expiry. */
    readonly ttlMs: number | null;
}

/** Checks one write against the contract and the store's capabilities. Returns the error body instead of throwing: one bad entry never fails a set. */
export function normalizeWrite(entry: unknown, capabilities: Pick<ICacheCapabilities, "defaultTtlMs" | "limits">): INormalizedWrite | ICacheErrorBody {
    if (typeof entry !== "object" || entry === null) return invalid("an entry must be an object").toBody();
    const e = entry as { id?: unknown; value?: unknown; ttlMs?: unknown };
    const path = UnsPath.tryParse(e.id as UnsId);
    if (!path || path.id !== e.id) return invalid(`"${String(e.id)}" is not a canonical UNS id`).toBody();
    if (!("value" in e) || !isJsonValue(e.value)) return invalid("value must be a JSON value: no undefined, NaN, Infinity or class instance").toBody();

    let ttlMs: number | null = capabilities.defaultTtlMs;
    if (e.ttlMs !== undefined) {
        if (typeof e.ttlMs !== "number" || !Number.isInteger(e.ttlMs) || e.ttlMs < 1) return invalid("ttlMs must be a positive integer").toBody();
        ttlMs = e.ttlMs;
    }
    const maxTtl = capabilities.limits.maxTtlMs;
    if (maxTtl !== null && (ttlMs === null || ttlMs > maxTtl)) {
        return new CacheError("limit_exceeded", `ttlMs must be at most ${maxTtl}`, { detail: { maxTtlMs: maxTtl } }).toBody();
    }

    const json = JSON.stringify(e.value);
    const bytes = new TextEncoder().encode(json).length;
    if (bytes > capabilities.limits.maxValueBytes) {
        return new CacheError("limit_exceeded", `value is ${bytes} bytes, the store maximum is ${capabilities.limits.maxValueBytes}`, {
            detail: { max: capabilities.limits.maxValueBytes },
        }).toBody();
    }
    return { id: path.id, json, ttlMs };
}

export function isNormalizedWrite(value: INormalizedWrite | ICacheErrorBody): value is INormalizedWrite {
    return (value as INormalizedWrite).json !== undefined;
}

/** Rejects a set that names the same id twice: which one would win is not something to leave to each store. */
export function checkWrites(entries: unknown, maxIdsPerCall: number): readonly unknown[] {
    if (!Array.isArray(entries)) throw invalid("entries must be an array");
    if (entries.length > maxIdsPerCall)
        throw new CacheError("limit_exceeded", `${entries.length} entries sent, the store maximum is ${maxIdsPerCall}`, { detail: { max: maxIdsPerCall } });
    const seen = new Set<unknown>();
    for (const entry of entries) {
        const id = typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined;
        if (id !== undefined && seen.has(id)) throw invalid(`${String(id)} appears twice in the request`);
        seen.add(id);
    }
    return entries;
}

export function formatInstant(ms: number): string {
    return new Date(ms).toISOString();
}

/**
 * Cursors are opaque to clients. Every store of this package encodes them as
 * base64url JSON, without `Buffer`: the contract also runs in a browser page
 * publishing a slot.
 */
export function encodeCursor(state: Readonly<Record<string, unknown>>): string {
    const bytes = new TextEncoder().encode(JSON.stringify(state));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(cursor: unknown): Record<string, unknown> {
    if (typeof cursor !== "string" || cursor.length === 0) throw invalid("cursor must be a string returned by a previous page");
    try {
        const binary = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
        const state = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))) as unknown;
        if (typeof state === "object" && state !== null && !Array.isArray(state)) return state as Record<string, unknown>;
    } catch {
        // fall through
    }
    throw invalid("cursor is not one this store issued");
}
