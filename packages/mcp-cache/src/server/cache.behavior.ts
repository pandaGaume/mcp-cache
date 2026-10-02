import {
    McpAdapterBase,
    McpBehavior,
    McpToolResults,
    type IMcpRequestContext,
    type McpResource,
    type McpResourceContent,
    type McpTool,
    type McpToolResult,
} from "@cyanmycelium/mcp-core";
import { AccessUnavailableError, UnsPath, unsChecks, type AccessOutcome, type IAccessDecision, type IAccessGuard, type UnsId } from "@cyanmycelium/mcp-uns";
import type { ICacheStore } from "../contract/cache.store";
import type { CacheGetItem, ICacheDeleteResult, ICacheItemError, ICacheScanResult, ICacheSetResult, ICacheWrite, IRejectedWrite } from "../contract/cache.types";
import { CacheError, invalid } from "../contract/errors";
import { parseIds } from "../contract/validation";
import { CACHE_CAPABILITIES } from "./declaration";

export const CACHE_CAPABILITIES_URI = "cache://capabilities";

interface IGuarded {
    readonly allowed: UnsId[];
    readonly decisions: Map<UnsId, IAccessDecision>;
    readonly denied: ICacheItemError[];
}

function denial(id: UnsId, decision: IAccessDecision): ICacheItemError {
    return {
        id,
        error: {
            code: "policy_denied",
            message: `access to ${id} was refused`,
            ...(decision.decisionId ? { decisionId: decision.decisionId } : {}),
            detail: { reason: decision.reason },
        },
    };
}

function inRequestOrder<T extends { readonly id: UnsId }>(ids: readonly UnsId[], items: readonly T[], denied: readonly ICacheItemError[]): (T | ICacheItemError)[] {
    const byId = new Map<UnsId, T | ICacheItemError>();
    for (const item of items) byId.set(item.id, item);
    for (const item of denied) byId.set(item.id, item);
    return ids.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
}

class CacheAdapter extends McpAdapterBase {
    constructor(
        private readonly _store: ICacheStore,
        private readonly _guard: IAccessGuard
    ) {
        super("cache");
    }

    async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        if (uri !== CACHE_CAPABILITIES_URI) return undefined;
        return { uri, mimeType: "application/json", text: JSON.stringify(await this._store.getCapabilitiesAsync()) };
    }

    async executeToolAsync(_uri: string, toolName: string, args: Record<string, unknown>, request?: IMcpRequestContext): Promise<McpToolResult> {
        try {
            switch (toolName) {
                case "cache.capabilities":
                    return McpToolResults.json(await this._store.getCapabilitiesAsync());
                case "cache.get":
                    return McpToolResults.json(await this._getAsync(args, request));
                case "cache.set":
                    return McpToolResults.json(await this._setAsync(args, request));
                case "cache.delete":
                    return McpToolResults.json(await this._deleteAsync(args, request));
                case "cache.scan":
                    return McpToolResults.json(await this._scanAsync(args, request));
                default:
                    return McpToolResults.error(`unknown tool: ${toolName}`);
            }
        } catch (error) {
            return { content: [{ type: "text", text: JSON.stringify({ error: CacheError.toBody(error) }) }], isError: true };
        }
    }

    private async _guardAsync(capability: string, ids: readonly UnsId[], request: IMcpRequestContext | undefined): Promise<IGuarded> {
        let answers: IAccessDecision[];
        try {
            answers = await this._guard.authorizeAsync(unsChecks(capability, ids), request);
        } catch (error) {
            if (error instanceof AccessUnavailableError) throw new CacheError("authorization_unavailable", error.message);
            throw error;
        }
        const decisions = new Map<UnsId, IAccessDecision>();
        const allowed: UnsId[] = [];
        const denied: ICacheItemError[] = [];
        ids.forEach((id, index) => {
            const decision = answers[index] ?? { allowed: false, reason: "no-decision" };
            decisions.set(id, decision);
            if (decision.allowed) allowed.push(id);
            else denied.push(denial(id, decision));
        });
        return { allowed, decisions, denied };
    }

    private async _getAsync(args: Record<string, unknown>, request: IMcpRequestContext | undefined): Promise<{ items: CacheGetItem[] }> {
        const ids = parseIds(args.ids, Number.POSITIVE_INFINITY);
        const guarded = await this._guardAsync(CACHE_CAPABILITIES.read, ids, request);
        const served = guarded.allowed.length > 0 ? (await this._store.getAsync(guarded.allowed)).items : [];
        return { items: inRequestOrder(ids, served, guarded.denied) };
    }

    /** Scan is filtered after the fact: an id the caller may not read is left out, as if it were not cached. */
    private async _scanAsync(args: Record<string, unknown>, request: IMcpRequestContext | undefined): Promise<ICacheScanResult> {
        const result = await this._store.scanAsync(args as never);
        if (result.ids.length === 0) return result;
        const guarded = await this._guardAsync(CACHE_CAPABILITIES.read, [...new Set(result.ids)], request);
        const allowed = new Set(guarded.allowed);
        return { ids: result.ids.filter((id) => allowed.has(id)), cursor: result.cursor };
    }

    private async _setAsync(args: Record<string, unknown>, request: IMcpRequestContext | undefined): Promise<ICacheSetResult> {
        const entries = args.entries;
        if (!Array.isArray(entries)) throw invalid("entries must be an array");

        // Only well-formed ids are put to the broker; the store rejects the others with its own reason.
        const idOf = (entry: unknown) => (typeof entry === "object" && entry !== null ? (entry as ICacheWrite).id : undefined);
        const ids = [...new Set(entries.map(idOf).filter((id): id is UnsId => typeof id === "string" && UnsPath.tryParse(id)?.id === id))];
        const guarded = await this._guardAsync(CACHE_CAPABILITIES.write, ids, request);

        const forwarded: ICacheWrite[] = [];
        const origin: number[] = [];
        const rejected: IRejectedWrite[] = [];
        entries.forEach((entry, index) => {
            const id = idOf(entry);
            const decision = typeof id === "string" ? guarded.decisions.get(id) : undefined;
            if (decision && !decision.allowed) {
                rejected.push({ index, error: denial(id!, decision).error });
                return;
            }
            forwarded.push(entry as ICacheWrite);
            origin.push(index);
        });

        let result: ICacheSetResult = { stored: 0, rejected: [] };
        if (forwarded.length > 0) {
            try {
                result = await this._store.setAsync(forwarded);
            } catch (error) {
                this._reportAll(guarded, "failure", CacheError.toBody(error).code);
                throw error;
            }
        }
        const failed = new Map<UnsId, string>();
        const storeRejected = result.rejected.map((item) => {
            const index = origin[item.index]!;
            const id = idOf(entries[index]);
            if (typeof id === "string" && !failed.has(id)) failed.set(id, item.error.code);
            return { index, error: item.error };
        });
        for (const id of guarded.allowed) {
            const errorCode = failed.get(id);
            this._guard.report(guarded.decisions.get(id)!, errorCode ? "failure" : "success", errorCode);
        }
        return { stored: result.stored, rejected: [...rejected, ...storeRejected].sort((a, b) => a.index - b.index) };
    }

    private async _deleteAsync(args: Record<string, unknown>, request: IMcpRequestContext | undefined): Promise<ICacheDeleteResult> {
        const ids = parseIds(args.ids, Number.POSITIVE_INFINITY);
        const guarded = await this._guardAsync(CACHE_CAPABILITIES.write, ids, request);
        if (guarded.allowed.length === 0) return { deleted: 0, errors: guarded.denied };

        let result: ICacheDeleteResult;
        try {
            result = await this._store.deleteAsync(guarded.allowed);
        } catch (error) {
            this._reportAll(guarded, "failure", CacheError.toBody(error).code);
            throw error;
        }
        const failed = new Map(result.errors.map((item) => [item.id, item.error.code]));
        for (const id of guarded.allowed) {
            const errorCode = failed.get(id);
            this._guard.report(guarded.decisions.get(id)!, errorCode ? "failure" : "success", errorCode);
        }
        return { deleted: result.deleted, errors: inRequestOrder(ids, result.errors, guarded.denied) };
    }

    private _reportAll(guarded: IGuarded, outcome: AccessOutcome, errorCode: string): void {
        for (const id of guarded.allowed) this._guard.report(guarded.decisions.get(id)!, outcome, errorCode);
    }
}

/**
 * The MCP surface of cache.v1: publishes any {@link ICacheStore} as a slot.
 *
 * Every operation that names ids asks the guard first, one check per id, and
 * serves only the allowed ones; the refused ids come back as per-id errors.
 * Writes report their outcome under the decision that allowed them.
 */
export class CacheBehavior extends McpBehavior {
    constructor(store: ICacheStore, guard: IAccessGuard) {
        super(new CacheAdapter(store, guard), { namespace: "cache" });
    }

    protected override _buildResources(): McpResource[] {
        return [{ uri: CACHE_CAPABILITIES_URI, name: "Cache capabilities", description: "cache.v1 capabilities of the store behind this slot.", mimeType: "application/json" }];
    }

    protected override _buildTools(): McpTool[] {
        const ids = { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true, description: "UNS ids, e.g. uns://site1/line1/motor01/speed" };
        return [
            {
                name: "cache.capabilities",
                description: "What the store behind this slot offers: shared or not, default and maximum time to live, eviction, limits.",
                inputSchema: { type: "object", properties: {} },
            },
            {
                name: "cache.get",
                description: "Read cached values by UNS id. Each id answers hit (value, storedAt, expiresAt), miss, or a refusal; a miss never says why.",
                inputSchema: { type: "object", properties: { ids }, required: ["ids"] },
            },
            {
                name: "cache.set",
                description: "Cache JSON values under UNS ids, each with an optional ttlMs. Replaces value and expiry. Each refused entry is reported with its index.",
                inputSchema: {
                    type: "object",
                    properties: {
                        entries: {
                            type: "array",
                            items: { type: "object", properties: { id: { type: "string" }, value: {}, ttlMs: { type: "integer", minimum: 1 } }, required: ["id", "value"] },
                            minItems: 1,
                        },
                    },
                    required: ["entries"],
                },
            },
            {
                name: "cache.delete",
                description: "Remove cached entries by UNS id. An id with nothing cached is not an error.",
                inputSchema: { type: "object", properties: { ids }, required: ["ids"] },
            },
            {
                name: "cache.scan",
                description: "List the live cached ids under a UNS root, by whole segments. Unordered, an id may repeat across pages; pass cursor back until it is null.",
                inputSchema: {
                    type: "object",
                    properties: { root: { type: "string" }, limit: { type: "integer", minimum: 1 }, cursor: { type: "string", description: "Opaque, from the previous page." } },
                },
            },
        ];
    }
}
