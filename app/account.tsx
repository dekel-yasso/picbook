'use client';

import { useCallback, useEffect, useState } from 'react';
import { Cloud, X } from 'lucide-react';
import { exportBackup, importBackup } from '@/lib/engine/backup';
import { signIn, signOut, syncNow, whoami } from '@/lib/engine/sync';
import { useI18n } from '@/lib/i18n';

interface AccountProps {
  onClose: () => void;
  /** Called after a successful sync so the page can reload trips/decisions. */
  onSynced: () => void;
}

export function AccountOverlay({ onClose, onSynced }: AccountProps) {
  const { lang, t, setLang } = useI18n();
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
      const counts = await syncNow();
      setStatus(t('synced', counts));
      localStorage.setItem('picbook-last-sync', String(Date.now()));
      onSynced();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setBusy(false);
    }
  }, [onSynced, t]);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const res = await signIn(email, password);
        setUser(res.email);
        setStatus(res.created ? t('accountCreated') : t('signedIn'));
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
      setStatus(t('backupReady', { size: (blob.size / 1024 / 1024).toFixed(1) }));
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
      setStatus(t('readingBackup'));
      try {
        const result = await importBackup(file, (done, total) =>
          setStatus(t('importingPhotos', { done, total })),
        );
        setStatus(t('importedReloading', { photos: result.photos, trips: result.trips }));
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
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex flex-col bg-ground text-ink">
      <div className="flex items-center justify-between border-b-2 border-ink px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button onClick={onClose} aria-label={t('close')} className="px-2 py-1">
          <X size={20} strokeWidth={2.25} />
        </button>
        <span className="text-[14px] font-extrabold">{t('accountTitle')}</span>
        <span className="w-8" />
      </div>

      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col gap-4 p-6">
        {!checked ? null : user ? (
          <>
            <p className="text-sm">
              {t('signedInAs')} <span className="font-extrabold">{user}</span>
            </p>
            <p className="text-xs text-muted">
              {t('syncBody')}
            </p>
            <button
              onClick={runSync}
              disabled={busy}
              className="flex items-center justify-between bg-accent px-3.5 py-3 text-[13px] font-semibold text-white disabled:opacity-45"
            >
              {busy ? t('syncing') : t('syncNow')}
              <Cloud size={16} strokeWidth={2.25} />
            </button>
            <button onClick={logout} className="self-start text-xs text-muted underline">
              {t('signOut')}
            </button>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <p className="text-sm text-muted">
              {t('signInIntro')}
            </p>
            <input
              type="email"
              required
              autoComplete="email"
              placeholder={t('emailPh')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="border-2 border-ink bg-white px-3 py-2.5 text-sm"
            />
            <input
              type="password"
              required
              minLength={8}
              autoComplete="current-password"
              placeholder={t('passwordPh')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="border-2 border-ink bg-white px-3 py-2.5 text-sm"
            />
            <button
              type="submit"
              disabled={busy}
              className="bg-accent py-3 text-[13px] font-semibold text-white disabled:opacity-45"
            >
              {busy ? t('working') : t('signInBtn')}
            </button>
          </form>
        )}
        {status && <p className="text-xs text-emerald-600">{status}</p>}
        {error && <p className="text-xs text-red-500">{error}</p>}

        <div className="-mx-6 mt-4 border-t-2 border-ink" />
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted">
            <span className="font-extrabold text-ink">{t('backupTitle')}</span>
            {t('backupBody')}
          </p>
          <div className="flex gap-2">
            <button
              onClick={doExport}
              disabled={busy}
              className="flex-1 border-2 border-ink py-2.5 text-xs font-semibold text-ink disabled:opacity-45"
            >
              {t('exportBackup')}
            </button>
            <button
              onClick={doImport}
              disabled={busy}
              className="flex-1 border-2 border-ink py-2.5 text-xs font-semibold text-ink disabled:opacity-45"
            >
              {t('importBackup')}
            </button>
          </div>
        </div>
        <div className="-mx-6 border-t-2 border-ink" />
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">{t('language')}</span>
          <div className="flex border-2 border-ink text-xs">
            {(['en', 'he'] as const).map((l, i) => (
              <button
                key={l}
                onClick={() => setLang(l)}
                className={`px-3 py-1.5 font-bold ${i === 1 ? 'border-s-2 border-ink' : ''} ${
                  lang === l ? 'bg-ink text-ground' : 'text-muted'
                }`}
              >
                {l === 'en' ? 'English' : 'עברית'}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-auto pt-4 text-center text-[10px] font-semibold uppercase tracking-wide text-faint">
          build {process.env.NEXT_PUBLIC_BUILD}
        </p>
      </div>
    </div>
  );
}
