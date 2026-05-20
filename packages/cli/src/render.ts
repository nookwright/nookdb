import kleur from 'kleur';

export interface PrintCtx {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

const PREFIX_RE = /^\[([a-z_]+)\]\s(.*)$/s;

export function printError(ctx: PrintCtx, err: unknown, debug: boolean): void {
  const msg = err instanceof Error ? err.message : String(err);
  const m = PREFIX_RE.exec(msg);
  if (m) {
    ctx.stderr.write(`${kleur.red('error')} [${m[1]}] ${m[2]}\n`);
  } else {
    ctx.stderr.write(`${kleur.red('error')} ${msg}\n`);
  }
  if (debug && err instanceof Error && err.stack) {
    ctx.stderr.write(err.stack + '\n');
  }
}

export function printJson(ctx: PrintCtx, obj: unknown): void {
  ctx.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

export function printLine(ctx: PrintCtx, line: string): void {
  ctx.stdout.write(line + '\n');
}
