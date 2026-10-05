[![npm](https://img.shields.io/npm/v/@cyanmycelium/mcp-cache-redis)](https://www.npmjs.com/package/@cyanmycelium/mcp-cache-redis)
[![CI](https://github.com/pandaGaume/mcp-cache/actions/workflows/ci.yml/badge.svg)](https://github.com/pandaGaume/mcp-cache/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

# @cyanmycelium/mcp-cache-redis

Redis store for the [cache.v1](https://github.com/pandaGaume/mcp-cache) contract: one cache shared by every process that reaches the server, expiry kept by the server (`SET ... PX`). Entries are addressed by UNS id ([mcp-uns](https://github.com/pandaGaume/mcp-uns)).

```ts
import { RedisCacheStore } from "@cyanmycelium/mcp-cache-redis";

const store = await RedisCacheStore.connectAsync("rediss://cache.example.com:6380", { password, prefix: "site1:" });
await store.setAsync([{ id: "uns://site1/line1/motor01/speed", value: 1480, ttlMs: 60_000 }]);
const { items } = await store.getAsync(["uns://site1/line1/motor01/speed"]);
```

- `url` is a standard Redis URL: `redis://` or `rediss://` for TLS. `password` and `username` (ACL) may be given apart.
- Each UNS id is one key, `<prefix><uns id>`; two caches on one database need two prefixes.
- `scan` is a Redis `SCAN` filtered to whole UNS segments: no order, and an id may repeat across pages.
- Any client can be plugged in through `IRedisCommands`; `fromNodeRedis(client)` adapts a node-redis client.

Publish it as an MCP slot with `CacheBehavior` from [@cyanmycelium/mcp-cache](https://www.npmjs.com/package/@cyanmycelium/mcp-cache). It passes the cache.v1 conformance suite, on a fake Redis and against a live server.

License: Apache-2.0.
