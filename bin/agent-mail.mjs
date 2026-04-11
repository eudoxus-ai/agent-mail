#!/usr/bin/env node

// Thin wrapper that runs src/index.ts via tsx without requiring a build step.
// Works for both local dev (`./bin/agent-mail.mjs serve`) and npx.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const entry = join(root, 'src', 'index.ts');
const args = process.argv.slice(2);

try {
  execFileSync(
    join(root, 'node_modules', '.bin', 'tsx'),
    [entry, ...args],
    { stdio: 'inherit', cwd: root }
  );
} catch (e) {
  // tsx exits with the child's exit code, which execFileSync treats as an error
  process.exit(e.status ?? 1);
}
