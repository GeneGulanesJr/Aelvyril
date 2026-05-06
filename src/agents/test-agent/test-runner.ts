import { execFileSync } from 'child_process';

export interface TestRunConfig {
  timeoutMs: number;
  command?: string;
  args?: string[];
}

export interface TestRunResult {
  output: string;
  exitCode: number;
  timedOut: boolean;
}

export async function runTests(
  workspace: string,
  config?: Partial<TestRunConfig>
): Promise<TestRunResult> {
  const timeoutMs = config?.timeoutMs ?? 120000;
  const command = config?.command ?? 'npx';
  const args = config?.args ?? ['vitest', 'run'];

  try {
    const output = execFileSync(command, args, {
      cwd: workspace,
      timeout: timeoutMs,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true' },
    });

    return {
      output: output.toString(),
      exitCode: 0,
      timedOut: false,
    };
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; killed?: boolean; status?: number };

    if (error.killed) {
      return {
        output: '',
        exitCode: -1,
        timedOut: true,
      };
    }

    const output = [
      error.stdout?.toString() ?? '',
      error.stderr?.toString() ?? '',
    ].join('\n');

    return {
      output,
      exitCode: error.status ?? 1,
      timedOut: false,
    };
  }
}
