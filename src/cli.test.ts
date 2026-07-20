import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));

function runCli(args: string[]): { stdout: string; status: number } {
  const env = { ...process.env };
  delete env.AGENT_MAIL_DIR;
  delete env.AGENT_MAIL_ALLOW_DEFAULT;
  const stdout = execFileSync(process.execPath, ['--import', 'tsx', cliPath, ...args], {
    encoding: 'utf8',
    env,
  });
  return { stdout, status: 0 };
}

describe('agent-mail CLI help', () => {
  // Regression: --help lands in the command position; help must resolve before
  // the store is opened so an unset AGENT_MAIL_DIR does not turn into an error.
  it('prints usage for --help with AGENT_MAIL_DIR unset and exits 0', () => {
    const { stdout, status } = runCli(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: agent-mail');
  });

  it('prints usage for -h, help, and no args', () => {
    expect(runCli(['-h']).stdout).toContain('Usage: agent-mail');
    expect(runCli(['help']).stdout).toContain('Usage: agent-mail');
    expect(runCli([]).stdout).toContain('Usage: agent-mail');
  });
});
