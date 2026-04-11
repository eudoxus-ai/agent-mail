// Wrapper for node:sqlite to avoid Vite/Vitest bundler resolution failures.
// node:sqlite is built into Node 22+ with no native compilation dependencies.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const sqlite = require('node:sqlite') as typeof import('node:sqlite');

const DatabaseSync = sqlite.DatabaseSync;

export { DatabaseSync };

// Re-export the instance type for use in type annotations
export type Database = InstanceType<typeof DatabaseSync>;
