import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ICacheStore } from "../contract/cache.store";
import { isItemError, type CacheGetItem, type ICacheCapabilities, type ICacheHit } from "../contract/cache.types";
import { CacheError } from "../contract/errors";

export interface ICacheConformanceOptions {
    /** Called after each test, after `closeAsync`: flush a Redis database, drop a key prefix... */
    readonly cleanupAsync?: () => Promise<void>;
    /** The short time to live the expiry tests use. Raise it for a store far away. Default 150 ms. */
    readonly shortTtlMs?: number;
}

const A = "uns://site1/line1/motor01/speed";
const B = "uns://site1/line1/motor01/temperature";
const C = "uns://site1/line1/motor01/state";
const SIBLING = "uns://site1/line1/motor01x/speed";
const OTHER = "uns://site2/line1/pump01/flow";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function rejection(promise: Promise<unknown>): Promise<CacheError> {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(CacheError);
        return error as CacheError;
    }
    throw new Error("expected the call to reject with a CacheError");
}

function hit(item: CacheGetItem | undefined): ICacheHit {
    if (!item || isItemError(item) || !item.hit) throw new Error(`expected a hit, got ${JSON.stringify(item)}`);
    return item;
}

/**
 * The cache.v1 conformance suite: what every store must do, whatever it keeps
 * its entries in. A store passes it directly, and again through a slot
 * (`CacheBehavior` + `CacheSlotStore`).
 *
 * Expiry is tested in real time, with a short time to live, so that a store
 * whose clock is a server's (Redis) is tested the same way as one in memory.
 *
 * @param factory returns a new, empty store for each test
 */
export function describeCacheStoreConformance(name: string, factory: () => ICacheStore | Promise<ICacheStore>, options: ICacheConformanceOptions = {}): void {
    const ttl = options.shortTtlMs ?? 150;

    describe(`cache.v1 conformance: ${name}`, () => {
        let store: ICacheStore;
        let capabilities: ICacheCapabilities;

        beforeEach(async () => {
            store = await factory();
            capabilities = await store.getCapabilitiesAsync();
        });

        afterEach(async () => {
            // A factory that failed left no store: let its own error be the one reported.
            await store?.closeAsync();
            await options.cleanupAsync?.();
        });

        describe("capabilities", () => {
            it("declares cache.v1 with positive limits", () => {
                expect(capabilities.interface).toBe("cache.v1");
                expect(capabilities.store).toEqual(expect.any(String));
                expect(typeof capabilities.shared).toBe("boolean");
                expect(capabilities.limits.maxIdsPerCall).toBeGreaterThan(0);
                expect(capabilities.limits.maxValueBytes).toBeGreaterThan(0);
                expect(capabilities.limits.maxScanItems).toBeGreaterThan(0);
            });
        });

        describe("set and get", () => {
            it("gives back every JSON value as it was set, null included", async () => {
                const values = [42.5, "running", true, null, { mode: "auto", steps: [1, 2, { x: "é" }] }, [1, "two", false]];
                const ids = values.map((_, index) => `uns://site1/values/v${index}`);
                expect(await store.setAsync(values.map((value, index) => ({ id: ids[index]!, value })))).toEqual({ stored: values.length, rejected: [] });
                const { items } = await store.getAsync(ids);
                expect(items.map((item) => hit(item).value)).toEqual(values);
            });

            it("answers one item per id, in the order asked, misses included", async () => {
                await store.setAsync([{ id: B, value: 2 }]);
                const { items } = await store.getAsync([A, B, C]);
                expect(items).toEqual([{ id: A, hit: false }, expect.objectContaining({ id: B, hit: true, value: 2 }), { id: C, hit: false }]);
            });

            it("stamps the entry: storedAt now, expiresAt from the time to live", async () => {
                const before = Date.now();
                await store.setAsync([
                    { id: A, value: 1, ttlMs: 60_000 },
                    { id: B, value: 2 },
                ]);
                const [a, b] = (await store.getAsync([A, B])).items.map(hit);
                const storedAt = Date.parse(a!.storedAt);
                expect(a!.storedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
                expect(Math.abs(storedAt - before)).toBeLessThan(5_000);
                expect(Date.parse(a!.expiresAt!) - storedAt).toBeGreaterThan(59_000);
                expect(Date.parse(a!.expiresAt!) - storedAt).toBeLessThanOrEqual(60_000);
                if (capabilities.defaultTtlMs === null) expect(b!.expiresAt).toBeNull();
                else expect(b!.expiresAt).not.toBeNull();
            });

            it("replaces value and expiry on a second set", async () => {
                await store.setAsync([{ id: A, value: "first", ttlMs: 60_000 }]);
                await store.setAsync([{ id: A, value: "second" }]);
                const entry = hit((await store.getAsync([A])).items[0]);
                expect(entry.value).toBe("second");
                if (capabilities.defaultTtlMs === null) expect(entry.expiresAt).toBeNull();
            });

            it("rejects malformed entries one by one and keeps the others", async () => {
                const result = await store.setAsync([
                    { id: A, value: 1 },
                    { id: "site1/line1", value: 2 },
                    { id: B } as never,
                    { id: C, value: 3, ttlMs: 0 },
                    { id: "uns://site1/x", value: 4, ttlMs: 1.5 },
                    { id: "uns://site1/y", value: 5, ttlMs: 60_000 },
                ]);
                expect(result.stored).toBe(2);
                expect(result.rejected.map((item) => item.index)).toEqual([1, 2, 3, 4]);
                for (const item of result.rejected) expect(item.error.code).toBe("invalid_request");
                expect((await store.getAsync([A, "uns://site1/y"])).items.every((item) => !isItemError(item) && item.hit)).toBe(true);
            });

            it("rejects a value over the size limit, per entry", async () => {
                const big = "x".repeat(capabilities.limits.maxValueBytes);
                const result = await store.setAsync([
                    { id: A, value: big },
                    { id: B, value: "small" },
                ]);
                expect(result.stored).toBe(1);
                expect(result.rejected).toEqual([{ index: 0, error: expect.objectContaining({ code: "limit_exceeded" }) }]);
            });

            it("rejects a time to live over the store maximum, per entry", async () => {
                const max = capabilities.limits.maxTtlMs;
                if (max === null) return;
                const result = await store.setAsync([{ id: A, value: 1, ttlMs: max + 1 }]);
                expect(result.rejected).toEqual([{ index: 0, error: expect.objectContaining({ code: "limit_exceeded" }) }]);
            });

            it("refuses a set that names the same id twice", async () => {
                expect(
                    (
                        await rejection(
                            store.setAsync([
                                { id: A, value: 1 },
                                { id: A, value: 2 },
                            ])
                        )
                    ).code
                ).toBe("invalid_request");
            });
        });

        describe("expiry", () => {
            it("serves an entry until its time to live, then misses it everywhere", async () => {
                await store.setAsync([
                    { id: A, value: "short", ttlMs: ttl },
                    { id: B, value: "long", ttlMs: 60_000 },
                ]);
                expect(hit((await store.getAsync([A])).items[0]).value).toBe("short");
                await sleep(ttl * 2 + 100);
                expect((await store.getAsync([A, B])).items).toEqual([{ id: A, hit: false }, expect.objectContaining({ id: B, hit: true })]);
                const scanned = new Set<string>();
                let cursor: string | undefined;
                do {
                    const page = await store.scanAsync({ root: "uns://site1", ...(cursor ? { cursor } : {}) });
                    page.ids.forEach((id) => scanned.add(id));
                    cursor = page.cursor ?? undefined;
                } while (cursor);
                expect([...scanned]).toEqual([B]);
                expect((await store.deleteAsync([A])).deleted).toBe(0);
            });
        });

        describe("delete", () => {
            it("counts only what existed, and misses it afterwards", async () => {
                await store.setAsync([
                    { id: A, value: 1 },
                    { id: B, value: 2 },
                ]);
                expect(await store.deleteAsync([A, C])).toEqual({ deleted: 1, errors: [] });
                expect((await store.getAsync([A, B])).items.map((item) => !isItemError(item) && item.hit)).toEqual([false, true]);
            });
        });

        describe("scan", () => {
            async function scanAll(root: string | undefined, limit?: number): Promise<string[]> {
                const seen: string[] = [];
                let cursor: string | undefined;
                let pages = 0;
                do {
                    const page = await store.scanAsync({ ...(root ? { root } : {}), ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) });
                    if (limit) expect(page.ids.length).toBeLessThanOrEqual(limit);
                    seen.push(...page.ids);
                    cursor = page.cursor ?? undefined;
                    expect(++pages).toBeLessThan(1_000);
                } while (cursor);
                return seen;
            }

            it("lists the live ids under a root, by whole segments", async () => {
                await store.setAsync([A, B, C, SIBLING, OTHER].map((id) => ({ id, value: 1 })));
                expect(new Set(await scanAll("uns://site1/line1/motor01"))).toEqual(new Set([A, B, C]));
                expect(new Set(await scanAll(undefined))).toEqual(new Set([A, B, C, SIBLING, OTHER]));
            });

            it("pages through every id at least once, whatever the order", async () => {
                const ids = Array.from({ length: 7 }, (_, index) => `uns://site1/scan/item${index}`);
                await store.setAsync(ids.map((id) => ({ id, value: 1 })));
                expect(new Set(await scanAll("uns://site1/scan", 2))).toEqual(new Set(ids));
            });
        });

        describe("request validation", () => {
            const cases: [string, () => Promise<unknown>][] = [
                ["no ids", () => store.getAsync([])],
                ["a non-canonical id", () => store.getAsync(["uns://site1/line1/"])],
                ["a duplicated id", () => store.getAsync([A, A])],
                ["a non-canonical root", () => store.scanAsync({ root: "site1" })],
                ["a forged cursor", () => store.scanAsync({ cursor: "not-a-cursor" })],
            ];
            for (const [label, call] of cases) {
                it(`refuses ${label} with invalid_request`, async () => {
                    expect((await rejection(call())).code).toBe("invalid_request");
                });
            }

            it("refuses more ids than the store allows", async () => {
                const ids = Array.from({ length: capabilities.limits.maxIdsPerCall + 1 }, (_, index) => `uns://site1/many/i${index}`);
                expect((await rejection(store.getAsync(ids))).code).toBe("limit_exceeded");
            });
        });

        describe("isolation", () => {
            it("does not share objects with its callers", async () => {
                const value = { mode: "auto" };
                await store.setAsync([{ id: A, value }]);
                value.mode = "changed";
                const first = hit((await store.getAsync([A])).items[0]);
                (first.value as { mode: string }).mode = "mutated";
                expect(hit((await store.getAsync([A])).items[0]).value).toEqual({ mode: "auto" });
            });
        });
    });
}
