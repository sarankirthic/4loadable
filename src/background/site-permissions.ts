export interface PermissionsPort {
  request(origins: string[]): Promise<boolean>;
  contains(origins: string[]): Promise<boolean>;
  registerContentScripts(script: { id: string; matches: string[]; js: string[]; runAt: string }): Promise<void>;
}

/** Keep this list short: only sites with their own SiteAdapter belong here. */
export const SITE_ORIGINS: Record<string, string[]> = {
  archiveofsins: ['https://archiveofsins.com/*'],
};

/** Must be called from a UI click (popup/options), never on load — chrome.permissions.request requires a user gesture. */
export async function requestSitePermission(site: string, port: PermissionsPort): Promise<boolean> {
  const origins = SITE_ORIGINS[site];
  if (!origins) return false;
  const granted = await port.request(origins);
  if (granted) await port.registerContentScripts({ id: site, matches: origins, js: ['content.js'], runAt: 'document_idle' });
  return granted;
}

export async function hasSitePermission(site: string, port: PermissionsPort): Promise<boolean> {
  const origins = SITE_ORIGINS[site];
  return origins ? port.contains(origins) : false;
}

export function chromePermissionsPort(): PermissionsPort {
  const api = () => (globalThis as any).chrome;
  return {
    request: (origins) => api().permissions.request({ origins }),
    contains: (origins) => api().permissions.contains({ origins }),
    registerContentScripts: (script) => api().scripting.registerContentScripts([script]),
  };
}
