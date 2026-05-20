import { Command } from 'commander';
import { createRequire } from 'node:module';
import { registerBackupCommand } from './commands/backup.js';
import { registerRestoreCommand } from './commands/restore.js';
import { registerMigrateCommand } from './commands/migrate.js';
import { registerInspectCommand } from './commands/inspect.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export interface ProgramCtx {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/**
 * Builds the root commander Program. Subcommands (backup, restore,
 * migrate, inspect) are registered by their own tasks.
 */
export function buildProgram(ctx: ProgramCtx): Command {
  const program = new Command();
  program
    .name('nookdb')
    .description('CLI for nookdb — backup, restore, migrate, inspect.')
    .version(pkg.version)
    .option('--debug', 'print stack traces on error', false)
    .showHelpAfterError(false)
    .allowExcessArguments(false)
    .exitOverride();

  registerBackupCommand(program, ctx);
  registerRestoreCommand(program, ctx);
  registerMigrateCommand(program, ctx);
  registerInspectCommand(program, ctx);

  // Subcommands registered by Task 25.
  return program;
}
