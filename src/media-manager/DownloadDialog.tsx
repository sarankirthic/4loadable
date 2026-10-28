import { useState } from 'react';
import { buildTargetPath } from '../shared/filename-utils';
import { formatBytes } from '../shared/media-filter';
import type { DownloadOptions, MediaItem, Settings } from '../shared/types';

interface Props {
  title: string;
  items: MediaItem[];
  settings: Settings;
  showTypes: boolean;
  onCancel(): void;
  onStart(options: DownloadOptions, types: Settings['types']): void;
}

export function DownloadDialog({ title, items, settings, showTypes, onCancel, onStart }: Props) {
  const [o, setO] = useState<DownloadOptions>({ ...settings });
  const [types, setTypes] = useState(settings.types);
  const set = <K extends keyof DownloadOptions>(k: K, v: DownloadOptions[K]) => setO((p) => ({ ...p, [k]: v }));
  const inc = items.filter((i) => types[i.type] || !showTypes);
  const bytes = inc.reduce((s, i) => s + (i.size ?? 0), 0);
  const known = inc.filter((i) => i.size != null).length;
  const sample = inc[0] && buildTargetPath(inc[0], o, { index: 1, date: new Date().toISOString().slice(0, 10) }).path;
  return (
    <div className="modal-bg" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal">
        <h2>{title}</h2>
        <div>{inc.length} file{inc.length === 1 ? '' : 's'}{known ? ` · about ${formatBytes(bytes)}${known < inc.length ? ` (size known for ${known})` : ''}` : ''}</div>
        {showTypes && (
          <div className="row">Include:
            {(['image', 'gif', 'video'] as const).map((t) => (
              <label key={t} className="chip"><input type="checkbox" checked={types[t]} onChange={() => setTypes({ ...types, [t]: !types[t] })} />{t === 'image' ? 'Images' : t === 'gif' ? 'GIFs' : 'Videos'}</label>
            ))}
          </div>
        )}
        <div className="field"><label htmlFor="d-root">Base folder</label><input id="d-root" type="text" value={o.rootFolder} onChange={(e) => set('rootFolder', e.target.value)} />
          <small>Inside your browser's Downloads folder.</small></div>
        <div className="field"><label htmlFor="d-sub">Extra subfolder</label><input id="d-sub" type="text" value={o.subfolder} placeholder="optional" onChange={(e) => set('subfolder', e.target.value)} /></div>
        <div className="field"><label htmlFor="d-org">Folder layout</label>
          <select id="d-org" value={o.organize} onChange={(e) => set('organize', e.target.value as DownloadOptions['organize'])}>
            <option value="board-thread-type">board / thread / images, gifs, videos</option><option value="board-thread">board / thread</option><option value="flat">One folder for everything</option>
          </select></div>
        <div className="field"><label htmlFor="d-fn">Filenames</label>
          <select id="d-fn" value={o.filenameMode} onChange={(e) => set('filenameMode', e.target.value as DownloadOptions['filenameMode'])}>
            <option value="original">Original filename</option><option value="server">4chan number (e.g. 1700000000001.png)</option><option value="template">Custom template</option>
          </select></div>
        {o.filenameMode === 'template' && (
          <div className="field"><label htmlFor="d-tpl">Template</label><input id="d-tpl" type="text" value={o.filenameTemplate} onChange={(e) => set('filenameTemplate', e.target.value)} />
            <small>Tokens: {'{original} {server} {post} {thread} {board} {index} {type} {date}'}. The extension is added automatically.</small></div>
        )}
        <div className="field"><label htmlFor="d-dup">If a file exists</label>
          <select id="d-dup" value={o.duplicates} onChange={(e) => set('duplicates', e.target.value as DownloadOptions['duplicates'])}>
            <option value="rename">Keep both (rename the new one)</option><option value="skip">Skip files I already downloaded</option><option value="prompt">Ask the browser each time</option>
          </select><small>Files are never overwritten silently.</small></div>
        <label className="row"><input type="checkbox" checked={o.saveAs} onChange={(e) => set('saveAs', e.target.checked)} />Ask where to save every file (browser prompt)</label>
        <label className="row"><input type="checkbox" checked={o.writeManifest} onChange={(e) => set('writeManifest', e.target.checked)} />Save a manifest.json in each thread folder</label>
        {sample && <div className="muted" style={{ wordBreak: 'break-all' }}>Example: {sample}</div>}
        <div className="muted">Browsers only let extensions save inside the Downloads folder. Use "Ask where to save" to pick another location.</div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={!inc.length} onClick={() => onStart(o, types)}>Download {inc.length}</button>
        </div>
      </div>
    </div>
  );
}
