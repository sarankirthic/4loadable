import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS } from '../shared/storage';
import type { Settings as S } from '../shared/types';
import { useSettings } from '../ui/hooks';
import { send } from '../shared/messaging';
import { requestSiteAccessFromPage } from '../background/site-permissions';

export function SettingsPage() {
  const [s, update, loaded] = useSettings();
  const [saved, setSaved] = useState(false);
  const [archiveEnabled, setArchiveEnabled] = useState<boolean | null>(null);
  useEffect(() => { void send<{ ok: boolean }>({ type: 'SITE_PERMISSION_STATUS', site: 'archiveofsins' }).then((r) => setArchiveEnabled(!!r?.ok)); }, []);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const enableArchive = async () => {
    setArchiveError(null);
    try {
      // The prompt must be the first thing the click does, in this page (not the service worker), or Chrome rejects it.
      const granted = await requestSiteAccessFromPage('archiveofsins');
      if (!granted) { setArchiveError('Permission was not granted. Click the button again and choose Allow.'); return; }
      const r = await send<{ ok: boolean }>({ type: 'REGISTER_SITE_SCRIPTS', site: 'archiveofsins' });
      setArchiveEnabled(true);
      if (!r?.ok) setArchiveError('Access granted, but the scanner could not be registered. Reload the extension and try again.');
    } catch (e) { setArchiveError(`Could not request permission: ${(e as Error).message}`); }
  };
  const set = async (p: Partial<S>) => { await update(p); setSaved(true); setTimeout(() => setSaved(false), 1200); };
  const num = (k: 'maxConcurrent' | 'maxRetries' | 'confirmThreshold', min: number, max: number) => (
    <input type="number" min={min} max={max} value={s[k]} onChange={(e) => set({ [k]: Number(e.target.value) } as Partial<S>)} style={{ width: 90 }} />
  );
  const check = (k: keyof S, label: string, hint?: string) => (
    <label className="row"><input type="checkbox" checked={!!s[k]} onChange={(e) => set({ [k]: e.target.checked } as Partial<S>)} /><span>{label}{hint && <span className="muted"> — {hint}</span>}</span></label>
  );
  if (!loaded) return null;
  return (
    <div className="page">
      <div className="row"><h1 style={{ margin: 0, fontSize: 18 }}>Settings</h1><span className="grow" /><span className="muted" role="status">{saved ? 'Saved' : 'Changes save automatically'}</span></div>

      <section><h2>Where files go</h2>
        <div className="field"><label htmlFor="root">Base folder</label><input id="root" type="text" value={s.rootFolder} onChange={(e) => set({ rootFolder: e.target.value })} /><small>Created inside your browser's Downloads folder. Browsers do not let extensions write anywhere else.</small></div>
        <div className="field"><label htmlFor="sub">Extra subfolder</label><input id="sub" type="text" value={s.subfolder} onChange={(e) => set({ subfolder: e.target.value })} /></div>
        <div className="field"><label htmlFor="org">Folder layout</label><select id="org" value={s.organize} onChange={(e) => set({ organize: e.target.value as S['organize'] })}><option value="board-thread-type">board / thread / images, gifs, videos</option><option value="board-thread">board / thread</option><option value="flat">One folder for everything</option></select></div>
        <div className="field"><label htmlFor="fn">Filenames</label><select id="fn" value={s.filenameMode} onChange={(e) => set({ filenameMode: e.target.value as S['filenameMode'] })}><option value="original">Original filename</option><option value="server">4chan number</option><option value="template">Custom template</option></select></div>
        <div className="field"><label htmlFor="tpl">Template</label><input id="tpl" type="text" value={s.filenameTemplate} onChange={(e) => set({ filenameTemplate: e.target.value })} /><small>{'{original} {server} {post} {thread} {board} {index} {type} {date}'}</small></div>
        <div className="field"><label htmlFor="dup">If a file exists</label><select id="dup" value={s.duplicates} onChange={(e) => set({ duplicates: e.target.value as S['duplicates'] })}><option value="rename">Keep both (rename)</option><option value="skip">Skip files already downloaded</option><option value="prompt">Ask the browser</option></select></div>
        {check('saveAs', 'Ask where to save every file', 'uses your browser’s save dialog')}
        {check('writeManifest', 'Save manifest.json in each thread folder')}
      </section>

      <section><h2>Downloading</h2>
        <div className="field"><label>Default media types</label><div className="row">
          {(['image', 'gif', 'video'] as const).map((t) => <label key={t} className="chip"><input type="checkbox" checked={s.types[t]} onChange={(e) => set({ types: { ...s.types, [t]: e.target.checked } })} />{t === 'image' ? 'Images' : t === 'gif' ? 'GIFs' : 'Videos'}</label>)}</div></div>
        <div className="field"><label>Simultaneous downloads</label>{num('maxConcurrent', 1, 8)}<small>Keep this low to be kind to the server. Default 3.</small></div>
        <div className="field"><label>Retries per file</label>{num('maxRetries', 0, 10)}<small>Only network-type errors are retried.</small></div>
        {check('confirmBulk', 'Confirm before large downloads')}
        <div className="field"><label>Large means at least</label>{num('confirmThreshold', 1, 100000)}</div>
        {check('fullResOnly', 'Full-resolution files only', 'never queue thumbnails')}
        {check('includeQuoted', 'Include media from inline-expanded or hover-preview posts')}
      </section>

      <section><h2>Interface</h2>
        <div className="field"><label htmlFor="th">Theme</label><select id="th" value={s.theme} onChange={(e) => set({ theme: e.target.value as S['theme'] })}><option value="dark">Dark</option><option value="light">Light</option></select></div>
        <div className="field"><label htmlFor="vw">Media view</label><select id="vw" value={s.view} onChange={(e) => set({ view: e.target.value as S['view'] })}><option value="grid">Grid</option><option value="list">List</option></select></div>
        {check('rememberSelection', 'Remember the last selection for each thread')}
        {check('inPageToolbar', 'Show the small toolbar on 4chan pages')}
        <div><button onClick={() => confirm('Reset all settings to defaults?') && set(DEFAULT_SETTINGS)}>Reset to defaults</button></div>
      </section>

      <section><h2>Other sites</h2>
        <p style={{ margin: 0 }}>archiveofsins.com (a 4chan archive) is supported but off by default — it needs its own browser permission before this extension can read its pages. Turning it on lets the extension scan and download media from archiveofsins.com the same way it does on 4chan: locally only, no analytics.</p>
        <div className="row" style={{ marginTop: 8 }}>
          {archiveEnabled ? <span className="muted">Enabled on archiveofsins.com</span> : <button onClick={() => void enableArchive()} disabled={archiveEnabled === null}>Enable on archiveofsins.com</button>}
          {archiveError && <span role="alert" style={{ color: 'var(--bad, #c0392b)' }}>{archiveError}</span>}
        </div>
      </section>

      <section><h2>Privacy</h2>
        <p style={{ margin: 0 }}>Everything stays on your device. The extension has no server, analytics, or ads. It sends no media URLs or browsing history anywhere. Its only network requests go to 4chan itself: the file downloads you start, 4chan’s public thread API when you scan threads (limited to one request per second), and optional HEAD checks when you click "Check for deleted files". Settings, scan results, the queue and history are kept in your browser’s extension storage.</p>
      </section>

      <section><h2>Permissions</h2>
        <dl style={{ margin: 0 }}>
          <dt>downloads</dt><dd>Saves files through your browser and reports whether each one finished.</dd>
          <dt>storage</dt><dd>Remembers settings, the queue and download history.</dd>
          <dt>alarms</dt><dd>Wakes the background worker so queued downloads and retries continue after it sleeps.</dd>
          <dt>boards.4chan.org, boards.4channel.org</dt><dd>Lets the scanner read posts on 4chan pages.</dd>
          <dt>a.4cdn.org</dt><dd>4chan’s public JSON API, used only when you scan threads from a board or catalog.</dd>
          <dt>i.4cdn.org</dt><dd>4chan’s media host, used for optional availability checks.</dd>
          <dt>scripting</dt><dd>Lets the extension turn its archiveofsins.com scanner on only after you grant the optional permission above.</dd>
          <dt>archiveofsins.com (optional)</dt><dd>Only requested if you click "Enable on archiveofsins.com" above; lets the scanner read posts on that archive.</dd>
        </dl>
      </section>
    </div>
  );
}
