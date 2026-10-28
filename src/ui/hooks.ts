import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chromeKV, DEFAULT_SETTINGS, normalizeSettings, saveSettings, loadSettings } from '../shared/storage';
import { scanKey, selectionKey } from '../shared/messaging';
import type { HistoryRecord, QueueItem, ScanState, Settings } from '../shared/types';

const api = () => (globalThis as any).chrome;

/** Subscribe to one key of chrome.storage and keep React state in sync with it. */
export function useStorage<T>(area: 'local' | 'session', key: string | null, initial: T): [T, boolean] {
  const [value, setValue] = useState<T>(initial);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!key) { setValue(initial); setLoaded(true); return; }
    let alive = true;
    api().storage[area].get(key).then((r: any) => { if (!alive) return; setValue(key in r ? r[key] : initial); setLoaded(true); });
    const listener = (c: any, a: string) => { if (a === area && key in c) setValue(c[key].newValue ?? initial); };
    api().storage.onChanged.addListener(listener);
    return () => { alive = false; api().storage.onChanged.removeListener(listener); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [area, key]);
  return [value, loaded];
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => Promise<void>, boolean] {
  const [raw, loaded] = useStorage<Partial<Settings> | undefined>('local', 'settings', undefined);
  const settings = useMemo(() => normalizeSettings(raw), [raw]);
  useEffect(() => { document.documentElement.dataset.theme = settings.theme; }, [settings.theme]);
  const update = useCallback(async (patch: Partial<Settings>) => {
    const cur = await loadSettings(chromeKV('local'));
    await saveSettings(chromeKV('local'), { ...cur, ...patch });
  }, []);
  return [settings ?? DEFAULT_SETTINGS, update, loaded];
}

export const useScan = (tabId: number | null) => useStorage<ScanState | null>('session', tabId != null ? scanKey(tabId) : null, null);
export const useQueue = () => {
  const [q] = useStorage<QueueItem[]>('local', 'queue', []);
  const [paused] = useStorage<boolean>('local', 'queuePaused', false);
  return { queue: q, paused };
};
export const useHistory = () => useStorage<Record<string, HistoryRecord>>('local', 'history', {});

/** Selection is shared with the in-page toolbar via storage.session. */
export function useSelection(tabId: number | null): [Set<string>, (next: Set<string>) => void] {
  const [ids] = useStorage<string[]>('session', tabId != null ? selectionKey(tabId) : null, []);
  const set = useMemo(() => new Set(ids), [ids]);
  const setSel = useCallback((next: Set<string>) => {
    if (tabId != null) void api().storage.session.set({ [selectionKey(tabId)]: [...next] });
  }, [tabId]);
  return [set, setSel];
}

export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

export function useToast(): [string | null, (m: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  const t = useRef<ReturnType<typeof setTimeout>>();
  const show = useCallback((m: string) => { setMsg(m); clearTimeout(t.current); t.current = setTimeout(() => setMsg(null), 5000); }, []);
  return [msg, show];
}
