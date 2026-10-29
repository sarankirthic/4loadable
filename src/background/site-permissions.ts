export interface PermissionsPort {
  request(origins: string[]): Promise<boolean>;
  contains(origins: string[]): Promise<boolean>;
  registerContentScripts(script: { id: string; matches: string[]; js: string[]; runAt: string }): Promise<void>;
}

/** Keep this list short: only sites with their own SiteAdapter belong here. */
export const SITE_ORIGINS: Record<string, string[]> = {
  archiveofsins: ['https://archiveofsins.com/*'],
};

/** Browser permission prompt. Must run directly inside a UI click handler in an extension page (options/popup):
 *  a service worker has no user gesture, so chrome.permissions.request there is rejected. */
export async function requestSiteAccessFromPage(site: string): Promise<boolean> {
  const origins = SITE_ORIGINS[site];
  if (!origins) return false;
  return (globalThis as any).chrome.permissions.request({ origins });
}

/** Register the content script for a site whose permission is already granted (no gesture needed; runs in the service worker). */
export async function registerSiteScripts(site: string, port: PermissionsPort): Promise<boolean> {
  const origins = SITE_ORIGINS[site];
  if (!origins || !(await port.contains(origins))) return false;
  await port.registerContentScripts({ id: site, matches: origins, js: ['content.js'], runAt: 'document_idle' });
  return true;
}

/** Legacy combined helper (request + register). Only valid where a user gesture exists. */
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

/** Re-register scripts for every site whose permission is still granted (idempotent; safe on install/startup). */
export async function ensureSiteScripts(port: PermissionsPort): Promise<void> {
  for (const [site, origins] of Object.entries(SITE_ORIGINS)) {
    try {
      if (await port.contains(origins)) await port.registerContentScripts({ id: site, matches: origins, js: ['content.js'], runAt: 'document_idle' });
    } catch { /* best effort */ }
  }
}

export function chromePermissionsPort(): PermissionsPort {
  const api = () => (globalThis as any).chrome;
  return {
    request: (origins) => api().permissions.request({ origins }),
    contains: (origins) => api().permissions.contains({ origins }),
    // registerContentScripts throws on a duplicate id (second click, reinstall, startup re-registration), so replace instead.
    registerContentScripts: async (script) => {
      const existing = await api().scripting.getRegisteredContentScripts({ ids: [script.id] });
      if (existing?.length) await api().scripting.unregisterContentScripts({ ids: [script.id] });
      await api().scripting.registerContentScripts([script]);
      // Tabs that were already open when access was granted don't get registered scripts until reload; inject now.
      try {
        const tabs = await api().tabs.query({ url: script.matches });
        for (const t of tabs) {
          if (t.id == null) continue;
          await api().scripting.executeScript({ target: { tabId: t.id }, files: script.js }).catch(() => {});
        }
      } catch { /* optional */ }
    },
  };
}
