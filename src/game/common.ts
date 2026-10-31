import type { TrackAnalysis } from '../audio/analysis';

/** Shared helpers for the game styles. */

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface BaseSection {
  start: number;
  end: number;
  /** Mean loudness of the section, 0..1. */
  energy: number;
}

const SECTION_MIN = 6;
const SECTION_MAX = 13;

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Same seed for every difficulty, so a song keeps its structure and only gets denser
export function seedFor(a: TrackAnalysis) {
  let h = 2166136261;
  const mix = (v: number) => { h = Math.imul(h ^ (v | 0), 16777619); };
  mix(a.duration * 1000);
  mix(a.onsetTimes.length);
  for (let i = 0; i < a.onsetTimes.length; i += 7) mix(a.onsetTimes[i] * 1000);
  return h >>> 0;
}

export function sample(arr: Float32Array, fps: number, t: number) {
  const i = Math.min(arr.length - 1, Math.max(0, Math.round(t * fps)));
  return arr[i] ?? 0;
}

/** 0..1 intensity at a position, the same curve the typewriter's speed follows. */
export function intensityAt(a: TrackAnalysis, t: number, dynamics = 1.5) {
  const drive = Math.min(1, sample(a.level, a.fps, t) * (0.8 + 0.35 * sample(a.activity, a.fps, t)));
  return Math.pow(drive, dynamics);
}

/** Seconds either side of a hit that its prominence is judged against. */
const PROM_WINDOW = 4;

export interface HitWeights {
  /**
   * How much a hit stands out from the hits around it, 0..1. A bump in a quiet intro rates as
   * high as a snare in a drop, so quiet passages still get a reaction; it decides *whether* and
   * *what kind* of thing a hit spawns.
   */
  prom: Float32Array;
  /**
   * How hard the hit lands, 0..1: its strength and the music's intensity, a bit more when it
   * stands out. It decides *how big* the reaction is (size, speed, width).
   */
  heft: Float32Array;
  /** Music intensity at each hit (`intensityAt`). */
  inten: Float32Array;
}

export function hitWeights(a: TrackAnalysis): HitWeights {
  const n = a.onsetTimes.length;
  const prom = new Float32Array(n), heft = new Float32Array(n), inten = new Float32Array(n);
  // Reference: the 80th percentile of strengths in the window, so a few huge hits nearby don't
  // drown the rest, and a passage of uniformly weak hits still has its standouts
  let lo = 0, hi = 0;
  const win: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = a.onsetTimes[i];
    while (hi < n && a.onsetTimes[hi] <= t + PROM_WINDOW) hi++;
    while (a.onsetTimes[lo] < t - PROM_WINDOW) lo++;
    win.length = 0;
    for (let j = lo; j < hi; j++) win.push(a.onsetStrength[j]);
    win.sort((x, y) => x - y);
    const ref = Math.max(0.18, win[Math.floor((win.length - 1) * 0.8)]);
    const s = a.onsetStrength[i];
    // Between the absolute and the relative strength: a loud song's weak hits stay weak-ish
    prom[i] = Math.min(1, 0.3 * s + 0.7 * (s / ref));
    inten[i] = intensityAt(a, t);
    // Quiet passages keep their hits light however much they stand out
    heft[i] = Math.min(1, s * (0.35 + 0.65 * Math.sqrt(inten[i])) * (0.7 + 0.3 * prom[i]) + 0.15 * inten[i]);
  }
  return { prom, heft, inten };
}

export function sectionIndexAt(sections: { start: number }[], t: number) {
  let a = 0, b = sections.length - 1;
  while (a < b) { const m = (a + b + 1) >> 1; if (sections[m].start <= t) a = m; else b = m - 1; }
  return a;
}

/** Intensity bins for finding the song's structure. */
const BIN = 0.5;
/** Shortest part of the song with its own speed, in bins. */
const PART_MIN = 8;
/** Cost of another part, against the squared error of fitting the intensity with flat parts. */
const PART_COST = 0.1;
/** Neighbouring parts closer than this in intensity are one part. */
const PART_MERGE = 0.07;
/** How far a part boundary may move to land on the music's sharpest change, seconds. */
const EDGE_REACH = 2.5;
/** Window either side of a candidate boundary that the change is measured over. */
const EDGE_WINDOW = 0.6;
export interface Part { start: number; end: number; inten: number; rate: number }

/**
 * Splits the song where its intensity changes for good: an optimal fit of the intensity curve
 * with flat parts (a penalty per part, at least PART_MIN long), then merging neighbours that
 * ended up alike. Boundaries move onto the strongest hit nearby, so changes land on the drop.
 */
export function songParts(a: TrackAnalysis): Part[] {
  const m = Math.max(1, Math.ceil(a.duration / BIN));
  const v = new Float64Array(m);
  for (let b = 0; b < m; b++) {
    let sum = 0, k = 0;
    for (let t = b * BIN; t < Math.min(a.duration, (b + 1) * BIN); t += 0.05) { sum += intensityAt(a, t); k++; }
    v[b] = k ? sum / k : 0;
  }
  const p1 = new Float64Array(m + 1), p2 = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) { p1[i + 1] = p1[i] + v[i]; p2[i + 1] = p2[i] + v[i] * v[i]; }
  const sse = (i: number, j: number) => { const s = p1[j] - p1[i]; return p2[j] - p2[i] - (s * s) / (j - i); };
  const mean = (i: number, j: number) => (p1[j] - p1[i]) / (j - i);

  let cuts: number[];
  if (m < PART_MIN * 2) {
    cuts = [0, m];
  } else {
    const best = new Float64Array(m + 1).fill(Infinity), from = new Int32Array(m + 1);
    best[0] = 0;
    for (let j = PART_MIN; j <= m; j++) {
      for (let i = 0; i <= j - PART_MIN; i++) {
        if (i > 0 && i < PART_MIN) continue;
        const c = best[i] + sse(i, j) + PART_COST;
        if (c < best[j]) { best[j] = c; from[j] = i; }
      }
    }
    cuts = [m];
    for (let j = m; j > 0; j = from[j]) cuts.unshift(from[j]);
  }
  const ranges = cuts.slice(0, -1).map((c, k) => [c, cuts[k + 1]]);
  for (let k = 0; k + 1 < ranges.length;) {
    if (Math.abs(mean(ranges[k][0], ranges[k][1]) - mean(ranges[k + 1][0], ranges[k + 1][1])) < PART_MERGE) {
      ranges[k] = [ranges[k][0], ranges[k + 1][1]];
      ranges.splice(k + 1, 1);
      k = Math.max(0, k - 1);
    } else k++;
  }

  // The fit only knows half-second bins of a smoothed curve, so a boundary can sit a second or
  // two off the drop: move it to where the intensity changes most sharply the right way, then
  // onto the hit right there
  const STEP = 0.05;
  const fine = new Float64Array(Math.ceil(a.duration / STEP) + 2);
  for (let k = 1; k < fine.length; k++) fine[k] = fine[k - 1] + intensityAt(a, (k - 1) * STEP);
  const avg = (t0: number, t1: number) => {
    const i = Math.max(0, Math.min(fine.length - 1, Math.round(t0 / STEP)));
    const j = Math.max(0, Math.min(fine.length - 1, Math.round(t1 / STEP)));
    return j > i ? (fine[j] - fine[i]) / (j - i) : 0;
  };
  const bounds = ranges.map(([c]) => c * BIN);
  bounds.push(a.duration);
  for (let k = 1; k < bounds.length - 1; k++) {
    const dir = Math.sign(mean(ranges[k][0], ranges[k][1]) - mean(ranges[k - 1][0], ranges[k - 1][1]));
    const lo = Math.max(bounds[k - 1] + 2, bounds[k] - EDGE_REACH), hi = Math.min(bounds[k + 1] - 2, bounds[k] + EDGE_REACH);
    let best = bounds[k], score = -Infinity;
    for (let t = lo; t <= hi; t += STEP) {
      const sc = dir * (avg(t, t + EDGE_WINDOW) - avg(t - EDGE_WINDOW, t)) - 0.01 * Math.abs(t - bounds[k]);
      if (sc > score) { score = sc; best = t; }
    }
    bounds[k] = snapToHit(a, best, 0.35);
  }
  return ranges.map(([i, j], k) => {
    const start = bounds[k], end = bounds[k + 1];
    let hits = 0;
    for (let h = 0; h < a.onsetTimes.length; h++) if (a.onsetTimes[h] >= start && a.onsetTimes[h] < end && a.onsetStrength[h] >= 0.3) hits++;
    return { start, end, inten: mean(i, j), rate: hits / Math.max(1, end - start) };
  });
}

/** The strongest hit within `reach` seconds of t (closer ones preferred), or t itself. */
export function snapToHit(a: TrackAnalysis, t: number, reach: number) {
  let best = t, score = 0.3;
  for (let h = 0; h < a.onsetTimes.length; h++) {
    const d = Math.abs(a.onsetTimes[h] - t);
    if (d > reach) continue;
    const sc = a.onsetStrength[h] - 0.3 * d;
    if (sc > score) { score = sc; best = a.onsetTimes[h]; }
  }
  return best;
}

/** Splits the track into ~6–13 s sections whose boundaries land on strong hits. */
export function buildSections(a: TrackAnalysis, r: () => number): BaseSection[] {
  const sections: BaseSection[] = [];
  const strong: number[] = [];
  for (let i = 0; i < a.onsetTimes.length; i++) if (a.onsetStrength[i] > 0.55) strong.push(a.onsetTimes[i]);

  let start = 0;
  while (start < a.duration) {
    const target = start + SECTION_MIN + r() * (SECTION_MAX - SECTION_MIN);
    // Snap section changes onto a strong hit near the target so they switch on a beat
    let end = target;
    let best = Infinity;
    for (const t of strong) {
      if (t <= start + SECTION_MIN * 0.75) continue;
      const d = Math.abs(t - target);
      if (d < best && d < 2.5) { best = d; end = t; }
      if (t > target + 2.5) break;
    }
    if (a.duration - end < SECTION_MIN * 0.6) end = a.duration;
    end = Math.min(end, a.duration);

    let energy = 0, n = 0;
    for (let t = start; t < end; t += 0.1) { energy += sample(a.level, a.fps, t); n++; }
    sections.push({ start, end, energy: n ? energy / n : 0 });
    start = end;
  }
  if (sections.length === 0) sections.push({ start: 0, end: a.duration, energy: 0 });
  return sections;
}

/** Sliding one second window of "cost", to cap how much a chart throws at the player. */
export function budgetWindow(perSecond: number) {
  const spent: { t: number; n: number }[] = [];
  let total = 0;
  return {
    /** Room left at time t; `scale` stretches the allowance (e.g. by the music's intensity). */
    left(t: number, scale = 1) {
      while (spent.length && spent[0].t < t - 1) total -= spent.shift()!.n;
      return perSecond * scale - total;
    },
    spend(t: number, n: number) { spent.push({ t, n }); total += n; },
  };
}

// Same spring feel as the typewriter's screenshake
const SHAKE_FREQ = 11;
const SHAKE_DAMPING = 0.32;
export const SHAKE_MAX_PX = 12;

/** Damped spring kicked by impacts; read x/y as the canvas offset. */
export class Shake {
  x = 0;
  y = 0;
  private vx = 0;
  private vy = 0;
  private angle = 0;

  kick(px: number) {
    // Mostly reverse the previous direction so consecutive hits feel like impacts, not drift
    this.angle += Math.PI + (Math.random() - 0.5) * Math.PI * 0.9;
    const v = px * 2 * Math.PI * SHAKE_FREQ;
    this.vx += Math.cos(this.angle) * v;
    this.vy += Math.sin(this.angle) * v;
  }

  step(dt: number) {
    const omega = 2 * Math.PI * SHAKE_FREQ;
    const k = omega * omega;
    const c = 2 * SHAKE_DAMPING * omega;
    // Sub-step so the spring is stable on long frames
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = Math.min(dt, 0.1) / steps;
    for (let i = 0; i < steps; i++) {
      this.vx += (-k * this.x - c * this.vx) * h;
      this.vy += (-k * this.y - c * this.vy) * h;
      this.x += this.vx * h;
      this.y += this.vy * h;
    }
  }
}

/** Samples per second of a precomputed play area scale curve. */
export const ZOOM_RATE = 20;
/** Long side of the screen-filling arena we plan for, against its short side of 100. */
export const ARENA_ASPECT = 1.6;

/**
 * How much of the play area attacks cover, as shares of the screen-filling arena, split by how
 * that share changes as the area scales by s: `fixed` (sized to the area, like lanes), `line`
 * (spanning it, like bars and beams: share grows as 1/s) and `blob` (fixed size, like circles:
 * share grows as 1/s²).
 */
export interface Coverage { fixed: number; line: number; blob: number }

/**
 * The play area scale at which attacks cover `target` of it, within [min, max]: the area grows
 * when attacks pile up and shrinks around the few there are when it's calm.
 */
export function scaleFor(c: Coverage, target: number, min: number, max: number) {
  const room = target - c.fixed;
  if (room <= 0.02) return max;
  const s = (c.line + Math.sqrt(c.line * c.line + 4 * room * c.blob)) / (2 * room);
  return Math.min(max, Math.max(min, s));
}

/** Eases a scale toward its target: out quickly when attacks pile up, back in slowly. */
export function easeScale(v: number, target: number, dt: number) {
  return v + (target - v) * (1 - Math.exp(-dt / (target > v ? 0.3 : 2.5)));
}

/** Precomputes an eased scale curve from a target scale over song time. */
export function zoomCurve(duration: number, target: (t: number) => number) {
  const n = Math.ceil(duration * ZOOM_RATE) + 2;
  const s = new Float32Array(n);
  let v = target(0);
  for (let i = 0; i < n; i++) {
    v = easeScale(v, target(i / ZOOM_RATE), 1 / ZOOM_RATE);
    s[i] = v;
  }
  return s;
}

/** Applies the zoom setting to a scale (0 keeps the area still), within sane bounds. */
export function withAmount(s: number, amount: number) {
  return Math.min(1.3, Math.max(0.35, 1 + (s - 1) * amount));
}

/** Play area scale at song time t from a precomputed curve, with the zoom setting applied. */
export function zoomAt(curve: Float32Array, t: number, amount: number) {
  const f = Math.min(curve.length - 1, Math.max(0, t * ZOOM_RATE));
  const i = Math.floor(f), j = Math.min(curve.length - 1, i + 1);
  return withAmount(curve[i] + (curve[j] - curve[i]) * (f - i), amount);
}

/** Sizes the canvas backing store to its CSS size and returns a context in CSS pixels. */
export function prepareCanvas(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const dpr = devicePixelRatio;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h, dpr };
}
