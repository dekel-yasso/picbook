// Crash-surviving diagnostics: a small ring buffer in localStorage. iOS kills
// the whole page on memory pressure and takes console output with it; this
// survives the reload so the user can copy it from Account & sync.
const KEY = 'picbook-diag';
const CAP = 24_000;

export function diag(message: string): void {
  try {
    const line = `[${new Date().toLocaleTimeString()}] ${message}\n`;
    const prev = localStorage.getItem(KEY) ?? '';
    localStorage.setItem(KEY, (prev + line).slice(-CAP));
  } catch {
    // best-effort only
  }
}

export function readDiag(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function clearDiag(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
