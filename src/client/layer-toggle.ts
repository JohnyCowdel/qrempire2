// Generic MapLibre control that switches groups of style layers on/off.
// A group matches layers either by explicit id list or by a predicate over the style's
// layer specs, so it works for the base map style and our own overlays alike.
// Choices persist per browser (localStorage), falling back to each group's default.
import { createPanelControl, loadJson, panelSection, saveJson } from './ui.ts';

export interface StyleLayer {
  id: string;
  type: string;
  source?: string;
  'source-layer'?: string;
}

export interface LayerGroup {
  id: string;
  label: string;
  section?: string;
  layers?: readonly string[] | ((layer: StyleLayer) => boolean);
  /** For things that aren't style layers (e.g. a canvas overlay). Called initially and on every change. */
  onChange?: (visible: boolean) => void;
  visible?: boolean; // default when the user hasn't chosen yet (true if omitted)
}

const LAYERS_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">' +
  '<path d="M12 3 2 8l10 5 10-5-10-5Z"/><path d="m2 13 10 5 10-5"/><path d="m2 17.5 10 5 10-5" opacity=".5"/></svg>';

export class LayerToggleControl {
  private readonly groups: readonly LayerGroup[];
  private readonly storageKey: string;
  private readonly state: Record<string, boolean>;
  private readonly notified: Record<string, boolean> = {};
  private map: any;
  private container?: HTMLElement;

  constructor(groups: readonly LayerGroup[], storageKey = 'qre.layers') {
    this.groups = groups;
    this.storageKey = storageKey;
    this.state = { ...Object.fromEntries(groups.map((g) => [g.id, g.visible ?? true])), ...(loadJson<Record<string, boolean>>(storageKey) as Record<string, boolean>) };
  }

  // ---- MapLibre IControl ----

  onAdd(map: any): HTMLElement {
    this.map = map;
    const { container, panel } = createPanelControl(LAYERS_ICON, 'Map layers');

    let section: string | undefined;
    for (const g of this.groups) {
      if (g.section && g.section !== section) {
        section = g.section;
        panelSection(panel, section);
      }
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = this.state[g.id];
      box.onchange = () => this.setVisible(g.id, box.checked);
      label.append(box, ' ', g.label);
      panel.append(label);
    }

    this.container = container;
    map.on('styledata', this.apply); // re-apply when layers are added or the style changes
    this.apply();
    return container;
  }

  onRemove(): void {
    this.map?.off('styledata', this.apply);
    this.container?.remove();
    this.map = undefined;
  }

  // ---- API ----

  isVisible(groupId: string): boolean {
    return this.state[groupId];
  }

  setVisible(groupId: string, visible: boolean): void {
    this.state[groupId] = visible;
    saveJson(this.storageKey, this.state);
    this.apply();
  }

  /** Push the current state onto the map. Safe to call often: only changed layers are touched. */
  readonly apply = (): void => {
    const style = this.map?.getStyle();
    if (!style?.layers) return;
    for (const g of this.groups) {
      if (g.onChange && this.notified[g.id] !== this.state[g.id]) {
        this.notified[g.id] = this.state[g.id];
        g.onChange(this.state[g.id]);
      }
      if (!g.layers) continue;
      const wanted = this.state[g.id] ? 'visible' : 'none';
      const matches = typeof g.layers === 'function' ? g.layers : (l: StyleLayer) => (g.layers as readonly string[]).includes(l.id);
      for (const layer of style.layers as StyleLayer[]) {
        if (!matches(layer)) continue;
        if ((this.map.getLayoutProperty(layer.id, 'visibility') ?? 'visible') !== wanted) {
          this.map.setLayoutProperty(layer.id, 'visibility', wanted);
        }
      }
    }
  };
}
