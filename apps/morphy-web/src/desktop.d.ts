// What the desktop app (apps/morphy-desktop) exposes to the web app through its preload script.
// Absent in a browser.

interface MorphyDesktop {
  isDesktop: true;
  version: string;
  onDatabasesChanged(callback: () => void): () => void;
  openDatabase(): Promise<void>;
  newDatabase(): Promise<void>;
}

interface Window {
  morphyDesktop?: MorphyDesktop;
}
