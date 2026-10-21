import type { TrackAnalysis } from '../../audio/analysis';
import { intensityAt, rng, sectionIndexAt, seedFor, type BaseSection, type Difficulty } from '../common';

/**
 * Geometry Dash wave style chart. Holding flies the wave up at a fixed slope, releasing flies
 * it down, while the level scrolls by at the song's pace. Generation first lays an ideal path
 * that turns on the music's hits, then builds everything around it with clearance: tunnels
 * that follow the path, saws on the outside of its turns, block columns with a gap where it
 * passes. Following the path is always possible, so every crash is the player's.
 *
 * The level is static: world x is tied to song time (`xs`), so the simulation and renderer
 * just look things up at the current position and seeking needs no replay.
 *
 * Units: the arena is 100 units tall; x is in the same units.
 */

/** Wall/path samples per second of song. */
export const RATE = 120;
export const ARENA_H = 100;
/** Horizontal scroll speed at 1x, units per second. The wave's slope is 1 (mini: 2). */
const H_SPEED = 72;
/**
 * Speed stages, like Geometry Dash's speed portals. The song is split where its intensity
 * changes for good (drops, breakdowns, builds) and each part gets the stage its intensity maps
 * to, so calm parts crawl, drops rush, and the speed only changes where the music does.
 */
export const SPEED_STAGES = [0.6, 0.8, 1, 1.25, 1.55, 1.9];
export const PLAYER_R = 1.1;
export const MINI_R = 0.75;
export const ORB_R = 3;
/** The ideal path keeps this far from the floor and ceiling. */
const PATH_BOUND = 6;
const PILLAR_W = 7;
const CHECKPOINT_EVERY = 25;

export type WaveTheme = 'tunnel' | 'saws' | 'pillars' | 'spam';

export interface WaveSection extends BaseSection {
  theme: WaveTheme;
  /** Index into SPEED_STAGES. */
  stage: number;
  /** Horizontal speed, units per second. */
  speed: number;
  /** Vertical speed, units per second. */
  vy: number;
  mini: boolean;
  /** World x where the section starts. */
  x0: number;
}

export interface Saw { x: number; y: number; r: number }
export interface Block { x0: number; x1: number; y0: number; y1: number }
export interface Orb { t: number; x: number; y: number }

export interface WaveChart {
  sections: WaveSection[];
  /** World x at each sample. */
  xs: Float32Array;
  /** The ideal path's y at each sample. */
  path: Float32Array;
  /** Solid above `top` and below `bot`, per sample. */
  top: Float32Array;
  bot: Float32Array;
  /** 1 where the walls are spiked (loose sections) rather than plain tunnel walls. */
  spiky: Uint8Array;
  /** Sorted by x. */
  saws: Saw[];
  blocks: Block[];
  /** Bonus orbs on the path's turns, sorted by time. */
  orbs: Orb[];
  /** World x of the stronger hits, for the background's beat lines. */
  beats: { x: number; s: number }[];
  checkpoints: number[];
  maxHp: number;
}

interface Params {
  /** Lowest and highest speed stage used. */
  stages: [number, number];
  /**
   * Timing window for a turn, seconds early or late (before the music's intensity tightens it).
   * Sets the tunnel's height: a late turn closes the gap to the wall at twice the wave's speed.
   */
  window: number;
  /** Shortest time between turns. */
  minGap: number;
  /** Hit strength needed to turn, in quiet and in intense parts. */
  thrQuiet: number;
  thrLoud: number;
  hp: number;
  mini: boolean;
  /** Sections without a tunnel still have spiked walls this far out, in tunnel half heights. */
  loose: number;
  /** Saw clearance from the path, as a fraction of the tunnel's half height. */
  sawClear: number;
  /** Saw spacing in saw sections, seconds. */
  sawGap: number;
  /** Hit strength and spacing for the saws buried in tunnel walls. */
  tunnelSawAt: number;
  tunnelSawGap: number;
  /** Pillar gap, in tunnel half heights. */
  pillarGap: number;
}

const PARAMS: Record<Difficulty, Params> = {
  easy: {
    stages: [0, 3], window: 0.11, minGap: 0.28, thrQuiet: 0.7, thrLoud: 0.4, hp: 5, mini: false,
    loose: 2.2, sawClear: 0.9, sawGap: 0.45, tunnelSawAt: 0.85, tunnelSawGap: 0.8, pillarGap: 1.2,
  },
  normal: {
    stages: [0, 4], window: 0.06, minGap: 0.16, thrQuiet: 0.55, thrLoud: 0.25, hp: 4, mini: true,
    loose: 1.7, sawClear: 0.8, sawGap: 0.3, tunnelSawAt: 0.75, tunnelSawGap: 0.6, pillarGap: 1.1,
  },
  hard: {
    stages: [1, 5], window: 0.04, minGap: 0.1, thrQuiet: 0.45, thrLoud: 0.12, hp: 3, mini: true,
    loose: 1.35, sawClear: 0.7, sawGap: 0.18, tunnelSawAt: 0.6, tunnelSawGap: 0.35, pillarGap: 1,
  },
};

const THEMES: WaveTheme[] = ['tunnel', 'saws', 'pillars'];
/** Spam: a narrow tunnel turning on every hit, only in the most intense parts. */
const LOUD_THEMES: WaveTheme[] = ['tunnel', 'saws', 'pillars', 'spam'];

/** Intensity bins for finding the song's structure. */
const BIN = 0.5;
/** Shortest part of the song with its own speed, in bins. */
const PART_MIN = 8;
/** Cost of another part, against the squared error of fitting the intensity with flat parts. */
const PART_COST = 0.15;
/** Neighbouring parts closer than this in intensity are one part. */
const PART_MERGE = 0.07;
/** Parts longer than this get split (at strong hits) so the obstacles change now and then. */
const SECTION_MAX = 16;

interface Part { start: number; end: number; inten: number; rate: number }

/**
 * Splits the song where its intensity changes for good: an optimal fit of the intensity curve
 * with flat parts (a penalty per part, at least PART_MIN long), then merging neighbours that
 * ended up alike. Boundaries move onto the strongest hit nearby, so changes land on the drop.
 */
function songParts(a: TrackAnalysis): Part[] {
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

  const bounds = ranges.map(([c]) => c * BIN);
  bounds.push(a.duration);
  for (let k = 1; k < bounds.length - 1; k++) bounds[k] = snapToHit(a, bounds[k], 1);
  return ranges.map(([i, j], k) => {
    const start = bounds[k], end = bounds[k + 1];
    let hits = 0;
    for (let h = 0; h < a.onsetTimes.length; h++) if (a.onsetTimes[h] >= start && a.onsetTimes[h] < end && a.onsetStrength[h] >= 0.3) hits++;
    return { start, end, inten: mean(i, j), rate: hits / Math.max(1, end - start) };
  });
}

/** The strongest hit within `reach` seconds of t (closer ones preferred), or t itself. */
function snapToHit(a: TrackAnalysis, t: number, reach: number) {
  let best = t, score = 0.3;
  for (let h = 0; h < a.onsetTimes.length; h++) {
    const d = Math.abs(a.onsetTimes[h] - t);
    if (d > reach) continue;
    const sc = a.onsetStrength[h] - 0.3 * d;
    if (sc > score) { score = sc; best = a.onsetTimes[h]; }
  }
  return best;
}

/** Linear interpolation of a per-sample array at song time t. */
export function sampleAt(arr: Float32Array, t: number) {
  const f = Math.min(arr.length - 1, Math.max(0, t * RATE));
  const i = Math.floor(f);
  const j = Math.min(arr.length - 1, i + 1);
  return arr[i] + (arr[j] - arr[i]) * (f - i);
}

/** First index whose x is >= x (xs is increasing). */
export function indexAtX(xs: Float32Array, x: number) {
  let a = 0, b = xs.length;
  while (a < b) { const m = (a + b) >> 1; if (xs[m] < x) a = m + 1; else b = m; }
  return a;
}

/** First index of items sorted by x whose x is >= x. */
export function lowerBound(items: { x: number }[], x: number) {
  let a = 0, b = items.length;
  while (a < b) { const m = (a + b) >> 1; if (items[m].x < x) a = m + 1; else b = m; }
  return a;
}

export function sectionAt(chart: WaveChart, t: number) {
  return chart.sections[sectionIndexAt(chart.sections, t)];
}

export function buildWaveChart(a: TrackAnalysis, difficulty: Difficulty): WaveChart {
  const p = PARAMS[difficulty];
  const r = rng(seedFor(a) ^ 0x3a7e);
  const parts = songParts(a);
  // Song-relative scale: this song's calmest part gets the slowest stage and its most intense
  // the fastest, but with a minimum range, so a song that barely changes doesn't swing wildly
  const sorted = parts.map((q) => q.inten).sort((x, y) => x - y);
  const low = sorted[0], range = Math.max(0.35, sorted[sorted.length - 1] - low);
  const rates = parts.map((q) => q.rate).sort((x, y) => x - y);
  const busy = rates[Math.floor(rates.length * 0.75)];

  const sections: WaveSection[] = [];
  let prev: WaveTheme | null = null;
  for (const part of parts) {
    const level = Math.min(1, (part.inten - low) / range);
    const [lo, hi] = p.stages;
    const stage = Math.round(lo + level * (hi - lo));
    const speed = H_SPEED * SPEED_STAGES[stage];
    // The wave goes mini for the intense parts that are also the busiest: the drops
    const mini = p.mini && level >= 0.75 && part.rate >= busy && part.end - part.start >= 4;
    // Long parts change obstacles now and then, at a strong hit; the speed stays
    const cuts = [part.start];
    while (part.end - cuts[cuts.length - 1] > SECTION_MAX) {
      const next = snapToHit(a, cuts[cuts.length - 1] + 8 + r() * 4, 2);
      if (part.end - next < 6) break;
      cuts.push(next);
    }
    cuts.push(part.end);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const pool = (level >= 0.75 && !mini ? LOUD_THEMES : THEMES).filter((t) => t !== prev);
      const theme = pool[Math.floor(r() * pool.length)];
      prev = theme;
      sections.push({ start: cuts[k], end: cuts[k + 1], energy: part.inten, theme, stage, speed, vy: speed * (mini ? 2 : 1), mini, x0: 0 });
    }
  }

  const checkpoints = [0];
  for (const s of sections) {
    if (s.start - checkpoints[checkpoints.length - 1] >= CHECKPOINT_EVERY && a.duration - s.start > 8) checkpoints.push(s.start);
  }

  // ---- The ideal path: flies at the wave's slope and turns on hits ----
  const n = Math.ceil(a.duration * RATE) + 1;
  const xs = new Float32Array(n), path = new Float32Array(n), hws = new Float32Array(n);
  const secOf = new Uint16Array(n);
  const turns: { i: number; s: number; dir: number }[] = [];
  const dt = 1 / RATE;
  let y = 50, dir = 1, x = 0;
  let lastTurn = -Infinity, slideSince = -1, hi = 0, si = 0, inten = 0;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    while (si < sections.length - 1 && t >= sections[si + 1].start) {
      si++;
      sections[si].x0 = x;
    }
    const sec = sections[si];
    const target = intensityAt(a, t);
    inten += (target - inten) * (1 - Math.exp(-dt / 0.3));
    while (hi < a.onsetTimes.length && a.onsetTimes[hi] <= t) {
      const th = a.onsetTimes[hi], s = a.onsetStrength[hi];
      hi++;
      const k = intensityAt(a, th);
      const spam = sections[si].theme === 'spam';
      if (th - lastTurn < p.minGap * (spam ? 0.85 : 1.4 - 0.5 * k)) continue;
      // Sliding along the floor or ceiling gets boring: take the next hit, whatever it is
      const sliding = slideSince >= 0 && th - slideSince > 0.25;
      if (!sliding && !spam && (k < 0.08 || s < p.thrQuiet + (p.thrLoud - p.thrQuiet) * k)) continue;
      turns.push({ i, s, dir });
      dir = -dir;
      lastTurn = th;
      slideSince = -1;
    }
    xs[i] = x;
    path[i] = y;
    secOf[i] = si;
    const r0 = sec.mini ? MINI_R : PLAYER_R;
    hws[i] = r0 + 2 * sec.vy * p.window * (1.15 - 0.3 * inten) * (sec.mini || sec.theme === 'spam' ? 0.85 : 1);
    y += dir * sec.vy * dt;
    if (y < PATH_BOUND || y > ARENA_H - PATH_BOUND) {
      y = Math.min(ARENA_H - PATH_BOUND, Math.max(PATH_BOUND, y));
      if (slideSince < 0) slideSince = t;
    }
    x += sec.speed * dt;
  }

  // ---- Walls: tunnels around the path, looser spiked walls in the other sections ----
  const top = new Float32Array(n), bot = new Float32Array(n), spiky = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const sec = sections[secOf[i]];
    const hw = hws[i];
    const loose = sec.theme === 'saws' || sec.theme === 'pillars';
    top[i] = path[i] - hw * (loose ? p.loose : 1);
    bot[i] = path[i] + hw * (loose ? p.loose : 1);
    if (loose) spiky[i] = 1;
    top[i] = Math.max(-5, top[i]);
    bot[i] = Math.min(ARENA_H + 5, bot[i]);
    // A wall never closes in faster than the wave can fly, so entering a tunnel from anywhere
    // (or a narrowing one) can always be survived
    if (i > 0) {
      const rate = sec.vy * dt * 1.001 + 1e-3;
      top[i] = Math.min(top[i], top[i - 1] + rate);
      bot[i] = Math.max(bot[i], bot[i - 1] - rate);
    }
  }

  // Closest distance from a point to the path, looking at the samples within `reach` in x
  const clearance = (cx: number, cy: number, reach: number) => {
    let best = Infinity;
    for (let i = Math.max(0, indexAtX(xs, cx - reach)); i < n && xs[i] <= cx + reach; i++) {
      best = Math.min(best, Math.hypot(xs[i] - cx, path[i] - cy));
    }
    return best;
  };

  // ---- Saws on the outside of turns (and on both sides of the biggest ones) ----
  const saws: Saw[] = [];
  const placeSaw = (i: number, side: number, R: number, clear: number) => {
    const cx = xs[i];
    let cy = path[i] + side * (R + clear);
    for (let k = 0; k < 40 && clearance(cx, cy, R + clear + 2) < R + clear; k++) cy += side;
    // Mostly off screen: pointless
    if (cy + R * 0.6 < 0 || cy - R * 0.6 > ARENA_H) return;
    saws.push({ x: cx, y: cy, r: R });
  };
  let lastSaw = -Infinity;
  for (const turn of turns) {
    const t = turn.i * dt;
    const sec = sections[secOf[turn.i]];
    const hw = hws[turn.i];
    // The outside of the turn is the way the wave was heading
    const side = turn.dir;
    if (sec.theme === 'saws' && turn.s >= 0.35 && t - lastSaw >= p.sawGap) {
      const R = 4 + 4 * turn.s;
      placeSaw(turn.i, side, R, Math.max(PLAYER_R + 3, hw * p.sawClear));
      if (turn.s >= 0.8) placeSaw(turn.i, -side, R * 0.8, Math.max(PLAYER_R + 3, hw * p.sawClear * 1.1));
      lastSaw = t;
    } else if (sec.theme === 'tunnel' && turn.s >= p.tunnelSawAt && t - lastSaw >= p.tunnelSawGap) {
      // Half buried in the tunnel wall
      placeSaw(turn.i, side, 5 + 3 * turn.s, Math.max(PLAYER_R + 2.5, hw * 0.7));
      lastSaw = t;
    }
  }
  saws.sort((s1, s2) => s1.x - s2.x);

  // ---- Block columns on hits in pillar sections, with a gap around the path ----
  const blocks: Block[] = [];
  let lastPillar = -Infinity;
  for (let k = 0; k < a.onsetTimes.length; k++) {
    const t = a.onsetTimes[k], s = a.onsetStrength[k];
    const i = Math.min(n - 1, Math.round(t * RATE));
    if (sections[secOf[i]].theme !== 'pillars' || s < 0.35 || t - lastPillar < 0.3) continue;
    lastPillar = t;
    const cx = xs[i];
    const x0 = cx - PILLAR_W / 2, x1 = cx + PILLAR_W / 2;
    let lo = Infinity, hi2 = -Infinity;
    for (let j = indexAtX(xs, x0); j < n && xs[j] <= x1; j++) { lo = Math.min(lo, path[j]); hi2 = Math.max(hi2, path[j]); }
    const gap = hws[i] * p.pillarGap;
    // Only the part sticking out of the spiked walls matters
    if (lo - gap > top[i] + 2) blocks.push({ x0, x1, y0: -10, y1: lo - gap });
    if (hi2 + gap < bot[i] - 2) blocks.push({ x0, x1, y0: hi2 + gap, y1: ARENA_H + 10 });
  }

  const orbs: Orb[] = turns.map((turn) => ({ t: turn.i * dt, x: xs[turn.i], y: path[turn.i] }));
  const beats: { x: number; s: number }[] = [];
  for (let k = 0; k < a.onsetTimes.length; k++) {
    if (a.onsetStrength[k] >= 0.5) beats.push({ x: sampleAt(xs, a.onsetTimes[k]), s: a.onsetStrength[k] });
  }

  return { sections, xs, path, top, bot, spiky, saws, blocks, orbs, beats, checkpoints, maxHp: p.hp };
}
