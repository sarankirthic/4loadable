import type { HistoryRecord } from './types';

export function toJson(records: HistoryRecord[]): string {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      count: records.length,
      files: records.map((r) => ({
        sourceUrl: r.sourceUrl, originalFilename: r.originalFilename, mediaType: r.mediaType,
        board: r.board, threadId: r.threadId, postNumber: r.postNo, savedPath: r.savedPath,
        downloadedAt: new Date(r.timestamp).toISOString(), status: r.status, ...(r.error ? { error: r.error } : {}),
      })),
    },
    null, 2,
  );
}

/** CSV with RFC 4180 quoting and a guard against spreadsheet formula injection. */
export function csvCell(v: unknown): string {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(records: HistoryRecord[]): string {
  const head = ['source_url', 'original_filename', 'media_type', 'board', 'thread_id', 'post_number', 'saved_path', 'downloaded_at', 'status', 'error'];
  const rows = records.map((r) => [
    r.sourceUrl, r.originalFilename, r.mediaType, r.board, r.threadId, r.postNo, r.savedPath,
    new Date(r.timestamp).toISOString(), r.status, r.error ?? '',
  ].map(csvCell).join(','));
  return [head.join(','), ...rows].join('\r\n') + '\r\n';
}
