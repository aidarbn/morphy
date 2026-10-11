// Runs morphy-service as a child process: finds a Java runtime, picks a free port, starts the
// jar with this user's configuration, waits until it answers, and stops it when the app quits.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { AppPaths } from './paths';

export interface RunningService {
  /** The origin the service answers at, e.g. http://127.0.0.1:43127 */
  origin: string;
  process: ChildProcess;
  /** Stops the service; resolves when it has exited */
  stop(): Promise<void>;
}

export class ServiceError extends Error {}

/** A Java runtime to run the service with: bundled, then JAVA_HOME, then the PATH. */
export function findJava(paths: AppPaths): string {
  const candidates: string[] = [];
  if (paths.bundledJava) candidates.push(paths.bundledJava);
  if (process.env.JAVA_HOME) {
    candidates.push(join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  }
  candidates.push('java');
  for (const java of candidates) {
    if (java !== 'java' && !existsSync(java)) continue;
    const probe = spawnSync(java, ['-version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) continue;
    const match = /version "(\d+)/.exec(probe.stderr + probe.stdout);
    const major = match ? Number(match[1]) : 0;
    if (major >= 21) return java;
  }
  throw new ServiceError(
    'Java 21 or newer is needed to run Morphy, and none was found. Install a JDK or JRE 21+ (for example from https://adoptium.net) and start Morphy again.'
  );
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Makes sure this user's data directory holds the configuration files the service reads. */
function prepareDataDir(dataDir: string): { databasesConfig: string; positionIndexesConfig: string } {
  mkdirSync(dataDir, { recursive: true });
  const databasesConfig = join(dataDir, 'databases.json');
  if (!existsSync(databasesConfig)) writeFileSync(databasesConfig, '{}\n');
  const positionIndexesConfig = join(dataDir, 'position-indexes.json');
  if (!existsSync(positionIndexesConfig)) writeFileSync(positionIndexesConfig, '{}\n');
  return { databasesConfig, positionIndexesConfig };
}

async function waitForHealth(origin: string, child: ChildProcess, timeoutMs: number, log: (line: string) => void) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new ServiceError(`morphy-service exited with code ${child.exitCode} before it was ready. See the log.`);
    }
    try {
      const res = await fetch(`${origin}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  log('timed out waiting for /api/health');
  throw new ServiceError(`morphy-service did not answer within ${Math.round(timeoutMs / 1000)} s.`);
}

/**
 * Starts the service and resolves once it answers.
 *
 * @param log called with every line the service writes, for the app's log
 */
export async function startService(paths: AppPaths, log: (line: string) => void): Promise<RunningService> {
  const java = findJava(paths);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const { databasesConfig, positionIndexesConfig } = prepareDataDir(paths.dataDir);
  const args = [
    '-Xss4m',
    '-jar',
    paths.serviceJar,
    `--server.port=${port}`,
    '--server.address=127.0.0.1',
    `--app.databases.config=${databasesConfig}`,
    `--app.position-indexes.config=${positionIndexesConfig}`,
    `--spring.web.resources.static-locations=file:${paths.webDir}/`,
    '--spring.main.banner-mode=off',
  ];
  log(`starting: ${java} ${args.join(' ')}`);
  const child = spawn(java, args, { cwd: paths.dataDir, stdio: ['ignore', 'pipe', 'pipe'] });
  const forward = (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) if (line) log(line);
  };
  child.stdout?.on('data', forward);
  child.stderr?.on('data', forward);
  child.on('exit', (code, signal) => log(`morphy-service exited: code=${code} signal=${signal}`));

  await waitForHealth(origin, child, 90_000, log);
  log(`ready at ${origin}`);

  return {
    origin,
    process: child,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
        }, 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill('SIGTERM');
      }),
  };
}
