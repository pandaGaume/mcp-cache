<p align="center">
  <img src="https://raw.githubusercontent.com/pandaGaume/mcp-cache/main/docs/assets/logo.png" alt="mcp-cache logo: the network-discovery panda holding a lightning bolt, a memory chip glowing on its chest" width="180">
</p>

# mcp-cache

Cache slots for an [mcp-broker](https://github.com/pandaGaume/mcp-broker): one contract, `cache.v1`, for values kept by UNS id with a time to live, and pluggable stores.

```text
MCP client ──> mcp-broker ──> slot "cache" (CacheBehavior)
                                  │  one broker decision per UNS id, audited
                                  └──> ICacheStore: memory, Redis
```

Entries are addressed by UNS id, like SCADA values and their [history](https://github.com/pandaGaume/mcp-history): one broker policy governs the live value, its history and its cached copy. UNS ids and broker-decided access come from [mcp-uns](https://github.com/pandaGaume/mcp-uns).

Design and decisions: [docs/brief_cache_slot.md](https://github.com/pandaGaume/mcp-cache/blob/main/docs/brief_cache_slot.md) (French).

## Packages

| package | what |
|---|---|
| `@cyanmycelium/mcp-cache` | the contract, `MemoryCacheStore`, `CacheBehavior`, `CacheSlotStore`, the declaration, and the conformance suite under `/conformance` |
| `@cyanmycelium/mcp-cache-redis` | `RedisCacheStore`: one cache shared by every process, expiry kept by the server |

## Use

```ts
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";
import { McpServerBuilder } from "@cyanmycelium/mcp-core";
import { CacheBehavior, buildCacheDeclaration } from "@cyanmycelium/mcp-cache";
import { RedisCacheStore } from "@cyanmycelium/mcp-cache-redis";
import { BrokerAccessGuard } from "@cyanmycelium/mcp-uns";

const store = await RedisCacheStore.connectAsync("redis://127.0.0.1:6379", { prefix: "site1:" });
const transport = new DirectTransport("ws://localhost:3000/provider/cache", { secret });
const server = new McpServerBuilder().withName("cache").withTransport(transport).register(new CacheBehavior(store, new BrokerAccessGuard(transport.broker))).build();
await server.start();
await transport.broker.declare(buildCacheDeclaration({ version: "1", namespace: "uns://site1" }));
```

## Tools

| tool | broker capability, checked per id |
|---|---|
| `cache.capabilities` | none |
| `cache.get` | `cache.read`: each id answers hit, miss, or a refusal |
| `cache.scan` | `cache.read` (ids you may not read are left out) |
| `cache.set`, `cache.delete` | `cache.write`, outcome reported |

## Develop

```sh
npm install
npm run typecheck
npm test
npm run build
```

The Redis store runs the conformance suite on a fake Redis that misbehaves the way `SCAN` may. Against a real server, give the standard Redis settings in the environment or in a `.env` file at the root, which git ignores:

```sh
REDIS_URL=rediss://my-cache.example.com:6380
REDIS_PASSWORD=<password>
```

`REDIS_URL` carries its scheme: `rediss://` for TLS (Azure Cache for Redis on 6380, for one), `redis://` otherwise. `REDIS_PASSWORD` and `REDIS_USERNAME` (for an ACL user) are optional. Each test writes under its own key prefix and deletes its keys afterwards.

`tests/broker.test.ts` starts a real broker with `@cyanmycelium/mcp-broker/testing`.

## License

Apache-2.0.
