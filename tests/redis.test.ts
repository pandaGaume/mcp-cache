import { createClient } from "redis";
import { describe, expect, it } from "vitest";
import { describeCacheStoreConformance } from "@cyanmycelium/mcp-cache/conformance";
import { RedisCacheStore } from "@cyanmycelium/mcp-cache-redis";
import { FakeRedis } from "./fake.redis";

// The store's own logic, on a Redis stand-in that misbehaves the way SCAN may.
describeCacheStoreConformance("RedisCacheStore on a fake Redis", () => new RedisCacheStore(new FakeRedis()));

// The real thing, when a server is reachable. Standard Redis settings, in .env or the environment:
//   REDIS_URL       redis://host:6379, or rediss://host:6380 for TLS
//   REDIS_PASSWORD  optional, the server password or ACL password
//   REDIS_USERNAME  optional, the ACL user
const url = process.env.REDIS_URL?.trim() || undefined;
const password = process.env.REDIS_PASSWORD?.trim() || undefined;
const username = process.env.REDIS_USERNAME?.trim() || undefined;
const credentials = { ...(username ? { username } : {}), ...(password ? { password } : {}) };
if (!url) console.warn("[redis] REDIS_URL not set: the live Redis conformance run is skipped");

let run = 0;
const prefix = () => `mcp-cache-test:${process.pid}:${run}:`;

/** Deletes every key the last test wrote: the server may be shared, and an entry without expiry would stay. */
async function cleanupAsync(): Promise<void> {
    const client = createClient({ url: url!, ...credentials });
    await client.connect();
    try {
        let cursor = "0";
        do {
            const reply = await client.scan(cursor, { MATCH: `${prefix()}*`, COUNT: 500 });
            cursor = String(reply.cursor);
            if (reply.keys.length > 0) await client.unlink(reply.keys.map(String));
        } while (cursor !== "0");
    } finally {
        await client.close();
    }
}

describe.skipIf(!url)("live Redis", () => {
    describeCacheStoreConformance(
        "RedisCacheStore on a live Redis",
        () => {
            run++;
            return RedisCacheStore.connectAsync(url!, { prefix: prefix(), ...credentials });
        },
        { cleanupAsync, shortTtlMs: 1_000 }
    );
});

describe("RedisCacheStore", () => {
    it("keeps two caches on one server apart by prefix", async () => {
        const redis = new FakeRedis();
        const a = new RedisCacheStore(redis, { prefix: "a:" });
        const b = new RedisCacheStore(redis, { prefix: "b:" });
        await a.setAsync([{ id: "uns://site1/x", value: 1 }]);
        expect((await b.getAsync(["uns://site1/x"])).items[0]).toEqual({ id: "uns://site1/x", hit: false });
        expect((await b.scanAsync({})).ids).toEqual([]);
    });

    it("treats a foreign key under its prefix as absent", async () => {
        const redis = new FakeRedis();
        await redis.set("mcp-cache:uns://site1/x", "not json", null);
        const store = new RedisCacheStore(redis);
        expect((await store.getAsync(["uns://site1/x"])).items[0]).toEqual({ id: "uns://site1/x", hit: false });
    });

    it("turns a dead connection into store_unavailable", async () => {
        const redis = new FakeRedis();
        redis.mGet = async () => {
            throw new Error("ECONNREFUSED");
        };
        const error = await new RedisCacheStore(redis).getAsync(["uns://site1/x"]).catch((e: unknown) => e);
        expect(error).toMatchObject({ code: "store_unavailable" });
    });
});
