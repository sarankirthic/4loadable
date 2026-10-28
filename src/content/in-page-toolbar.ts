export interface ToolbarActions {
  scan(): void; selectVisible(): void; downloadSelected(): void; openManager(): void;
}

/** A small collapsible bar inside a shadow root, so it cannot affect (or be affected by) 4chan's CSS. */
export function createToolbar(actions: ToolbarActions) {
  const host = document.createElement('div');
  host.id = 'cmd-toolbar-host';
  host.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483000';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
  <style>
    .bar{font:12px/1.2 system-ui,sans-serif;background:#282a2e;color:#c5c8c6;border:1px solid #373b41;border-radius:6px;display:flex;align-items:center;gap:4px;padding:4px;box-shadow:0 2px 10px #0006}
    button{font:inherit;color:inherit;background:#373b41;border:1px solid #4a4f57;border-radius:4px;padding:5px 8px;cursor:pointer}
    button:hover{background:#4a4f57} button:focus-visible{outline:2px solid #81a2be}
    .count{padding:0 6px;color:#8abeb7;min-width:3ch;text-align:center}
    .toggle{padding:5px 7px}
    .hidden{display:none}
    .status{padding:0 6px;color:#f0c674}
  </style>
  <div class="bar" role="toolbar" aria-label="4chan media downloader">
    <button class="toggle" data-a="toggle" title="Collapse or expand" aria-label="Collapse or expand">◧</button>
    <span class="count" data-r="count" title="Media found on this page">0</span>
    <span class="status hidden" data-r="status"></span>
    <button data-a="scan" class="x">Scan page</button>
    <button data-a="select" class="x">Select visible</button>
    <button data-a="download" class="x">Download selected</button>
    <button data-a="open" class="x">Manager</button>
  </div>`;
  const q = (s: string) => root.querySelector(s) as HTMLElement;
  root.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('button')?.getAttribute('data-a');
    if (a === 'toggle') root.querySelectorAll('.x').forEach((el) => el.classList.toggle('hidden'));
    else if (a === 'scan') actions.scan();
    else if (a === 'select') actions.selectVisible();
    else if (a === 'download') actions.downloadSelected();
    else if (a === 'open') actions.openManager();
  });
  document.documentElement.appendChild(host);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    host,
    setCount(n: number) { q('[data-r="count"]').textContent = String(n); },
    flash(text: string) {
      const s = q('[data-r="status"]');
      s.textContent = text; s.classList.remove('hidden');
      clearTimeout(timer); timer = setTimeout(() => s.classList.add('hidden'), 3500);
    },
    destroy() { host.remove(); },
  };
}
