import type { TrackAnalysis } from '../../audio/analysis';
import type { Hit } from '../../audio/driver';
import type { Difficulty } from '../common';
import type { EffectSettings, GameEngine, GameInput } from '../types';
import { buildShapesChart } from './chart';
import { ShapesRenderer } from './render';
import { ShapesSim } from './sim';

/** Just Shapes & Beats style: dash through telegraphed shapes, rewind to checkpoints on death. */
export class ShapesGame implements GameEngine {
  private sim: ShapesSim;
  private renderer = new ShapesRenderer();
  readonly duration: number;

  constructor(analysis: TrackAnalysis, difficulty: Difficulty) {
    this.sim = new ShapesSim(buildShapesChart(analysis, difficulty), analysis);
    this.duration = analysis.duration;
  }

  get stats() { return this.sim.stats; }
  get multiplier() { return this.sim.multiplier; }
  get position() { return this.sim.position; }
  get player() { return this.sim.player; }
  get health() { return { hp: this.sim.hp, max: this.sim.chart.maxHp }; }

  resize(w: number, h: number) { this.sim.resize(w, h); }

  reset() {
    this.sim.reset();
    this.renderer.reset();
  }

  step(pos: number, dt: number, input: GameInput, hits: Hit[], fx: EffectSettings) {
    const res = this.sim.step(pos, dt, input);
    this.renderer.update(this.sim, res, hits, dt, fx);
  }

  draw(canvas: HTMLCanvasElement, fx: EffectSettings) { this.renderer.draw(canvas, this.sim, fx); }

  takeRewind() { return this.sim.takeRewind(); }
}
