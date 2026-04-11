import { existsSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from '../server/server.js';
import { ACCOUNTS_YAML_PATH } from '../config.js';

export async function serve(): Promise<void> {
  if (!existsSync(ACCOUNTS_YAML_PATH)) {
    process.stderr.write(
      "agent-mail: no accounts configured. Run 'npx agent-mail add-account' first.\n"
    );
    process.exit(1);
  }

  const server = await createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
