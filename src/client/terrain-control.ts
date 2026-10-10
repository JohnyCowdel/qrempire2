// MapLibre control for live-tuning the height overlay: sun direction/altitude (with an
// animated sweep), shading strength/method, colour palette, elevation range and opacity.
// "Fit to view" stretches the palette over the elevations actually visible.
import {
  applyTerrainSettings, DEFAULT_TERRAIN, PALETTES, sampleElevationRange, SHADE_METHODS,
  type PaletteName, type TerrainSettings,
} from './height-overlay.ts';
import { createPanelControl, loadJson, panelSection, saveJson } from './ui.ts';

const SUN_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">' +
  '<path d="m2 20 7-11 4 6 3-4 6 9Z"/><circle cx="17" cy="5" r="2.2"/></svg>';

const STORAGE_KEY = 'qre.terrain';
const SWEEP_DEG_PER_SEC = 40;

type NumericKey = { [K in keyof TerrainSettings]: TerrainSettings[K] extends number ? K : never }[keyof TerrainSettings];

export class TerrainControl {
  private readonly settings: TerrainSettings;
  private readonly onChange?: (s: Readonly<TerrainSettings>) => void;
  private readonly inputs = new Map<keyof TerrainSettings, HTMLInputElement | HTMLSelectElement>();
  private map: any;
  private container?: HTMLElement;
  private status?: HTMLElement;
  private sweepFrame = 0;
  private fitTimer: ReturnType<typeof setTimeout> | undefined;

  /** @param onChange notified after every settings change (e.g. to light 3D models with the same sun) */
  constructor(onChange?: (s: Readonly<TerrainSettings>) => void) {
    this.settings = { ...DEFAULT_TERRAIN, ...loadJson<TerrainSettings>(STORAGE_KEY) };
    this.onChange = onChange;
  }

  onAdd(map: any): HTMLElement {
    this.map = map;
    const { container, panel } = createPanelControl(SUN_ICON, 'Terrain shading & colours');
    panel.classList.add('qre-terrain');

    panelSection(panel, 'Shading');
    const sweep = document.createElement('button');
    sweep.type = 'button';
    sweep.className = 'qre-mini';
    sweep.textContent = '▶ sweep';
    sweep.title = 'Rotate the sun continuously';
    sweep.onclick = () => {
      this.toggleSweep();
      sweep.textContent = this.sweepFrame ? '■ stop' : '▶ sweep';
    };
    this.slider(panel, 'sunDirection', 'Sun direction', 0, 359, 1, '°', sweep);
    this.slider(panel, 'sunAltitude', 'Sun altitude', 1, 90, 1, '°');
    this.slider(panel, 'shadeStrength', 'Strength', 0, 1, 0.05);
    this.select(panel, 'shadeMethod', 'Method', SHADE_METHODS);

    panelSection(panel, 'Height colours');
    this.select(panel, 'palette', 'Palette', Object.keys(PALETTES) as PaletteName[]);
    this.slider(panel, 'tintMin', 'Lowest', -100, 3000, 5, ' m');
    this.slider(panel, 'tintMax', 'Highest', -100, 4500, 5, ' m');
    this.slider(panel, 'tintOpacity', 'Opacity', 0, 1, 0.05);

    const fitRow = document.createElement('div');
    fitRow.className = 'qre-fit';
    const fit = document.createElement('button');
    fit.type = 'button';
    fit.className = 'qre-mini';
    fit.textContent = 'Fit to view';
    fit.onclick = () => this.fitToView();
    const auto = document.createElement('label');
    const autoBox = document.createElement('input');
    autoBox.type = 'checkbox';
    autoBox.checked = this.settings.autoFit;
    autoBox.onchange = () => {
      this.update({ autoFit: autoBox.checked });
      if (autoBox.checked) this.fitToView();
    };
    auto.append(autoBox, ' auto');
    this.status = document.createElement('span');
    this.status.className = 'qre-status';
    fitRow.append(fit, auto, this.status);
    panel.append(fitRow);

    panelSection(panel, 'Forest');
    this.slider(panel, 'forestOpacity', 'Intensity', 0, 1, 0.05);
    this.slider(panel, 'forestHue', 'Hue', 0, 360, 1, '°').classList.add('qre-hue');
    this.slider(panel, 'forestLightness', 'Lightness', 10, 90, 1, '%');
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'qre-mini qre-reset';
    reset.textContent = 'Reset';
    reset.onclick = () => {
      autoBox.checked = false;
      this.update({ ...DEFAULT_TERRAIN });
    };
    panel.append(reset);

    map.on('moveend', this.onMoveEnd);
    this.container = container;
    return container;
  }

  onRemove(): void {
    cancelAnimationFrame(this.sweepFrame);
    this.map?.off('moveend', this.onMoveEnd);
    this.container?.remove();
    this.map = undefined;
  }

  /** Push the settings onto the map. Call once the height overlay layers exist. */
  apply(): void {
    if (this.map) applyTerrainSettings(this.map, this.settings);
    this.onChange?.(this.settings);
    if (this.settings.autoFit) this.fitToView();
  }

  private update(patch: Partial<TerrainSettings>, persist = true): void {
    Object.assign(this.settings, patch);
    if (this.settings.tintMax <= this.settings.tintMin) this.settings.tintMax = this.settings.tintMin + 5;
    for (const [key, input] of this.inputs) {
      const value = String(this.settings[key]);
      if (input.value !== value) input.value = value;
      input.dispatchEvent(new Event('sync'));
    }
    if (this.map) applyTerrainSettings(this.map, this.settings);
    this.onChange?.(this.settings);
    if (persist) saveJson(STORAGE_KEY, this.settings);
  }

  // ---- widgets ----

  private slider(panel: HTMLElement, key: NumericKey, label: string, min: number, max: number, step: number, unit = '', extra?: HTMLElement) {
    const row = document.createElement('div');
    row.className = 'qre-row';
    const head = document.createElement('div');
    head.className = 'qre-row-head';
    const value = document.createElement('input');
    value.type = 'number';
    Object.assign(value, { min, max, step });
    value.className = 'qre-num';
    const suffix = document.createElement('span');
    suffix.textContent = unit;
    head.append(label, extra ?? '', value, suffix);

    const range = document.createElement('input');
    range.type = 'range';
    Object.assign(range, { min, max, step, value: String(this.settings[key]) });
    value.value = range.value;
    range.oninput = () => this.update({ [key]: Number(range.value) });
    value.onchange = () => this.update({ [key]: Number(value.value) });
    range.addEventListener('sync', () => (value.value = range.value));

    row.append(head, range);
    panel.append(row);
    this.inputs.set(key, range);
    return range;
  }

  private select<K extends 'shadeMethod' | 'palette'>(panel: HTMLElement, key: K, label: string, options: readonly TerrainSettings[K][]) {
    const row = document.createElement('label');
    row.className = 'qre-row qre-row-head';
    const sel = document.createElement('select');
    sel.innerHTML = options.map((o) => `<option>${o}</option>`).join('');
    sel.value = this.settings[key];
    sel.onchange = () => this.update({ [key]: sel.value } as Partial<TerrainSettings>);
    row.append(label, sel);
    panel.append(row);
    this.inputs.set(key, sel);
  }

  // ---- behaviours ----

  private toggleSweep(): void {
    if (this.sweepFrame) {
      cancelAnimationFrame(this.sweepFrame);
      this.sweepFrame = 0;
      saveJson(STORAGE_KEY, this.settings);
      return;
    }
    let last = performance.now();
    const step = (t: number) => {
      const dir = (this.settings.sunDirection + ((t - last) / 1000) * SWEEP_DEG_PER_SEC) % 360;
      last = t;
      this.update({ sunDirection: Math.round(dir * 10) / 10 }, false);
      this.sweepFrame = requestAnimationFrame(step);
    };
    this.sweepFrame = requestAnimationFrame(step);
  }

  private readonly onMoveEnd = () => {
    if (!this.settings.autoFit) return;
    clearTimeout(this.fitTimer);
    this.fitTimer = setTimeout(() => this.fitToView(), 300);
  };

  private async fitToView(): Promise<void> {
    if (!this.map) return;
    if (this.status) this.status.textContent = '…';
    const range = await sampleElevationRange(this.map).catch(() => undefined);
    if (this.status) this.status.textContent = range ? `${range[0]}–${range[1]} m` : 'zoom in';
    if (range) this.update({ tintMin: range[0], tintMax: range[1] });
  }
}
