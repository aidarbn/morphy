// The bridge between the desktop shell and the web app. The web app checks for
// window.morphyDesktop to know it runs in the desktop app.

import { contextBridge, ipcRenderer } from 'electron';

const api = {
  /** True in the desktop app */
  isDesktop: true,
  /** The app's version */
  version: process.env.MORPHY_DESKTOP_VERSION ?? '',
  /** Called when the shell registered or created a database, so lists of databases can refetch */
  onDatabasesChanged(callback: () => void): () => void {
    const listener = () => callback();
    ipcRenderer.on('databases-changed', listener);
    return () => ipcRenderer.removeListener('databases-changed', listener);
  },
  /** Opens the native dialog to register an existing database */
  openDatabase(): Promise<void> {
    return ipcRenderer.invoke('open-database');
  },
  /** Opens the native dialog to create a new database */
  newDatabase(): Promise<void> {
    return ipcRenderer.invoke('new-database');
  },
};

contextBridge.exposeInMainWorld('morphyDesktop', api);

// Lists of databases in the web app listen to this DOM event; see DatabasesPane
ipcRenderer.on('databases-changed', () => {
  window.dispatchEvent(new Event('morphy:databases-changed'));
});
