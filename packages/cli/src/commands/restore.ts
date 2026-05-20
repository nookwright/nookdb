import { existsSync } from 'node:fs';
import { open } from 'nookdb';
import type { Command } from 'commander';
import { printLine } from '../render.js';

export interface RestoreCmdCtx {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

interface RestoreOpts {
  allowOverwrite?: boolean;
  skipSchemaCheck?: boolean;
  create?: boolean;
}

export function registerRestoreCommand(program: Command, ctx: RestoreCmdCtx): void {
  program
    .command('restore <backup> <db>')
    .description('Restore <db> from a .nbkp file')
    .option('--allow-overwrite', 'allow restoring into a non-empty DB', false)
    .option('--skip-schema-check', 'skip backup↔DB schema_hash validation', false)
    .option('--create', 'create <db> if it does not exist', false)
    .action(async (backup: string, db: string, options: RestoreOpts) => {
      if (!existsSync(db) && !options.create) {
        throw new Error(
          `[storage] DB file not found: ${db}. Pass --create to make it, or fix the path.`,
        );
      }
      const handle = await open(db);
      try {
        const stats = await handle.restore(backup, {
          allowOverwrite: options.allowOverwrite ?? false,
          skipSchemaCheck: options.skipSchemaCheck ?? false,
        });
        printLine(
          { stdout: ctx.stdout, stderr: ctx.stderr },
          `Restore complete: ${stats.entryCount} entries (${stats.bytesRead} bytes read) → ${db}`,
        );
      } finally {
        handle.close();
      }
    });
}
