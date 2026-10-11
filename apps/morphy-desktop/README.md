# Morphy Desktop

Morphy as a desktop application: one window that starts morphy-service in the background,
shows the web app, and adds what a browser tab can't — native dialogs to open and create
databases (File menu, or the buttons on All Databases), and the app's own data folder.

## How it works

- On start the app looks for a Java runtime (bundled under `resources/jre`, then `JAVA_HOME`,
  then `java` on the PATH; 21 or newer), picks a free port and runs the service jar with this
  user's configuration: `databases.json` and `position-indexes.json` in the data folder
  (`~/.config/morphy-desktop` on Linux). Databases opened through the app are remembered by the
  service in `databases.local.json` next to them.
- The service serves the built web app (`apps/morphy-web/dist`) itself, so the window loads
  `http://127.0.0.1:<port>/`. The app adds the cross-origin isolation headers the in-browser
  Stockfish needs.
- The web app knows it runs in the desktop through `window.morphyDesktop` (see `src/preload.ts`
  and `morphy-web/src/desktop.d.ts`).
- Quitting the app stops the service. The app's log is `morphy-desktop.log` in the data folder.

## Run from the repository

```bash
mvn -DskipTests package -pl morphy-service -am   # the service jar
cd apps && npm install                            # once, for every app
cd morphy-web && npm run build                    # the web app the service serves
cd ../morphy-desktop && npm start
```

`npm start` sets `ELECTRON_DISABLE_SANDBOX=1`: the development Electron's SUID sandbox helper
isn't installed setuid; packaged builds don't need it.

## Package

```bash
npm run dist          # AppImage and .deb under release/
```

The package carries the service jar and the web app. A Java runtime is bundled when `jre/`
exists next to this file (make one with `jlink`, see `scripts/make-jre.sh`); otherwise the
.deb depends on a system Java 21 and the AppImage needs one on the PATH.
