import type { ScanContext, ScanOptions, ScanResult } from '../content/media-scanner';
import type { ParsedMediaUrl } from './media-detection';
import type { PageInfo } from './types';
import { fourchanAdapter } from '../adapters/fourchan';
import { archiveofsinsAdapter } from '../adapters/archiveofsins';

export interface SiteAdapter {
  id: string;
  matches(url: URL): boolean;
  detectPage(url: URL, title: string): PageInfo;
  scan(root: ParentNode, ctx: ScanContext, opts: ScanOptions): Promise<ScanResult>;
  allowedMediaHosts(host: string): boolean;
  parseMediaUrl(raw: string, base?: string): ParsedMediaUrl | null;
}

export const ADAPTERS: SiteAdapter[] = [fourchanAdapter, archiveofsinsAdapter];

export function adapterFor(url: URL): SiteAdapter | null {
  return ADAPTERS.find((a) => a.matches(url)) ?? null;
}
