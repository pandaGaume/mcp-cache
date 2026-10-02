import type { UnsId } from "@cyanmycelium/mcp-uns";
import type { ICacheStore } from "../contract/cache.store";
import type { ICacheCapabilities, ICacheDeleteResult, ICacheGetResult, ICacheScanRequest, ICacheScanResult, ICacheSetResult, ICacheWrite } from "../contract/cache.types";
import { CacheError } from "../contract/errors";

/** The part of an MCP client a slot store needs. mcp-core's `McpClient` satisfies it. */
export interface ISlotClient {
    callTool(name: string, args: Record<string, unknown>): Promise<{ content?: readonly unknown[]; structuredContent?: unknown; isError?: boolean }>;
}

/**
 * A cache.v1 slot, reached as an {@link ICacheStore}.
 *
 * It is how a test proves that a store published by `CacheBehavior` behaves
 * like the store itself (the conformance suite runs unchanged through it), and
 * how a process reaches a cache published elsewhere. A slot error comes back
 * as the same `CacheError` the store threw.
 */
export class CacheSlotStore implements ICacheStore {
    constructor(
        readonly id: string,
        private readonly _client: ISlotClient
    ) {}

    getCapabilitiesAsync(signal?: AbortSignal): Promise<ICacheCapabilities> {
        return this._callAsync("cache.capabilities", {}, signal);
    }

    getAsync(ids: readonly UnsId[], signal?: AbortSignal): Promise<ICacheGetResult> {
        return this._callAsync("cache.get", { ids }, signal);
    }

    setAsync(entries: readonly ICacheWrite[], signal?: AbortSignal): Promise<ICacheSetResult> {
        return this._callAsync("cache.set", { entries }, signal);
    }

    deleteAsync(ids: readonly UnsId[], signal?: AbortSignal): Promise<ICacheDeleteResult> {
        return this._callAsync("cache.delete", { ids }, signal);
    }

    scanAsync(request: ICacheScanRequest, signal?: AbortSignal): Promise<ICacheScanResult> {
        return this._callAsync("cache.scan", request, signal);
    }

    /** The client belongs to whoever connected it; closing the store does not disconnect it. */
    async closeAsync(): Promise<void> {}

    private async _callAsync<T>(tool: string, args: object, signal: AbortSignal | undefined): Promise<T> {
        signal?.throwIfAborted();
        let result: Awaited<ReturnType<ISlotClient["callTool"]>>;
        try {
            result = await this._client.callTool(tool, { ...args });
        } catch (error) {
            throw new CacheError("store_unavailable", `cache slot "${this.id}" did not answer ${tool}: ${error instanceof Error ? error.message : String(error)}`);
        }
        const payload = payloadOf(result);
        if (result.isError) {
            const body = typeof payload === "object" && payload !== null ? (payload as { error?: unknown }).error : undefined;
            throw body ? CacheError.fromBody(body) : new CacheError("store_error", `cache slot "${this.id}" failed ${tool}: ${textOf(result) ?? "no detail"}`);
        }
        if (typeof payload !== "object" || payload === null) throw new CacheError("store_error", `cache slot "${this.id}" answered ${tool} with no JSON object`);
        return payload as T;
    }
}

function textOf(result: { content?: readonly unknown[] }): string | undefined {
    const block = result.content?.find((item) => (item as { type?: unknown }).type === "text") as { text?: unknown } | undefined;
    return typeof block?.text === "string" ? block.text : undefined;
}

function payloadOf(result: { content?: readonly unknown[]; structuredContent?: unknown }): unknown {
    if (typeof result.structuredContent === "object" && result.structuredContent !== null) return result.structuredContent;
    const text = textOf(result);
    if (text === undefined) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}
