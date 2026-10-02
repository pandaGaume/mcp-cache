import { UnsPath, type UnsId } from "@cyanmycelium/mcp-uns";

export const CACHE_DOMAIN = "cache";

export const CACHE_CAPABILITIES = {
    /** `get`, `scan`. */
    read: "cache.read",
    /** `set`, `delete`. */
    write: "cache.write",
} as const;

/** Mutations: the broker expects their outcome, and flags a decision left without one. */
export const CACHE_RESULTS_REQUIRED = [CACHE_CAPABILITIES.write] as const;

export interface ICacheDeclarationInput {
    /** Version string of this declaration; the broker echoes it back. */
    readonly version: string;
    /** UNS subtree this slot serves; the broker refuses any check outside it. */
    readonly namespace: UnsId;
    /** Storage slots only this slot may call; each must already be in the broker's `protectedSlots`. */
    readonly protects?: readonly string[];
}

/**
 * The `broker/authorization/declare` payload of a cache slot, shaped as
 * mcp-broker-provider's `IAuthorizationDeclaration`.
 *
 * Descriptive only: an address space, a capability vocabulary and the slots
 * to protect, never a grant. The cache shares the UNS address space with
 * SCADA and history, so an assignment on `/site1/line1/**` governs a value,
 * its history and its cached copy alike.
 */
export function buildCacheDeclaration(input: ICacheDeclarationInput) {
    const problems: string[] = [];
    const namespace = UnsPath.tryParse(input.namespace);
    if (!namespace) problems.push(`namespace "${input.namespace}" is not a UNS id`);
    if (!input.version) problems.push("version is required");
    const protects = [...new Set(input.protects ?? [])];
    for (const slot of protects) {
        if (!slot || slot.startsWith("_")) problems.push(`slot "${slot}" cannot be protected`);
    }
    if (problems.length > 0) throw new Error(`declaration refused locally: ${problems.join("; ")}`);
    return {
        version: input.version,
        domain: CACHE_DOMAIN,
        namespace: { resource: namespace!.resourcePath },
        capabilities: Object.values(CACHE_CAPABILITIES),
        protects,
        resultsRequired: [...CACHE_RESULTS_REQUIRED],
    };
}
