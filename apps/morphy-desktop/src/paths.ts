// Where the pieces of the app are: the service jar, the built web app and a Java runtime.
// In development they're found in the repository; in a packaged app, under resources/.

import { app } from 'electron';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The repository root, when running from a checkout */
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

export interface AppPaths {
  /** The morphy-service fat jar */
  serviceJar: string;
  /** The built web app (Vite's dist/), served by the service */
  webDir: string;
  /** A bundled Java runtime's java binary, if the app ships one */
  bundledJava: string | null;
  /** Where this user's settings and database list live */
  dataDir: string;
}

function findJar(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const jar = readdirSync(dir).find((f) => /^morphy-service-.*\.jar$/.test(f) && !f.endsWith('.original'));
  return jar ? join(dir, jar) : null;
}

export function appPaths(): AppPaths {
  const dataDir = app.getPath('userData');
  if (app.isPackaged) {
    const res = process.resourcesPath;
    const javaBin = process.platform === 'win32' ? 'java.exe' : 'java';
    const bundled = join(res, 'jre', 'bin', javaBin);
    return {
      serviceJar: findJar(join(res, 'service')) ?? join(res, 'service', 'morphy-service.jar'),
      webDir: join(res, 'web'),
      bundledJava: existsSync(bundled) ? bundled : null,
      dataDir,
    };
  }
  const serviceJar = findJar(join(REPO_ROOT, 'morphy-service', 'target'));
  if (!serviceJar) {
    throw new Error(
      `No morphy-service jar under ${join(REPO_ROOT, 'morphy-service', 'target')}. Build it first: mvn -DskipTests package`
    );
  }
  return {
    serviceJar,
    webDir: join(REPO_ROOT, 'apps', 'morphy-web', 'dist'),
    bundledJava: null,
    dataDir,
  };
}
