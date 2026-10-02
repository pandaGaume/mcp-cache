import { LoopbackTransport, McpClient, McpServerBuilder } from "@cyanmycelium/mcp-core";
import { CacheBehavior, CacheSlotStore, MemoryCacheStore, type ICacheStore } from "@cyanmycelium/mcp-cache";
import { openGuard } from "@cyanmycelium/mcp-uns";
import { describeCacheStoreConformance } from "@cyanmycelium/mcp-cache/conformance";

describeCacheStoreConformance("MemoryCacheStore", () => new MemoryCacheStore());
describeCacheStoreConformance(
    "MemoryCacheStore with limits",
    () => new MemoryCacheStore({ maxEntries: 100, defaultTtlMs: 60_000, limits: { maxIdsPerCall: 20, maxValueBytes: 1024, maxTtlMs: 120_000, maxScanItems: 3 } })
);

/** A store published by CacheBehavior, reached back through MCP: the two forms of the contract must agree. */
async function throughSlot(store: ICacheStore): Promise<ICacheStore> {
    const [serverEnd, clientEnd] = LoopbackTransport.createPair();
    const server = new McpServerBuilder().withName("cache").withTransport(serverEnd).register(new CacheBehavior(store, openGuard())).build();
    await server.start();
    const client = new McpClient({ name: "conformance", version: "0.1.0" }, clientEnd, 5_000);
    await client.connect();
    const remote = new CacheSlotStore("cache", client);
    return {
        id: remote.id,
        getCapabilitiesAsync: (signal) => remote.getCapabilitiesAsync(signal),
        getAsync: (ids, signal) => remote.getAsync(ids, signal),
        setAsync: (entries, signal) => remote.setAsync(entries, signal),
        deleteAsync: (ids, signal) => remote.deleteAsync(ids, signal),
        scanAsync: (request, signal) => remote.scanAsync(request, signal),
        async closeAsync() {
            client.disconnect();
            await store.closeAsync();
        },
    };
}

describeCacheStoreConformance("MemoryCacheStore through a history slot", () => throughSlot(new MemoryCacheStore()));
