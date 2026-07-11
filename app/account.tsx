'use client';

import { useCallback, useEffect, useState } from 'react';
import { exportBackup, importBackup } from '@/lib/engine/backup';
import { signIn, signOut, syncNow, whoami } from '@/lib/engine/sync';

interface AccountProps {
  onClose: () => void;
  /** Called after a successful sync so the page can reload trips/decisions. */
  onSynced: () => void;
}

export function AccountOverlay({ onClose, onSynced }: AccountProps) {
  const [user, setUser] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    whoami().then((u) => {
      setUser(u);
      setChecked(true);
    });
  }, []);

  const runSync = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const summary = await syncNow();
      setStatus(`Synced — ${summary}`);
      localStorage.setItem('picbook-last-sync', String(Date.now()));
      onSynced();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setBusy(false);
    }
  }, [onSynced]);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const res = await signIn(email, password);
        setUser(res.email);
        setStatus(res.created ? 'Account created' : 'Signed in');
        setPassword('');
        await runSync();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Sign-in failed');
      } finally {
        setBusy(false);
      }
    },
    [email, password, runSync],
  );

  const logout = useCallback(async () => {
    await signOut().catch(() => {});
    setUser(null);
    setStatus(null);
  }, []);

  const doExport = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const blob = await exportBackup();
      const file = new File([blob], `picbook-backup-${new Date().toISOString().slice(0, 10)}.picbook`, {
        type: 'application/octet-stream',
      });
      // Share sheet on iOS (→ Files/AirDrop), download elsewhere.
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] }).catch(() => {});
      } else {
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        a.click();
        URL.revokeObjectURL(url);
      }
      setStatus(`Backup ready (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  }, []);

  const doImport = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.picbook';
    input.style.display = 'none';
    input.onchange = async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      setBusy(true);
      setError(null);
      setStatus('Reading backup…');
      try {
        const result = await importBackup(file, (done, total) =>
          setStatus(`Importing ${done} / ${total} photos…`),
        );
        setStatus(`Imported ${result.photos} photos across ${result.trips} trips — reloading…`);
        setTimeout(() => location.reload(), 1200);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Import failed');
        setBusy(false);
      }
    };
    input.oncancel = () => input.remove();
    document.body.appendChild(input);
    input.click();
  }, []);

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between border-b border-neutral-500/30 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button onClick={onClose} aria-label="Close" className="rounded-lg px-2 py-1 text-xl leading-none">
          ✕
        </button>
        <span className="text-sm font-semibold">Account & sync</span>
        <span className="w-8" />
      </div>

      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col gap-4 p-6">
        {!checked ? null : user ? (
          <>
            <p className="text-sm">
              Signed in as <span className="font-medium">{user}</span>
            </p>
            <p className="text-xs text-neutral-500">
              Sync backs up your trips, keep/reject decisions, and book layouts — small documents,
              not the photos themselves. Photos stay on this device.
            </p>
            <button
              onClick={runSync}
              disabled={busy}
              className="rounded-xl bg-foreground py-3 text-sm font-semibold text-background disabled:opacity-40"
            >
              {busy ? 'Syncing…' : 'Sync now'}
            </button>
            <button onClick={logout} className="text-xs text-neutral-500 underline">
              Sign out
            </button>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <p className="text-sm text-neutral-500">
              Sign in to back up trips, decisions, and books across devices. New email? An account
              is created automatically.
            </p>
            <input
              type="email"
              required
              autoComplete="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-lg border border-neutral-500/40 bg-transparent px-3 py-2.5 text-sm"
            />
            <input
              type="password"
              required
              minLength={8}
              autoComplete="current-password"
              placeholder="Password (8+ characters)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-lg border border-neutral-500/40 bg-transparent px-3 py-2.5 text-sm"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded-xl bg-foreground py-3 text-sm font-semibold text-background disabled:opacity-40"
            >
              {busy ? 'Working…' : 'Sign in / Create account'}
            </button>
          </form>
        )}
        {status && <p className="text-xs text-emerald-600">{status}</p>}
        {error && <p className="text-xs text-red-500">{error}</p>}

        <div className="mt-4 flex flex-col gap-2 border-t border-neutral-500/30 pt-4">
          <p className="text-xs text-neutral-500">
            <span className="font-medium text-foreground">Backup file</span> — move your work
            between browsers or installs on this phone (e.g. Safari → the home-screen app): export
            here, then import in the other one. Includes thumbnails, decisions, and books.
          </p>
          <div className="flex gap-2">
            <button
              onClick={doExport}
              disabled={busy}
              className="flex-1 rounded-lg border border-neutral-500/40 py-2.5 text-xs font-medium disabled:opacity-40"
            >
              Export backup
            </button>
            <button
              onClick={doImport}
              disabled={busy}
              className="flex-1 rounded-lg border border-neutral-500/40 py-2.5 text-xs font-medium disabled:opacity-40"
            >
              Import backup
            </button>
          </div>
        </div>
        <p className="mt-auto pt-4 text-center text-[10px] text-neutral-400">
          build {process.env.NEXT_PUBLIC_BUILD}
        </p>
      </div>
    </div>
  );
}
