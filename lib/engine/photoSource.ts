// PhotoSource: the two ways photos enter the app.
// - pickFiles: multi-select photo picker. Works everywhere; the only path on iOS/Android.
// - pickDirectory: recursive folder picker via the File System Access API (desktop Chrome/Edge).

interface PickedDirectoryHandle {
  values(): AsyncIterableIterator<PickedHandle>;
}
type PickedHandle =
  | { kind: 'file'; getFile(): Promise<File> }
  | ({ kind: 'directory' } & PickedDirectoryHandle);

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<PickedDirectoryHandle>;
  }
}

const IMAGE_EXT = /\.(jpe?g|png|heic|heif|webp|avif|tiff?|gif|bmp)$/i;

export function supportsDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

export function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    // Explicit HEIC/HEIF: without it iOS transcodes every photo to JPEG while
    // handing them over, which takes minutes for large selections.
    input.accept = 'image/*,.heic,.heif';
    input.multiple = true;
    input.style.display = 'none';
    const finish = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.onchange = () => finish(Array.from(input.files ?? []));
    input.oncancel = () => finish([]);
    // MUST be in the DOM: iOS Safari garbage-collects detached file inputs
    // while the picker is open, and the change event is silently lost.
    document.body.appendChild(input);
    input.click();
  });
}

/** Resolves to [] if the user cancels the picker. */
export async function pickDirectory(): Promise<File[]> {
  if (!window.showDirectoryPicker) return [];
  let dir: PickedDirectoryHandle;
  try {
    dir = await window.showDirectoryPicker();
  } catch {
    return []; // AbortError: user cancelled
  }
  const files: File[] = [];
  await walk(dir, files);
  return files;
}

async function walk(dir: PickedDirectoryHandle, out: File[]): Promise<void> {
  for await (const entry of dir.values()) {
    if (entry.kind === 'file') {
      const file = await entry.getFile();
      if (IMAGE_EXT.test(file.name) || file.type.startsWith('image/')) out.push(file);
    } else {
      await walk(entry, out);
    }
  }
}
