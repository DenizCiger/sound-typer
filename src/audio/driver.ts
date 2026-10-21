import type { TrackAnalysis } from './analysis';

export interface DriverParams {
  /** Characters per second at full intensity (before hit boosts). */
  maxCps: number;
  /** Contrast curve exponent applied to the intensity. >1 makes quiet parts slower. */
  dynamics: number;
  /** How much hits matter: burst size and the temporary speed boost after a hit. 0 disables. */
  punch: number;
}

export interface Hit {
  strength: number;
  lowness: number;
}

export interface DriverFrame {
  /** Characters to type from the continuous flow. */
  flowChars: number;
  /** Characters to slam in instantly because of hits this frame. */
  burstChars: number;
  hits: Hit[];
  /** 0..1, what the typing speed is following right now. */
  intensity: number;
}

/** Above this much time between frames we treat it as a seek / stall and don't replay hits. */
const MAX_CATCHUP = 0.25;
const BOOST_DECAY = 0.16;
const MAX_BURST = 14;

/**
 * Turns the precomputed analysis into typing, driven by the audible playback position.
 * Everything is time based (not frame based), so 60 Hz and 144 Hz displays behave the same.
 */
export class TypingDriver {
  private analysis: TrackAnalysis;
  private nextOnset = 0;
  private lastPos = -1;
  private acc = 0;
  private boost = 0;

  constructor(analysis: TrackAnalysis) {
    this.analysis = analysis;
  }

  private sample(arr: Float32Array, pos: number) {
    const x = pos * this.analysis.fps;
    const i = Math.floor(x);
    if (i < 0) return arr[0] ?? 0;
    if (i >= arr.length - 1) return arr[arr.length - 1] ?? 0;
    const f = x - i;
    return arr[i] * (1 - f) + arr[i + 1] * f;
  }

  private seekTo(pos: number) {
    const times = this.analysis.onsetTimes;
    let a = 0, b = times.length;
    while (a < b) { const m = (a + b) >> 1; if (times[m] <= pos) a = m + 1; else b = m; }
    this.nextOnset = a;
    this.boost = 0;
  }

  /** 0..1 intensity at a position, as used for typing (handy for visualisation too). */
  intensityAt(pos: number, dynamics: number) {
    const level = this.sample(this.analysis.level, pos);
    const activity = this.sample(this.analysis.activity, pos);
    // Busy rhythms type a bit faster than sustained pads at the same loudness
    const drive = Math.min(1, level * (0.8 + 0.35 * activity));
    return Math.pow(drive, dynamics);
  }

  step(pos: number, dt: number, params: DriverParams): DriverFrame {
    const hits: Hit[] = [];
    if (this.lastPos < 0 || pos < this.lastPos || pos - this.lastPos > MAX_CATCHUP) {
      this.seekTo(pos);
    } else {
      const { onsetTimes, onsetStrength, onsetLowness } = this.analysis;
      while (this.nextOnset < onsetTimes.length && onsetTimes[this.nextOnset] <= pos) {
        hits.push({ strength: onsetStrength[this.nextOnset], lowness: onsetLowness[this.nextOnset] });
        this.nextOnset++;
      }
    }
    this.lastPos = pos;

    this.boost *= Math.exp(-dt / BOOST_DECAY);
    let burst = 0;
    for (const h of hits) {
      // Weak hits (hi-hats) nudge, strong hits slam a chunk of text in
      burst += params.punch * MAX_BURST * h.strength * h.strength;
      this.boost = Math.max(this.boost, params.punch * 1.5 * h.strength);
    }

    const intensity = this.intensityAt(pos, params.dynamics);
    const cps = params.maxCps * intensity * (1 + this.boost);
    this.acc += cps * Math.min(dt, 0.1);
    const flowChars = Math.floor(this.acc);
    this.acc -= flowChars;

    return { flowChars, burstChars: Math.round(burst), hits, intensity };
  }

  reset() {
    this.lastPos = -1;
    this.acc = 0;
    this.boost = 0;
  }
}
