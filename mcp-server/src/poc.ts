/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { POC_DIR, PATH_TRAVERSAL_TEMP_FILE } from './constants.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface RunPocResult {
  stdout: string;
  stderr: string;
  error?: string;
  isSecurityError?: boolean;
}

interface PocDependencies {
  fs: typeof fs;
  path: typeof path;
  execAsync: typeof execAsync;
  execFileAsync: typeof execFileAsync;
}

const DEFAULT_POC_DEPS: PocDependencies = {
  fs,
  path,
  execAsync,
  execFileAsync,
};

interface RunnerConfig {
  runCmd: string;
  runArgs: string[];
  installCmd: string | null;
}

async function setupPythonRunner(
  filePath: string,
  pocDir: string,
  deps: PocDependencies
): Promise<RunnerConfig> {
  const venvDir = deps.path.join(pocDir, '.venv');
  const isWindows = process.platform === 'win32';
  const pythonBin = isWindows
    ? deps.path.join(venvDir, 'Scripts', 'python.exe')
    : deps.path.join(venvDir, 'bin', 'python');

  try {
    await deps.fs.access(pythonBin);
  } catch {
    try {
      await deps.execAsync(`python3 -m venv "${venvDir}"`);
    } catch {
      await deps.execAsync(`python -m venv "${venvDir}"`);
    }
  }

  const projectRoot = process.cwd();
  const checkExists = async (p: string) =>
    deps.fs.access(p).then(() => true).catch(() => false);

  const hasProjectPyproject = await checkExists(deps.path.join(projectRoot, 'pyproject.toml'));
  const hasProjectRequirements = await checkExists(deps.path.join(projectRoot, 'requirements.txt'));

  if (hasProjectPyproject) {
    await deps.execAsync(`"${pythonBin}" -m pip install -e "${projectRoot}"`).catch(() => { });
  } else if (hasProjectRequirements) {
    await deps.execAsync(`"${pythonBin}" -m pip install -r "${deps.path.join(projectRoot, 'requirements.txt')}"`).catch(() => { });
  }

  const hasPocPyproject = await checkExists(deps.path.join(pocDir, 'pyproject.toml'));
  const hasPocRequirements = await checkExists(deps.path.join(pocDir, 'requirements.txt'));

  if (hasPocPyproject) {
    await deps.execAsync(`"${pythonBin}" -m pip install .`, { cwd: pocDir }).catch(() => { });
  }
  if (hasPocRequirements) {
    await deps.execAsync(`"${pythonBin}" -m pip install -r requirements.txt`, { cwd: pocDir }).catch(() => { });
  }

  return {
    runCmd: pythonBin,
    runArgs: [filePath],
    installCmd: null,
  };
}

async function setupGoRunner(
  filePath: string,
  pocDir: string,
  deps: PocDependencies
): Promise<RunnerConfig> {
  const hasGoMod = await deps.fs.access(deps.path.join(pocDir, 'go.mod')).then(() => true).catch(() => false);
  if (!hasGoMod) {
    await deps.execAsync('go mod init poc', { cwd: pocDir }).catch(() => { });
  }
  return {
    runCmd: 'go',
    runArgs: ['run', filePath],
    installCmd: 'go mod tidy',
  };
}

function setupNodeRunner(filePath: string, ext: string): RunnerConfig {
  if (ext === '.ts') {
    return {
      runCmd: 'npx',
      runArgs: ['ts-node', filePath],
      installCmd: null,
    };
  }
  return {
    runCmd: 'node',
    runArgs: [filePath],
    installCmd: null,
  };
}

async function executeWithPythonRetry(
  runCmd: string,
  runArgs: string[],
  execOptions: any,
  ext: string,
  pocDir: string,
  deps: PocDependencies
): Promise<{ stdout: string; stderr: string }> {
  try {
    return (await deps.execFileAsync(runCmd, runArgs, execOptions)) as unknown as { stdout: string; stderr: string };
  } catch (error: any) {
    const errorMessage = error.message || '';
    const errorOutput = (error.stdout || '') + (error.stderr || '');

    if (ext === '.py' && (errorMessage.includes('ModuleNotFoundError') || errorOutput.includes('ModuleNotFoundError'))) {
      const venvDir = deps.path.join(pocDir, '.venv');
      try {
        await deps.execAsync(`python3 -m venv --system-site-packages "${venvDir}"`);
      } catch {
        await deps.execAsync(`python -m venv --system-site-packages "${venvDir}"`);
      }
      return (await deps.execFileAsync(runCmd, runArgs, execOptions)) as unknown as { stdout: string; stderr: string };
    }
    throw error;
  }
}

export async function runPoc(
  {
    filePath,
  }: {
    filePath: string;
  },
  dependencies: PocDependencies = DEFAULT_POC_DEPS
): Promise<RunPocResult> {
  try {
    const pocDir = dependencies.path.dirname(filePath);
    const pocFileName = dependencies.path.basename(filePath);

    // Only write the path traversal temp file if the PoC is actually for a path traversal vulnerability.
    if (pocFileName.includes('path_traversal')) {
      const tempFilePath = dependencies.path.join(process.cwd(), PATH_TRAVERSAL_TEMP_FILE);
      await dependencies.fs.writeFile(tempFilePath, 'This is a path traversal test file to verify the vulnerability.');
    }

    // Validate that the filePath is within the safe PoC directory
    const resolvedFilePath = dependencies.path.resolve(filePath);
    const safePocDir = dependencies.path.resolve(process.cwd(), POC_DIR);

    if (!resolvedFilePath.startsWith(safePocDir + dependencies.path.sep)) {
      return {
        stdout: '',
        stderr: '',
        error: `Security Error: PoC execution is restricted to files within '${safePocDir}'. Attempted to access '${resolvedFilePath}'.`,
        isSecurityError: true,
      };
    }

    const ext = dependencies.path.extname(filePath).toLowerCase();

    let runnerConfig: RunnerConfig;
    if (ext === '.py') {
      runnerConfig = await setupPythonRunner(filePath, pocDir, dependencies);
    } else if (ext === '.go') {
      runnerConfig = await setupGoRunner(filePath, pocDir, dependencies);
    } else {
      runnerConfig = setupNodeRunner(filePath, ext);
    }

    const { runCmd, runArgs, installCmd } = runnerConfig;

    if (installCmd) {
      try {
        await dependencies.execAsync(installCmd, { cwd: pocDir });
      } catch (error) {
        // Ignore errors from install step, as it might fail if no dependency configuration file (e.g., package.json, requirements.txt, go.mod) exists,
        // but we still want to attempt running the PoC.
      }
    }

    let output: { stdout: string; stderr: string };

    const execOptions: any = { cwd: pocDir };
    if (runCmd === 'npx') {
      execOptions.env = {
        ...process.env,
        npm_config_cache: dependencies.path.join(pocDir, '.npx_cache')
      };
    }

    const { stdout, stderr } = await executeWithPythonRetry(
      runCmd,
      runArgs,
      execOptions,
      ext,
      pocDir,
      dependencies
    );

    return { stdout, stderr };
  } catch (error) {
    let errorMessage = 'An unknown error occurred.';
    let stdout = '';
    let stderr = '';

    if (error instanceof Error) {
      errorMessage = error.message;
      // Capture stdout/stderr from the error object if available (execFile throws with these)
      stdout = (error as any).stdout || '';
      stderr = (error as any).stderr || '';
    }

    return {
      error: errorMessage,
      stdout,
      stderr,
    };
  } finally {
    // Cleanup path traversal temp file if it exists
    const tempFilePath = dependencies.path.join(process.cwd(), PATH_TRAVERSAL_TEMP_FILE);
    try {
      await dependencies.fs.access(tempFilePath);
      await dependencies.fs.unlink(tempFilePath);
    } catch {
      // Ignore if file doesn't exist or can't be deleted
    }
  }
}
