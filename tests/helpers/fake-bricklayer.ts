// Canned MCP stdio server standing in for `vendor/bin/bricklayer mcp` in
// tests/verify-wiring.test.ts. Speaks just enough MCP (initialize ->
// notifications/initialized -> tools/call, via the SDK's McpServer/
// StdioServerTransport — same machinery mcp/src/server.ts uses) to serve
// plugin-list / event-list / preference-list from a canned JSON fixture,
// so verify-wiring's runtime client can be exercised without a real
// bricklayer install. Spawned via PB_CODEGRAPH_BRICKLAYER_CMD (see
// augmenter/src/verify-wiring.ts's openBricklayerSession) as
// `<node> --import tsx <this file>`.
import fs from 'node:fs';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export interface FakeBricklayerFixture {
  /** className -> plugin-list structuredContent (e.g. {class, plugins, _skill_hint}) */
  plugins?: Record<string, Record<string, unknown>>;
  /** area -> event-list structuredContent (e.g. {area, total, events}) */
  events?: Record<string, Record<string, unknown>>;
  /** interfaceFqcn -> preference-list structuredContent for THAT interface (real bricklayer is
   * per-interface — see verify-wiring.ts's characterization note). Any interface not present in
   * this map gets the real tool's own "not found" shape: {filter, count:0, preferences:[]}. */
  preferences?: Record<string, Record<string, unknown>>;
  /** Areas for which event-list should THROW instead of returning a structured payload --
   * simulates a bricklayer version/config where a per-area call fails (see verify-wiring.ts's
   * EVENT_LIST_AREAS tolerance). */
  eventErrors?: string[];
}

function loadFixture(): FakeBricklayerFixture {
  const fixturePath = process.env.PB_CODEGRAPH_FAKE_BRICKLAYER_FIXTURE;
  if (!fixturePath) return {};
  return JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as FakeBricklayerFixture;
}

async function main(): Promise<void> {
  const fixture = loadFixture();
  const server = new McpServer({ name: 'fake-bricklayer', version: '0.0.0' });

  server.registerTool(
    'plugin-list',
    {
      title: 'List plugins for a class (fake)',
      inputSchema: {
        className: z.string(),
        method: z.string().optional(),
      },
    },
    async ({ className }) => {
      const structured = fixture.plugins?.[className] ?? { class: className, plugins: {} };
      return { content: [{ type: 'text' as const, text: JSON.stringify(structured) }], structuredContent: structured };
    },
  );

  server.registerTool(
    'event-list',
    {
      title: 'List event observers for an area (fake)',
      inputSchema: {
        eventName: z.string().optional(),
        area: z.enum(['global', 'frontend', 'adminhtml', 'webapi_rest', 'webapi_soap', 'crontab', 'graphql']),
      },
    },
    async ({ area }) => {
      if (fixture.eventErrors?.includes(area)) {
        throw new Error(`fake-bricklayer: simulated event-list failure for area "${area}"`);
      }
      const structured = fixture.events?.[area] ?? { area, total: 0, events: [] };
      return { content: [{ type: 'text' as const, text: JSON.stringify(structured) }], structuredContent: structured };
    },
  );

  server.registerTool(
    'preference-list',
    {
      title: 'List DI preferences for an interface (fake)',
      inputSchema: {
        interface: z.string().optional(),
      },
    },
    async ({ interface: interfaceFqcn }) => {
      const known = interfaceFqcn ? fixture.preferences?.[interfaceFqcn] : undefined;
      const structured = known ?? {
        filter: interfaceFqcn ?? 'common interfaces',
        count: 0,
        preferences: [],
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(structured) }], structuredContent: structured };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
