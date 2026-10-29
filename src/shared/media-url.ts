import { parseMediaUrl as parseFourchan, type ParsedMediaUrl } from './media-detection';
import { parseMediaUrl as parseArchive } from '../adapters/archiveofsins';

/** Validate a media URL with the parser belonging to the site that produced it. Unknown sites are rejected. */
export function parseMediaUrlForSite(site: string, raw: string): ParsedMediaUrl | null {
  if (site === 'fourchan') return parseFourchan(raw);
  if (site === 'archiveofsins') return parseArchive(raw);
  return null;
}
