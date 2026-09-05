// TEMP: main-thread counterpart to the worker's 'debug-log' EngineEvent.
// Persisted (not console.log'd) since a mobile OOM crash takes any in-memory
// output down with the tab. Remove once the mobile PDF-crash investigation is
// done, alongside DebugLogViewer and the 'debug-log' EngineEvent handling.
const KEY = 'picbook-debug-log';

export function debugLog(message: string): void {
  try {
    const line = `[${new Date().toLocaleTimeString()}] ${message}\n`;
    const prev = localStorage.getItem(KEY) ?? '';
    localStorage.setItem(KEY, (prev + line).slice(-10000));
  } catch {
    // best-effort only
  }
}
