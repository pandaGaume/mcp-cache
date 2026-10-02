import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestBroker, type ITestBroker } from "@cyanmycelium/mcp-broker/testing";
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";
import { McpClient, McpServerBuilder, type IMcpServer } from "@cyanmycelium/mcp-core";
import { StreamableHttpTransport } from "@cyanmycelium/mcp-core/node";
import { BrokerAccessGuard } from "@cyanmycelium/mcp-uns";
import { CacheBehavior, CacheSlotStore, MemoryCacheStore, buildCacheDeclaration, isItemError } from "@cyanmycelium/mcp-cache";

const LINE1 = "uns://site1/line1/motor01/speed";
const LINE2 = "uns://site1/line2/motor01/speed";

/** The cache slot behind a real broker: the broker decides each id, the slot applies. */
describe("cache slot under broker policy", () => {
    let broker: ITestBroker;
    let server: IMcpServer;
    const clients: McpClient[] = [];

    async function as(caller: string): Promise<CacheSlotStore> {
        const client = new McpClient({ name: caller, version: "0.1.0" }, new StreamableHttpTransport(broker.mcpUrl("cache"), { headers: broker.bearer(caller) }), 5_000);
        await client.connect();
        clients.push(client);
        return new CacheSlotStore("cache", client);
    }

    beforeAll(async () => {
        broker = await startTestBroker({
            callers: { scada: { service: "mcp-scada" }, operator: { groups: ["operators-line1"] } },
            providers: { "mcp-cache": { subjects: ["service:mcp-cache"], allowedResources: ["/site1/**"] } },
            policy: {
                slotResources: { cache: "/site1/cache" },
                roles: {
                    caller: { capabilities: ["mcp.tools.call", "mcp.tools.list"] },
                    reader: { capabilities: ["cache.read"] },
                    writer: { inherits: ["reader"], capabilities: ["cache.write"] },
                },
                assignments: [
                    { id: "scada-slot", subject: "service:mcp-scada", role: "caller", resource: "/site1/cache" },
                    { id: "scada-site", subject: "service:mcp-scada", role: "writer", resource: "/site1/**" },
                    { id: "operators-slot", subject: "group:operators-line1", role: "caller", resource: "/site1/cache" },
                    { id: "operators-line1", subject: "group:operators-line1", role: "reader", resource: "/site1/line1/**" },
                ],
            },
        });
        const transport = new DirectTransport(broker.providerUrl("cache"), { secret: broker.providerSecret("mcp-cache") });
        server = new McpServerBuilder()
            .withName("cache")
            .withTransport(transport)
            .register(new CacheBehavior(new MemoryCacheStore(), new BrokerAccessGuard(transport.broker)))
            .build();
        await server.start();
        expect((await transport.broker.declare(buildCacheDeclaration({ version: "1", namespace: "uns://site1" }))).accepted).toBe(true);
    });

    afterAll(async () => {
        for (const client of clients) client.disconnect();
        await broker?.stop();
    });

    it("lets the writer cache values anywhere in the namespace", async () => {
        const scada = await as("scada");
        expect(
            await scada.setAsync([
                { id: LINE1, value: 1480 },
                { id: LINE2, value: 1520, ttlMs: 60_000 },
            ])
        ).toEqual({ stored: 2, rejected: [] });
    });

    it("serves the ids the operator may read and refuses the others one by one", async () => {
        const operator = await as("operator");
        const { items } = await operator.getAsync([LINE1, LINE2]);
        expect(items[0]).toMatchObject({ id: LINE1, hit: true, value: 1480 });
        expect(isItemError(items[1]!) && items[1].error).toMatchObject({ code: "policy_denied", decisionId: expect.any(String) });
    });

    it("hides from scan what the operator may not read", async () => {
        const operator = await as("operator");
        expect((await operator.scanAsync({ root: "uns://site1" })).ids).toEqual([LINE1]);
    });

    it("refuses writes from a reader, entry by entry and id by id", async () => {
        const operator = await as("operator");
        expect(await operator.setAsync([{ id: LINE1, value: 0 }])).toEqual({ stored: 0, rejected: [{ index: 0, error: expect.objectContaining({ code: "policy_denied" }) }] });
        const refused = await operator.deleteAsync([LINE1]);
        expect(refused.deleted).toBe(0);
        expect(refused.errors).toEqual([expect.objectContaining({ id: LINE1, error: expect.objectContaining({ code: "policy_denied" }) })]);
    });
});
