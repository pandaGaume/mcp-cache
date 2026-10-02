export type CacheErrorCode = "invalid_request" | "unsupported_capability" | "limit_exceeded" | "policy_denied" | "authorization_unavailable" | "store_unavailable" | "store_error";

export const CACHE_ERROR_CODES: readonly CacheErrorCode[] = [
    "invalid_request",
    "unsupported_capability",
    "limit_exceeded",
    "policy_denied",
    "authorization_unavailable",
    "store_unavailable",
    "store_error",
];

/** The serialized form of an error, as it travels in a tool result. */
export interface ICacheErrorBody {
    readonly code: CacheErrorCode;
    readonly message: string;
    /** Broker decision that refused the request, when there was one. */
    readonly decisionId?: string;
    readonly detail?: Readonly<Record<string, unknown>>;
}

/** A normalized failure of a cache store. */
export class CacheError extends Error implements ICacheErrorBody {
    readonly code: CacheErrorCode;
    readonly decisionId?: string;
    readonly detail?: Readonly<Record<string, unknown>>;

    constructor(code: CacheErrorCode, message: string, options: { decisionId?: string; detail?: Readonly<Record<string, unknown>> } = {}) {
        super(message);
        this.name = "CacheError";
        this.code = code;
        this.decisionId = options.decisionId;
        this.detail = options.detail;
    }

    toBody(): ICacheErrorBody {
        return {
            code: this.code,
            message: this.message,
            ...(this.decisionId ? { decisionId: this.decisionId } : {}),
            ...(this.detail ? { detail: this.detail } : {}),
        };
    }

    static toBody(error: unknown): ICacheErrorBody {
        if (error instanceof CacheError) return error.toBody();
        return { code: "store_error", message: error instanceof Error ? error.message : String(error) };
    }

    /** Rebuilds the error a slot reported, so a remote store fails like a local one. */
    static fromBody(body: unknown): CacheError {
        const candidate = (typeof body === "object" && body !== null ? body : {}) as Partial<ICacheErrorBody>;
        const code = CACHE_ERROR_CODES.includes(candidate.code as CacheErrorCode) ? (candidate.code as CacheErrorCode) : "store_error";
        const message = typeof candidate.message === "string" ? candidate.message : "the store reported an error without a message";
        return new CacheError(code, message, {
            ...(typeof candidate.decisionId === "string" ? { decisionId: candidate.decisionId } : {}),
            ...(typeof candidate.detail === "object" && candidate.detail !== null ? { detail: candidate.detail } : {}),
        });
    }
}

export function invalid(message: string, detail?: Readonly<Record<string, unknown>>): CacheError {
    return new CacheError("invalid_request", message, detail ? { detail } : {});
}
