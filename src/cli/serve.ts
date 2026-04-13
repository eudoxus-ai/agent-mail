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

  const { server, pool } = await createMcpServer();
  const transport = new StdioServerTransport();

  const shutdown = async (code = 0) => {
    try {
      await pool.closeAll();
    } catch {
      // best-effort
    }
    process.exit(code);
  };
  process.once('SIGINT', () => void shutdown(0));
  process.once('SIGTERM', () => void shutdown(0));

  await server.connect(transport);
}
