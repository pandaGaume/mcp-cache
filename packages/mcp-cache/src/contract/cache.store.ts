import type { UnsId } from "@cyanmycelium/mcp-uns";
import type { ICacheCapabilities, ICacheDeleteResult, ICacheGetResult, ICacheScanRequest, ICacheScanResult, ICacheSetResult, ICacheWrite } from "./cache.types";

/**
 * The cache.v1 contract, in its TypeScript form: what a backend implements.
 *
 * Entries are addressed by UNS id, like SCADA values and their history, so
 * one broker policy governs all three. `CacheBehavior` publishes any
 * implementation as an MCP slot, and `CacheSlotStore` reaches such a slot
 * back as an implementation. The semantics every implementation must share
 * are pinned by the conformance suite (`@cyanmycelium/mcp-cache/conformance`).
 *
 * Request-level problems (malformed request, too many ids) reject with a
 * `CacheError`. Per-entry problems are reported in the result and never fail
 * the other entries.
 */
export interface ICacheStore {
    readonly id: string;
    getCapabilitiesAsync(signal?: AbortSignal): Promise<ICacheCapabilities>;
    getAsync(ids: readonly UnsId[], signal?: AbortSignal): Promise<ICacheGetResult>;
    /** Replaces whatever was under each id, value and expiry alike. */
    setAsync(entries: readonly ICacheWrite[], signal?: AbortSignal): Promise<ICacheSetResult>;
    deleteAsync(ids: readonly UnsId[], signal?: AbortSignal): Promise<ICacheDeleteResult>;
    scanAsync(request: ICacheScanRequest, signal?: AbortSignal): Promise<ICacheScanResult>;
    closeAsync(): Promise<void>;
}
