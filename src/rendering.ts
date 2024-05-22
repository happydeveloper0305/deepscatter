/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
/* eslint-disable no-underscore-dangle */
import { BaseType, select } from 'd3-selection';
import { min } from 'd3-array';
import type { Scatterplot } from './scatterplot';
import type { Tile } from './tile';
import type { Zoom } from './interaction';
import type { AestheticSet } from './aesthetics/AestheticSet';
import { timer, Timer } from 'd3-timer';
import { Deeptable } from './Deeptable';
import type * as DS from './shared.d';
import { Table } from 'apache-arrow';
import { StatefulAesthetic } from './aesthetics/StatefulAesthetic';
import { PositionalAesthetic } from './aesthetics/ScaledAesthetic';
class PlotSetting {
  start: number;
  value: number;
  target: number;
  timer: Timer | undefined;
  transform: 'geometric' | 'arithmetic' = 'arithmetic';
  constructor(
    start: number,
    transform: 'geometric' | 'arithmetic' = 'arithmetic' as const,
  ) {
    this.transform = transform;
    this.start = start;
    this.value = start;
    this.target = start;
  }
  update(value: number, duration: number) {
    if (duration === 0) {
      this.value = value;
      if (this.timer !== undefined) {
        this.timer.stop();
      }
      return;
    }
    this.start = this.value;
    this.target = value;
    this.start_timer(duration);
  }
  start_timer(duration: number) {
    if (this.timer !== undefined) {
      this.timer.stop();
    }
    const timer_object = timer((elapsed) => {
      const t = elapsed / duration;
      if (t >= 1) {
        this.value = this.target;
        timer_object.stop();
        return;
      }
      const w1 = 1 - t;
      const w2 = t;
      this.value =
        this.transform === 'geometric'
          ? this.start ** w1 * this.target ** w2
          : this.start * w1 + this.target * w2;
    });
    this.timer = timer_object;
  }
}

class RenderProps {
  // Aesthetics that adhere to the state of the _renderer_
  // as opposed to the individual points.
  // These can transition a little more beautifully.
  maxPoints: PlotSetting;
  targetOpacity: PlotSetting;
  pointSize: PlotSetting;
  foregroundOpacity: PlotSetting;
  backgroundOpacity: PlotSetting;
  foregroundSize: PlotSetting;
  backgroundSize: PlotSetting;
  constructor() {
    this.maxPoints = new PlotSetting(10_000, 'geometric');
    this.pointSize = new PlotSetting(1, 'geometric');
    this.targetOpacity = new PlotSetting(50);
    this.foregroundOpacity = new PlotSetting(1);
    this.backgroundOpacity = new PlotSetting(0.5);
    this.foregroundSize = new PlotSetting(1, 'geometric');
    this.backgroundSize = new PlotSetting(1, 'geometric');
  }
  apply_prefs(prefs: DS.CompletePrefs) {
    const { duration } = prefs;
    this.maxPoints.update(prefs.max_points, duration);
    this.targetOpacity.update(prefs.alpha, duration);
    this.pointSize.update(prefs.point_size, duration);
    this.foregroundOpacity.update(
      prefs.background_options.opacity[1],
      duration,
    );
    this.backgroundOpacity.update(
      prefs.background_options.opacity[0],
      duration,
    );
    this.foregroundSize.update(prefs.background_options.size[1], duration);
    this.backgroundSize.update(prefs.background_options.size[0], duration);
  }
  get max_points() {
    return this.maxPoints.value;
  }
  get alpha() {
    return this.targetOpacity.value;
  }
  get point_size() {
    // console.log('GETTING POINT SIZE', this.pointSize.value);
    return this.pointSize.value;
  }
  get foreground_opacity() {
    return this.foregroundOpacity.value;
  }
  get background_opacity() {
    return this.backgroundOpacity.value;
  }
  get foreground_size() {
    return this.foregroundSize.value;
  }
  get background_size() {
    return this.backgroundSize.value;
  }
}

export class Renderer {
  // A renderer handles drawing to a display element.
  public scatterplot: Scatterplot;
  public holder: d3.Selection<Element, unknown, BaseType, unknown>;
  public canvas: HTMLCanvasElement;
  public deeptable: Deeptable;
  public width: number;
  public height: number;
  // The renderer handles periodic dispatches of calls
  public deferred_functions: Array<() => Promise<void> | void>;
  public _use_scale_to_download_tiles = true;
  public aes?: AestheticSet;
  public _zoom?: Zoom;
  public render_props: RenderProps = new RenderProps();
  constructor(selector: string | Node, scatterplot: Scatterplot) {
    this.scatterplot = scatterplot;
    this.holder = select(selector as string);
    this.canvas = select(
      this.holder!.node()!.firstElementChild,
    ).node() as HTMLCanvasElement;
    this.width = +select(this.canvas).attr('width');
    this.height = +select(this.canvas).attr('height');
    this.deferred_functions = [];
    this._use_scale_to_download_tiles = true;
  }

  get discard_share() {
    // If jitter is temporal, e.g., or filters are in place,
    // it may make sense to estimate the number of hidden points.
    // For now, I don't actually do it.
    return 0;
  }
  /**
   * Render prefs are scatterplot prefs, but for a single tile
   * instead of for a whole table.
   */
  get prefs() {
    const p = { ...this.scatterplot.prefs } as DS.CompletePrefs & {
      arrow_table?: Table;
      arrow_buffer?: Uint8Array;
    };
    // Delete the arrow stuff b/c serializing it is crazy expensive.
    p.arrow_table = undefined;
    p.arrow_buffer = undefined;
    return p;
  }

  get alpha() {
    return this.render_props.alpha;
  }

  get needeedFields(): string[] {
    const { aes } = this;
    const needed = new Set<string>();
    if (aes) {
      for (const v of Object.values(aes.store)) {
        if (v instanceof StatefulAesthetic) {
          for (const f of v.neededFields) {
            needed.add(f);
          }
        }
      }
    }
    return [...needed, 'ix'];
  }

  get optimal_alpha() {
    // This extends a formula suggested by Ricky Reusser to include
    // discard share.

    const zoom_balance = this.prefs.zoom_balance ?? 1;
    const { alpha, point_size, max_ix, width, discard_share, height } = this;
    const k = this.zoom?.transform?.k ?? 1;
    const target_share = alpha / 100;
    const fraction_of_total_visible = 1 / k ** 2;
    const pixelRatio = window?.devicePixelRatio || 1;

    const pixel_area = (width * height) / pixelRatio;
    const total_intended_points = min([
      max_ix,
      this.deeptable.highest_known_ix || 1e10,
    ]) as number;

    const total_points = total_intended_points * (1 - discard_share);
    //console.log({ total_points });
    const size_adjust = Math.exp(Math.log(k) * zoom_balance);
    const area_of_point =
      Math.PI * ((size_adjust * point_size) / pixelRatio / 2) ** 2;
    const target =
      (target_share * pixel_area) /
      (total_points * fraction_of_total_visible * area_of_point);
    // constrain within realistic bounds.
    // would also be possible to adjust size to meet the goal.
    return target < 1 / 255 ? 1 / 255 : target;
  }

  get point_size() {
    return this.render_props.point_size;
  }

  get max_ix() {
    // By default, prefer dropping points to dropping alpha.
    const { prefs } = this;
    const { max_points } = this.render_props;
    if (!this._use_scale_to_download_tiles) {
      return max_points + 1;
    }
    const k = this.zoom.transform!.k;
    const point_size_adjust = Math.exp(Math.log(k) * prefs.zoom_balance);
    return (max_points * k * k) / point_size_adjust / point_size_adjust + 0.5;
  }

  visible_tiles(): Array<Tile> {
    // yield the currently visible tiles based on the zoom state
    // and a maximum index passed manually.
    const { max_ix } = this;

    // Materialize using a tileset method.

    if (!this.aes) throw new Error('Aesthetic missing');
    const x = this.aes.dim('x') as StatefulAesthetic<PositionalAesthetic>;
    const y = this.aes.dim('x') as StatefulAesthetic<PositionalAesthetic>;
    const natural_display =
      x.current.field == 'x' &&
      y.current.field == 'y' &&
      x.last.field == 'x' &&
      y.last.field == 'y';

    const all_tiles = natural_display
      ? this.scatterplot.deeptable
          .map((d: Tile) => d)
          .filter((tile) => {
            const visible = tile.is_visible(
              max_ix,
              this.zoom.current_corners(),
            );
            return visible;
          })
      : this.scatterplot.deeptable
          .map((d) => d)
          .filter((tile) => tile.min_ix < this.max_ix);
    all_tiles.sort((a, b) => a.min_ix - b.min_ix);
    return all_tiles;
  }

  get zoom(): Zoom {
    if (this._zoom === undefined) throw new Error('Zoom state not yet bound');
    return this._zoom as Zoom;
  }

  bind_zoom(zoom: Zoom) {
    this._zoom = zoom;
    return this;
  }

  async initialize() {
    // Asynchronously wait for the basic elements to be done.
    // await this._initializations;
    // this.zoom.restart_timer(500_000);
  }
}
