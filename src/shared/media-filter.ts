import type { MediaItem, MediaType } from './types';

export type SortKey = 'post' | 'name' | 'type' | 'size' | 'thread';
export interface FilterState {
  query: string;
  types: { image: boolean; gif: boolean; video: boolean };
  sort: SortKey;
  desc: boolean;
}
export const DEFAULT_FILTER: FilterState = { query: '', types: { image: true, gif: true, video: true }, sort: 'post', desc: false };

export function filterAndSort(items: MediaItem[], f: FilterState): MediaItem[] {
  const q = f.query.trim().toLowerCase().replace(/^>>/, '');
  const out = items.filter((i) => {
    if (!f.types[i.type]) return false;
    if (!q) return true;
    return i.originalName.toLowerCase().includes(q) || i.postNo.includes(q) || i.threadId.includes(q) || i.tim.includes(q) || i.ext === q || `${i.originalName}.${i.ext}`.toLowerCase().includes(q);
  });
  const dir = f.desc ? -1 : 1;
  const typeRank: Record<MediaType, number> = { image: 0, gif: 1, video: 2 };
  const cmp: Record<SortKey, (a: MediaItem, b: MediaItem) => number> = {
    post: (a, b) => a.order - b.order,
    name: (a, b) => a.originalName.localeCompare(b.originalName, undefined, { numeric: true }) || a.order - b.order,
    type: (a, b) => typeRank[a.type] - typeRank[b.type] || a.order - b.order,
    thread: (a, b) => Number(a.threadId) - Number(b.threadId) || a.order - b.order,
    size: (a, b) => {
      if (a.size == null && b.size == null) return a.order - b.order;
      if (a.size == null) return 1 * dir; // unknown sizes always sort last
      if (b.size == null) return -1 * dir;
      return a.size - b.size || a.order - b.order;
    },
  };
  return out.sort((a, b) => cmp[f.sort](a, b) * dir);
}

export const selectAll = (visible: MediaItem[]) => new Set(visible.map((i) => i.id));
export const selectType = (visible: MediaItem[], t: MediaType) => new Set(visible.filter((i) => i.type === t).map((i) => i.id));

export function invertSelection(visible: MediaItem[], current: Set<string>): Set<string> {
  const next = new Set(current);
  for (const i of visible) next.has(i.id) ? next.delete(i.id) : next.add(i.id);
  return next;
}

/** Add/remove an inclusive index range of the visible list (shift-click). */
export function selectRange(visible: MediaItem[], from: number, to: number, current: Set<string>, on: boolean): Set<string> {
  const next = new Set(current);
  const [a, b] = from <= to ? [from, to] : [to, from];
  for (let i = Math.max(0, a); i <= Math.min(visible.length - 1, b); i++) on ? next.add(visible[i].id) : next.delete(visible[i].id);
  return next;
}

export function selectionSummary(items: MediaItem[], selected: Set<string>) {
  let count = 0, bytes = 0, known = 0;
  for (const i of items) if (selected.has(i.id)) { count++; if (i.size != null) { bytes += i.size; known++; } }
  return { count, bytes, knownSizes: known };
}

export function countByType(items: MediaItem[]) {
  const c = { image: 0, gif: 0, video: 0 };
  for (const i of items) c[i.type]++;
  return c;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}
