import { open } from 'nookdb';
import type { Command } from 'commander';
import { printLine } from '../render.js';

export interface BackupCmdCtx {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export function registerBackupCommand(program: Command, ctx: BackupCmdCtx): void {
  program
    .command('backup <db> <out>')
    .description('Create a portable .nbkp snapshot of <db>')
    .action(async (db: string, out: string) => {
      const handle = await open(db);
      try {
        const stats = await handle.backup(out);
        printLine(
          { stdout: ctx.stdout, stderr: ctx.stderr },
          `Backup written: ${stats.entryCount} entries, ${stats.bytesWritten} bytes → ${out}`,
        );
      } finally {
        handle.close();
      }
    });
}
