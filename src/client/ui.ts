// Shared bits for our MapLibre controls: an icon button that opens a floating panel.
// Opening one panel closes any other.

const OPEN_EVENT = 'qre-panel-open';

export function createPanelControl(iconSvg: string, title: string): { container: HTMLElement; panel: HTMLElement } {
  const container = document.createElement('div');
  container.className = 'maplibregl-ctrl maplibregl-ctrl-group qre-ctrl';

  const button = document.createElement('button');
  button.type = 'button';
  button.title = title;
  button.innerHTML = iconSvg;

  const panel = document.createElement('div');
  panel.className = 'qre-panel';
  panel.hidden = true;

  button.onclick = () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: panel }));
  };
  document.addEventListener(OPEN_EVENT, (e) => {
    if ((e as CustomEvent).detail !== panel) panel.hidden = true;
  });

  container.append(button, panel);
  return { container, panel };
}

export function panelSection(panel: HTMLElement, title: string): void {
  const h = document.createElement('div');
  h.className = 'qre-panel-section';
  h.textContent = title;
  panel.append(h);
}

export function loadJson<T>(key: string): Partial<T> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}');
  } catch {
    return {};
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable – settings just won't persist
  }
}
