import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));

// Tests run against the sources: no build needed, and every package sees the others' changes at once.
export default defineConfig({
    resolve: {
        alias: [
            { find: /^@cyanmycelium\/mcp-cache-redis$/, replacement: source("mcp-cache-redis/src/index.ts") },
            { find: "@cyanmycelium/mcp-cache/conformance", replacement: source("mcp-cache/src/conformance/index.ts") },
            { find: /^@cyanmycelium\/mcp-cache$/, replacement: source("mcp-cache/src/index.ts") },
        ],
    },
    test: {
        // .env (never committed) may give REDIS_URL, REDIS_PASSWORD and REDIS_USERNAME for the live Redis run.
        env: loadEnv("test", process.cwd(), ""),
        include: ["tests/**/*.test.ts"],
        environment: "node",
    },
});
