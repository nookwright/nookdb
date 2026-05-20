import { open } from 'nookdb';
import type { Command } from 'commander';
import { printLine } from '../render.js';

export interface MigrateCmdCtx {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

function parseVersions(raw: string): number[] {
  const tokens = raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
  const out: number[] = [];
  for (const t of tokens) {
    if (!/^\d+$/.test(t)) {
      throw new Error(`[invalid_arg] not a version number: ${JSON.stringify(t)}`);
    }
    out.push(Number(t));
  }
  return out;
}

export function registerMigrateCommand(program: Command, ctx: MigrateCmdCtx): void {
  const cmd = program.command('migrate').description('Manage the migration version ledger');

  cmd
    .command('status <db>')
    .description('Show applied / pending migration ledger')
    .action(async (db: string) => {
      const handle = await open(db);
      try {
        const status = await handle.migrateStatus();
        printLine({ stdout: ctx.stdout, stderr: ctx.stderr }, `current_version: ${status.currentVersion}`);
        const applied = await handle.migrateListApplied();
        printLine({ stdout: ctx.stdout, stderr: ctx.stderr }, `applied:         [${applied.join(', ')}]`);
      } finally {
        handle.close();
      }
    });

  cmd
    .command('up <db>')
    .description('Apply versions to the ledger (forward-only)')
    .requiredOption('--versions <list>', 'comma-separated version numbers (e.g. 1,2,3)')
    .action(async (db: string, opts: { versions: string }) => {
      const versions = parseVersions(opts.versions);
      const handle = await open(db);
      try {
        await handle.migrateRun(versions);
        printLine(
          { stdout: ctx.stdout, stderr: ctx.stderr },
          `Migration ledger updated: ${versions.length} version(s) recorded.`,
        );
      } finally {
        handle.close();
      }
    });
}
