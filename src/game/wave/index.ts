import type { TrackAnalysis } from '../../audio/analysis';
import type { Hit } from '../../audio/driver';
import type { Difficulty } from '../common';
import type { EffectSettings, GameEngine, GameInput } from '../types';
import { buildWaveChart } from './chart';
import { WaveRenderer } from './render';
import { WaveSim } from './sim';

/** Geometry Dash wave style: hold to fly up, release to fly down, through a level built on the hits. */
export class WaveGame implements GameEngine {
  private sim: WaveSim;
  private renderer = new WaveRenderer();
  readonly duration: number;

  constructor(analysis: TrackAnalysis, difficulty: Difficulty) {
    this.sim = new WaveSim(buildWaveChart(analysis, difficulty), analysis);
    this.duration = analysis.duration;
  }

  get stats() { return this.sim.stats; }
  get multiplier() { return this.sim.multiplier; }
  get position() { return this.sim.position; }
  get player() { return this.sim.player; }
  get health() { return { hp: this.sim.hp, max: this.sim.chart.maxHp }; }

  // The view scales itself to the canvas; the level doesn't depend on its size
  resize() {}

  reset() {
    this.sim.reset();
    this.renderer.reset();
  }

  step(pos: number, dt: number, input: GameInput, hits: Hit[], fx: EffectSettings) {
    const res = this.sim.step(pos, dt, input);
    this.renderer.update(this.sim, res, hits, dt, fx);
  }

  draw(canvas: HTMLCanvasElement) { this.renderer.draw(canvas, this.sim); }

  takeRewind() { return this.sim.takeRewind(); }
}
