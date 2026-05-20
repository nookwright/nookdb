#!/usr/bin/env node
// CLI bootstrap — keeps logic in src/runtime.ts so tests can exercise
// the same entry point programmatically without spawning a child.
import { run } from '../dist/runtime.js';
const code = await run(process.argv.slice(2));
process.exit(code ?? 0);
