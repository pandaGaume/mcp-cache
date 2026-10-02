import type { IRedisCommands } from "@cyanmycelium/mcp-cache-redis";

function globToRegExp(glob: string): RegExp {
    let source = "";
    for (let i = 0; i < glob.length; i++) {
        const char = glob[i]!;
        if (char === "\\") source += glob[++i]!.replace(/[.*+?^${}()|[\]\/]/g, "\$&");
        else if (char === "*") source += ".*";
        else if (char === "?") source += ".";
        else source += char.replace(/[.*+?^${}()|[\]\/]/g, "\$&");
    }
    return new RegExp(`^${source}$`);
}

/**
 * Just enough Redis for the store: SET PX, MGET, UNLINK, SCAN. SCAN behaves
 * as badly as the real one is allowed to: it returns more keys than COUNT,
 * and repeats some across pages.
 */
export class FakeRedis implements IRedisCommands {
    private readonly _keys = new Map<string, { value: string; expiresAt: number | null }>();

    async set(key: string, value: string, ttlMs: number | null): Promise<unknown> {
        this._keys.set(key, { value, expiresAt: ttlMs === null ? null : Date.now() + ttlMs });
        return "OK";
    }

    async mGet(keys: string[]): Promise<(string | null)[]> {
        return keys.map((key) => this._live(key)?.value ?? null);
    }

    async unlink(keys: string[]): Promise<number> {
        let count = 0;
        for (const key of keys) if (this._live(key) && this._keys.delete(key)) count++;
        return count;
    }

    async scan(cursor: string, match: string, count: number): Promise<{ cursor: string; keys: string[] }> {
        const pattern = globToRegExp(match);
        // Expired keys linger until touched, as in Redis: SCAN may see them.
        const all = [...this._keys.keys()].sort();
        const start = Number(cursor);
        const end = Math.min(all.length, start + count + 2);
        const keys = all.slice(Math.max(0, start - 1), end).filter((key) => pattern.test(key));
        return { cursor: end >= all.length ? "0" : String(end), keys };
    }

    async close(): Promise<void> {}

    private _live(key: string) {
        const entry = this._keys.get(key);
        if (entry && entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
            this._keys.delete(key);
            return undefined;
        }
        return entry;
    }
}
