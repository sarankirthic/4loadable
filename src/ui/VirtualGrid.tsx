import { useEffect, useState, type ReactNode } from 'react';
import { useElementSize } from './hooks';

interface Props<T> {
  items: T[];
  itemHeight: number;
  minItemWidth?: number; // omit for a single-column list
  gap?: number;
  overscan?: number;
  getKey: (item: T) => string;
  render: (item: T, index: number) => ReactNode;
  empty?: ReactNode;
}

/** Renders only the rows in (or near) the viewport, so thousands of items stay fast. */
export function VirtualGrid<T>({ items, itemHeight, minItemWidth, gap = 8, overscan = 3, getKey, render, empty }: Props<T>) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const [top, setTop] = useState(0);
  const inner = Math.max(0, size.width - 28); // matches the 14px horizontal padding
  const cols = minItemWidth ? Math.max(1, Math.floor((inner + gap) / (minItemWidth + gap))) : 1;
  const rowH = itemHeight + gap;
  const rows = Math.ceil(items.length / cols);
  const start = Math.max(0, Math.floor(top / rowH) - overscan);
  const end = Math.min(rows, Math.ceil((top + size.height) / rowH) + overscan);

  useEffect(() => { const el = ref.current; if (el && el.scrollTop > rows * rowH) el.scrollTop = 0; }, [rows, rowH, ref]);

  const out: ReactNode[] = [];
  for (let r = start; r < end; r++) {
    const slice = items.slice(r * cols, r * cols + cols);
    out.push(
      <div key={r} className="vrow" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, height: itemHeight }}>
        {slice.map((it, i) => <div key={getKey(it)} style={{ minWidth: 0, height: itemHeight }}>{render(it, r * cols + i)}</div>)}
      </div>,
    );
  }
  return (
    <div ref={ref} className="scroll" onScroll={(e) => setTop((e.target as HTMLElement).scrollTop)}>
      {items.length === 0 ? empty : (
        <div className="vwrap" style={{ height: rows * rowH }}>
          <div className="vrows" style={{ transform: `translateY(${start * rowH}px)` }}>{out}</div>
        </div>
      )}
    </div>
  );
}
