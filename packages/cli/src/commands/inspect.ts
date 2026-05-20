import { stat } from 'node:fs/promises';
import { open } from 'nookdb';
import type { Command } from 'commander';
import { printLine } from '../render.js';

export interface InspectCmdCtx {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

export function registerInspectCommand(program: Command, ctx: InspectCmdCtx): void {
  program
    .command('inspect <db>')
    .description('Print DB metadata, migration ledger, and per-collection entry counts')
    .action(async (db: string) => {
      const stt = await stat(db);
      const handle = await open(db);
      try {
        const out = { stdout: ctx.stdout, stderr: ctx.stderr };
        printLine(out, `Path:       ${db}`);
        printLine(out, `File size:  ${humanBytes(stt.size)} (${stt.size} bytes)`);
        const status = await handle.migrateStatus();
        const applied = await handle.migrateListApplied();
        printLine(out, `Migration:`);
        printLine(out, `  current_version: ${status.currentVersion}`);
        printLine(out, `  applied:         [${applied.join(', ')}]`);
        printLine(out, `Collections:`);
        const names = await handle.listCollectionNames();
        if (names.length === 0) {
          printLine(out, `  (none)`);
        } else {
          for (const name of names) {
            const entries = await handle.listCollection(name);
            const word = entries.length === 1 ? 'entry' : 'entries';
            printLine(out, `  ${name.padEnd(16)} ${entries.length} ${word}`);
          }
        }
      } finally {
        handle.close();
      }
    });
}
