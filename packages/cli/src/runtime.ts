import { buildProgram } from './cli.js';
import { printError } from './render.js';

export interface RunContext {
  cwd?: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
}

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

export async function run(argv: string[], ctx?: RunContext): Promise<number> {
  const stdout = ctx?.stdout ?? process.stdout;
  const stderr = ctx?.stderr ?? process.stderr;
  const program = buildProgram({ stdout, stderr });
  program.configureOutput({
    writeOut: (str) => stdout.write(str),
    writeErr: (str) => stderr.write(str),
  });

  try {
    await program.parseAsync(argv, { from: 'user' });
    return EXIT_OK;
  } catch (err: unknown) {
    type CommanderErr = { code?: string; exitCode?: number; message?: string };
    const ce = err as CommanderErr;
    if (ce && (ce.code === 'commander.helpDisplayed' || ce.code === 'commander.version' || ce.code === 'commander.help')) {
      return EXIT_OK;
    }
    if (ce && typeof ce.exitCode === 'number' && ce.exitCode === 0) {
      return EXIT_OK;
    }
    if (ce && ce.code && ce.code.startsWith('commander.')) {
      // Parse-time errors — commander already wrote help/usage. Return USAGE.
      return EXIT_USAGE;
    }
    const debug = argv.includes('--debug');
    printError({ stdout, stderr }, err, debug);
    return EXIT_FAIL;
  }
}
