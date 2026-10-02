import { describe, expect, it } from "vitest";
import { MemoryCacheStore, buildCacheDeclaration } from "@cyanmycelium/mcp-cache";

const id = (n: number) => `uns://site1/lru/item${n}`;

describe("MemoryCacheStore", () => {
    it("evicts the least recently used entry past maxEntries, and says it evicts", async () => {
        const store = new MemoryCacheStore({ maxEntries: 2 });
        expect((await store.getCapabilitiesAsync()).evicts).toBe(true);
        await store.setAsync([
            { id: id(1), value: 1 },
            { id: id(2), value: 2 },
        ]);
        await store.getAsync([id(1)]);
        await store.setAsync([{ id: id(3), value: 3 }]);
        expect((await store.getAsync([id(1), id(2), id(3)])).items.map((item) => "hit" in item && item.hit)).toEqual([true, false, true]);
    });

    it("expires on its clock", async () => {
        let now = Date.parse("2026-01-01T00:00:00.000Z");
        const store = new MemoryCacheStore({ now: () => now });
        await store.setAsync([{ id: id(1), value: 1, ttlMs: 1_000 }]);
        now += 999;
        expect((await store.getAsync([id(1)])).items[0]).toMatchObject({ hit: true, expiresAt: "2026-01-01T00:00:01.000Z" });
        now += 1;
        expect((await store.getAsync([id(1)])).items[0]).toEqual({ id: id(1), hit: false });
    });

    it("refuses a maximum time to live without a default under it", () => {
        expect(() => new MemoryCacheStore({ limits: { maxTtlMs: 1_000 } })).toThrow(/defaultTtlMs/);
        expect(() => new MemoryCacheStore({ defaultTtlMs: 2_000, limits: { maxTtlMs: 1_000 } })).toThrow(/defaultTtlMs/);
    });
});

describe("buildCacheDeclaration", () => {
    it("declares the cache domain over the UNS namespace, and grants nothing", () => {
        expect(buildCacheDeclaration({ version: "1", namespace: "uns://site1" })).toEqual({
            version: "1",
            domain: "cache",
            namespace: { resource: "/site1" },
            capabilities: ["cache.read", "cache.write"],
            protects: [],
            resultsRequired: ["cache.write"],
        });
    });

    it("refuses an incoherent declaration locally", () => {
        expect(() => buildCacheDeclaration({ version: "", namespace: "site1" })).toThrow(/namespace.*version/);
    });
});
