import { DEFAULT_FILTER, type FilterState, type SortKey } from '../shared/media-filter';
import type { MediaType } from '../shared/types';

interface Props {
  filter: FilterState;
  setFilter: (f: FilterState) => void;
  counts: { image: number; gif: number; video: number };
  onSelectAll(): void; onSelectNone(): void; onInvert(): void; onSelectType(t: MediaType): void;
}

export function MediaFilters({ filter, setFilter, counts, onSelectAll, onSelectNone, onInvert, onSelectType }: Props) {
  const toggle = (t: MediaType) => setFilter({ ...filter, types: { ...filter.types, [t]: !filter.types[t] } });
  const names: [MediaType, string][] = [['image', 'Images'], ['gif', 'GIFs'], ['video', 'Videos']];
  return (
    <div className="toolbar">
      <div className="row">
        <input type="text" className="grow" placeholder="Search filename or post number (e.g. >>123456)" value={filter.query}
          onChange={(e) => setFilter({ ...filter, query: e.target.value })} aria-label="Search" style={{ minWidth: 220 }} />
        {names.map(([t, label]) => (
          <label key={t} className={`chip${filter.types[t] ? ' on' : ''}`}>
            <input type="checkbox" checked={filter.types[t]} onChange={() => toggle(t)} />
            <span className={`badge ${t}`}>{t === 'image' ? 'IMG' : t === 'gif' ? 'GIF' : 'VID'}</span>{label} {counts[t]}
          </label>
        ))}
        <label className="row">Sort
          <select value={filter.sort} onChange={(e) => setFilter({ ...filter, sort: e.target.value as SortKey })}>
            <option value="post">Post order</option><option value="name">Filename</option><option value="type">Type</option>
            <option value="size">File size</option><option value="thread">Thread</option>
          </select>
        </label>
        <button onClick={() => setFilter({ ...filter, desc: !filter.desc })} aria-label="Reverse sort direction">{filter.desc ? '↓ Desc' : '↑ Asc'}</button>
        {(filter.query || !filter.types.image || !filter.types.gif || !filter.types.video) && <button className="ghost" onClick={() => setFilter({ ...DEFAULT_FILTER, sort: filter.sort, desc: filter.desc })}>Clear filters</button>}
      </div>
      <div className="row">
        <span className="muted">Select (shown items):</span>
        <button onClick={onSelectAll}>All</button>
        <button onClick={() => onSelectType('image')}>Images</button>
        <button onClick={() => onSelectType('gif')}>GIFs</button>
        <button onClick={() => onSelectType('video')}>Videos</button>
        <button onClick={onInvert}>Invert</button>
        <button onClick={onSelectNone}>None</button>
        <span className="muted">Shift-click selects a range.</span>
      </div>
    </div>
  );
}
