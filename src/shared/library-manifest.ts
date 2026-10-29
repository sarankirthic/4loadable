/** Parsing for thread-level manifest.json files written by the download manager. */

/** Guard against pathologically large manifest files before ever touching JSON.parse. */
export const MANIFEST_MAX_BYTES = 1_000_000;

export interface ManifestFileRecord {
  sourceUrl: string;
  originalFilename: string;
  postNumber: string;
  savedPath: string;
}

const MANIFEST_NAME_RE = /^manifest( \(\d+\))?\.json$/i;

/** Matches manifest.json and renamed copies like "manifest (1).json" (what a browser download does on name collision). */
export function isManifestName(name: string): boolean {
  return MANIFEST_NAME_RE.test(name);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toFileRecord(v: unknown): ManifestFileRecord | null {
  if (!isRecord(v)) return null;
  const { sourceUrl, originalFilename, postNumber, savedPath } = v;
  if (typeof sourceUrl !== 'string' || typeof originalFilename !== 'string') return null;
  if (typeof postNumber !== 'string' || typeof savedPath !== 'string') return null;
  return { sourceUrl, originalFilename, postNumber, savedPath };
}

/** Parse manifest text into its file records, or null on anything malformed/oversized/wrong-shaped. */
export function parseThreadManifest(text: string): { files: ManifestFileRecord[] } | null {
  if (typeof text !== 'string' || text.length > MANIFEST_MAX_BYTES) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(data) || !Array.isArray(data.files)) return null;
  const files: ManifestFileRecord[] = [];
  for (const entry of data.files) {
    const rec = toFileRecord(entry);
    if (!rec) return null;
    files.push(rec);
  }
  return { files };
}

function lastSegment(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}

/** Find the record whose saved file name (not original filename) matches `savedFileName`. */
export function findManifestRecord(
  m: { files: ManifestFileRecord[] } | null,
  savedFileName: string,
): ManifestFileRecord | undefined {
  if (!m) return undefined;
  return m.files.find((f) => lastSegment(f.savedPath) === savedFileName);
}

const MEDIA_LEAVES = new Set(['images', 'gifs', 'videos']);

/** The thread folder a manifest lives in: strips a trailing images/gifs/videos leaf, since those share one manifest. */
export function manifestDirFor(path: string[]): string[] {
  const leaf = path[path.length - 1];
  if (path.length > 0 && leaf !== undefined && MEDIA_LEAVES.has(leaf)) return path.slice(0, -1);
  return path;
}
