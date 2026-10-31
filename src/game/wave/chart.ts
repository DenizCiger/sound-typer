import type { TrackAnalysis } from '../../audio/analysis';
import { hitWeights, intensityAt, rng, sectionIndexAt, seedFor, snapToHit, songParts, type BaseSection, type Difficulty } from '../common';

/**
 * Geometry Dash wave style chart. Holding flies the wave up at a fixed slope, releasing flies
 * it down, while the level scrolls by at the song's pace. Generation first lays an ideal path
 * that turns on the music's hits, then builds everything around it with clearance: tunnels
 * that follow the path, saws on the outside of its turns, block columns with a gap where it
 * passes. Following the path is always possible, so every crash is the player's.
 *
 * Hits are weighed like in Shapes: how much a hit stands out (`prom`) decides whether the path
 * turns on it, so a quiet intro still zigzags to its bumps, and how hard it lands (`heft`) sizes
 * what it brings: teeth bitten out of the walls at the turn, saws, tighter pillar gaps. Calm parts
 * fly long lazy sweeps through roomy tunnels, intense parts turn often in tight ones.
 *
 * The level is static: world x is tied to song time (`xs`), so the simulation and renderer
 * just look things up at the current position and seeking needs no replay.
 *
 * The level is open: no floor or ceiling, the walls are all there is, and the camera follows the
 * wave up and down.
 *
 * Units: the view is 100 units tall at 1x zoom; x is in the same units.
 */

/** Wall/path samples per second of song. */
export const RATE = 120;
/** Height of the view at 1x zoom. */
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
/** With nothing to slide along, the path takes any hit after flying straight this long. */
const MAX_STRAIGHT = 0.9;
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
  /** Gravity flipped: holding flies down and letting go flies up. */
  flip: boolean;
  /** World x where the section starts. */
  x0: number;
}

export interface Saw { x: number; y: number; r: number }
export interface Block { x0: number; x1: number; y0: number; y1: number }

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
  /** Shortest time between turns in spam sections, which turn on every hit and double time in between. */
  spamGap: number;
  /**
   * Longest you can fly one way in a spam corridor, seconds: its height. Staying inside takes at
   * least 1 / (2 · spamStroke) taps per second (fewer at slow speeds, where SPAM_MIN_FREE wins).
   */
  spamStroke: number;
  /** Share of song parts (after the first) played with gravity flipped. */
  flips: number;
  /** Hit prominence needed to turn, in quiet and in intense parts. */
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
  /** Hit prominence and spacing for the saws buried in tunnel walls. */
  tunnelSawAt: number;
  tunnelSawGap: number;
  /** Pillar gap, in tunnel half heights. */
  pillarGap: number;
}

const PARAMS: Record<Difficulty, Params> = {
  easy: {
    stages: [0, 3], window: 0.11, minGap: 0.28, spamGap: 0.16, spamStroke: 0.34, flips: 0, thrQuiet: 0.8, thrLoud: 0.55, hp: 5, mini: false,
    loose: 2.2, sawClear: 0.9, sawGap: 0.45, tunnelSawAt: 0.9, tunnelSawGap: 0.8, pillarGap: 1.2,
  },
  normal: {
    stages: [0, 4], window: 0.06, minGap: 0.16, spamGap: 0.09, spamStroke: 0.25, flips: 0.2, thrQuiet: 0.7, thrLoud: 0.4, hp: 4, mini: true,
    loose: 1.7, sawClear: 0.8, sawGap: 0.3, tunnelSawAt: 0.8, tunnelSawGap: 0.6, pillarGap: 1.1,
  },
  hard: {
    stages: [1, 5], window: 0.04, minGap: 0.1, spamGap: 0.07, spamStroke: 0.19, flips: 0.28, thrQuiet: 0.6, thrLoud: 0.25, hp: 3, mini: true,
    loose: 1.35, sawClear: 0.7, sawGap: 0.18, tunnelSawAt: 0.7, tunnelSawGap: 0.35, pillarGap: 1,
  },
};

const THEMES: WaveTheme[] = ['tunnel', 'saws', 'pillars'];
/**
 * Spam: a straight (sometimes gently sloped) corridor barely taller than the wave's swing, so
 * staying inside takes rapid tapping; for the busiest intense parts.
 */
const LOUD_THEMES: WaveTheme[] = ['tunnel', 'saws', 'pillars', 'spam'];

/** Parts longer than this get split (at strong hits) so the obstacles change now and then. */
const SECTION_MAX = 16;
/** Spam comes in bursts: corridors this long, seconds, with a tunnel this long in between. */
const SPAM_LEN = 3.5;
const SPAM_BREAK = 2.5;
/** Slope of sloped spam corridors, as a share of the wave's vertical speed. */
const SPAM_SLOPE = 0.2;
/** Room a spam corridor leaves for the wave to swing in at least, world units (slow speed stages). */
const SPAM_MIN_FREE = 14;
/** Heft from which a turn bites a tooth out of the outside wall. */
const TOOTH_AT = 0.3;

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
  const w = hitWeights(a);
  const parts = songParts(a);
  // Song-relative scale: this song's calmest part gets the slowest stage and its most intense
  // the fastest, but with a minimum range, so a song that barely changes doesn't swing wildly
  const sorted = parts.map((q) => q.inten).sort((x, y) => x - y);
  const low = sorted[0], range = Math.max(0.35, sorted[sorted.length - 1] - low);
  const rates = parts.map((q) => q.rate).sort((x, y) => x - y);
  const busy = rates[Math.floor(rates.length * 0.75)];

  const staged = parts.map((part) => {
    const level = Math.min(1, (part.inten - low) / range);
    const [lo, hi] = p.stages;
    // The wave goes mini for the intense parts that are also the busiest: the drops
    const mini = p.mini && level >= 0.75 && part.rate >= busy && part.end - part.start >= 4;
    return { ...part, level, mini, stage: Math.round(lo + level * (hi - lo)) };
  });
  // Neighbours that ended up with the same speed are one part, so there's no portal for nothing
  for (let k = 0; k + 1 < staged.length;) {
    const q = staged[k], q2 = staged[k + 1];
    if (q.stage === q2.stage && q.mini === q2.mini) {
      const len = q.end - q.start, len2 = q2.end - q2.start;
      staged[k] = { ...q, end: q2.end, level: (q.level * len + q2.level * len2) / (len + len2), inten: (q.inten * len + q2.inten * len2) / (len + len2) };
      staged.splice(k + 1, 1);
    } else k++;
  }

  // Gravity portals: some parts are played upside down (never two in a row, not in the first
  // 20 s), preferably the ones that start with a jump in intensity, so the flip lands on a drop
  const flips = staged.map((part, k) => {
    if (k === 0 || part.start < 20 || part.end - part.start < 6) return false;
    const jump = Math.abs(part.level - staged[k - 1].level);
    return r() < p.flips * (0.6 + 1.2 * jump);
  });
  for (let k = 1; k < flips.length; k++) if (flips[k - 1]) flips[k] = false;

  const sections: WaveSection[] = [];
  let prev: WaveTheme | null = null;
  for (const [pk, part] of staged.entries()) {
    const { level, mini, stage } = part;
    const flip = flips[pk];
    const speed = H_SPEED * SPEED_STAGES[stage];
    // Long parts change obstacles now and then, at a strong hit; the speed stays
    const cuts = [part.start];
    while (part.end - cuts[cuts.length - 1] > SECTION_MAX) {
      const next = snapToHit(a, cuts[cuts.length - 1] + 8 + r() * 4, 2);
      if (part.end - next < 6) break;
      cuts.push(next);
    }
    cuts.push(part.end);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const pool = (level >= 0.6 && !mini ? LOUD_THEMES : THEMES).filter((t) => t !== prev);
      // The obstacles follow the music's character: bassy parts get pillars slamming in on the
      // kicks, accented ones saws, dense ones spam, steady ones tunnels; the dice only lean
      let n = 0, heavy = 0, bass = 0;
      for (let h = 0; h < a.onsetTimes.length; h++) {
        if (a.onsetTimes[h] < cuts[k] || a.onsetTimes[h] >= cuts[k + 1] || w.prom[h] < 0.45) continue;
        n++;
        if (w.heft[h] >= 0.55) heavy++;
        if (a.onsetLowness[h] > 0.5) bass++;
      }
      const rate = n / Math.max(1, cuts[k + 1] - cuts[k]);
      const weight = (t: WaveTheme) => t === 'tunnel' ? 0.6 + (1 - level)
        : t === 'saws' ? 0.4 + 2 * (n ? heavy / n : 0)
        : t === 'pillars' ? 0.4 + 2 * (n ? bass / n : 0)
        : rate >= 2.5 ? 1.5 + (rate - 2.5) : 0;
      let roll = r() * pool.reduce((sum, t) => sum + weight(t), 0);
      const theme = pool.find((t) => (roll -= weight(t)) < 0) ?? pool[0];
      prev = theme;
      sections.push({ start: cuts[k], end: cuts[k + 1], energy: part.inten, theme, stage, speed, vy: speed * (mini ? 2 : 1), mini, flip, x0: 0 });
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
  /**
   * `s` is the hit's heft; `dir` the way the wave was flying into the turn (its outside); `beat`
   * is false for the turns a spam corridor forces off the beat.
   */
  const turns: { i: number; s: number; prom: number; dir: number; beat: boolean }[] = [];
  /** Spam corridors: centre line and half height per sample (NaN outside them). */
  const spamC = new Float32Array(n).fill(NaN), spamH = new Float32Array(n);
  // The corridor of the spam section being laid: centre, its slope, and how far the path may swing
  let sc = 50, sSlope = 0, sFree = 0, spamSec = -1, bi = 0;
  const dt = 1 / RATE;
  let y = 50, dir = 1, x = 0;
  // Spam sections come in bursts: a corridor for a few seconds (ending on a strong hit), then a
  // breather as a plain tunnel, and so on
  const bursts: [number, number][] = [];
  for (const sec of sections) {
    if (sec.theme !== 'spam') continue;
    for (let s0 = sec.start; sec.end - s0 >= 2;) {
      const s1 = Math.min(sec.end, snapToHit(a, s0 + SPAM_LEN, 0.5));
      bursts.push([s0, s1]);
      s0 = snapToHit(a, s1 + SPAM_BREAK, 0.5);
    }
  }
  const inBurst = (t: number) => bursts.some(([s0, s1]) => t >= s0 && t < s1);
  // Where the path may turn: the hits, plus in spam bursts a turn halfway between hits that are
  // far enough apart (double time), to keep the ideal path near the corridor's centre line
  const cands: { t: number; prom: number; k: number; s: number }[] = [];
  for (let h = 0; h < a.onsetTimes.length; h++) {
    const t = a.onsetTimes[h];
    cands.push({ t, prom: w.prom[h], k: w.inten[h], s: w.heft[h] });
    const next = a.onsetTimes[h + 1];
    if (next === undefined || next - t < 2 * p.spamGap) continue;
    if (inBurst(t) && inBurst(next) && next - t < 0.6) cands.push({ t: (t + next) / 2, prom: 0, k: w.inten[h], s: 0 });
  }
  cands.sort((c1, c2) => c1.t - c2.t);
  let lastTurn = -Infinity, hi = 0, si = 0, inten = 0;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    while (si < sections.length - 1 && t >= sections[si + 1].start) {
      si++;
      sections[si].x0 = x;
    }
    const sec = sections[si];
    while (bi < bursts.length && t >= bursts[bi][1]) bi++;
    const spam = bi < bursts.length && t >= bursts[bi][0];
    const r0 = sec.mini ? MINI_R : PLAYER_R;
    if (spam && spamSec !== bi) {
      // A new corridor, straight or gently sloped, only as tall as one short stroke of the wave
      spamSec = bi;
      const sloped = r() < 0.4;
      sSlope = sloped ? (r() < 0.5 ? -1 : 1) * SPAM_SLOPE * sec.vy : 0;
      // Against a slope the wave closes in on the wall faster, so sloped corridors get that much
      // more room to keep the stroke time the same both ways
      sFree = Math.max(SPAM_MIN_FREE, sec.vy * p.spamStroke * (sloped ? 1 + SPAM_SLOPE : 1)) / 2;
      sc = y;
    }
    if (spam) {
      sc += sSlope * dt;
      // The path never swings out of the corridor: turn at its edge, beat or not
      if ((y - sc) * dir >= sFree - 1.5) {
        turns.push({ i, s: 0, prom: 0, dir, beat: false });
        dir = -dir;
        lastTurn = t;
      }
    }
    const target = intensityAt(a, t);
    inten += (target - inten) * (1 - Math.exp(-dt / 0.3));
    while (hi < cands.length && cands[hi].t <= t) {
      const { t: th, prom, k, s } = cands[hi];
      hi++;
      // Calm parts take their time (long sweeps), intense ones turn as fast as the music does
      if (th - lastTurn < (spam ? p.spamGap : p.minGap * (2 - 1.1 * k))) continue;
      // In a spam corridor, every beat that keeps the wave around the centre line is a turn
      if (spam && (y - sc) * dir <= 0) continue;
      // A long straight stretch gets boring: take the next hit, whatever it is
      const straight = th - lastTurn > MAX_STRAIGHT;
      if (!straight && !spam && prom < p.thrQuiet + (p.thrLoud - p.thrQuiet) * k) continue;
      turns.push({ i, s, prom, dir, beat: true });
      dir = -dir;
      lastTurn = th;
    }
    xs[i] = x;
    path[i] = y;
    secOf[i] = si;
    if (spam) { spamC[i] = sc; spamH[i] = sFree + r0; }
    // The tunnel breathes with the music: roomy when it's calm, tight when it's intense
    hws[i] = r0 + 2 * sec.vy * p.window * (1.3 - 0.5 * inten) * (sec.mini ? 0.85 : 1);
    y += dir * sec.vy * dt;
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
    // Spam corridors are straight, whatever the path does inside them
    if (!Number.isNaN(spamC[i])) { top[i] = spamC[i] - spamH[i]; bot[i] = spamC[i] + spamH[i]; }
  }

  // Teeth: the heavier turns bite into the outside wall right where the wave turns, so the walls
  // hit back on the beat. A tooth keeps three quarters of the timing window's slack at the turn
  // (roomy sections have plenty more to bite into), and heavier hits bite deeper and wider
  for (const turn of turns) {
    const sec = sections[secOf[turn.i]];
    if (turn.s < TOOTH_AT || sec.theme === 'spam') continue;
    const r0 = sec.mini ? MINI_R : PLAYER_R;
    const edge = turn.dir > 0 ? bot : top;
    const room = Math.abs(edge[turn.i] - path[turn.i]) - (r0 + 2 * sec.vy * p.window * 0.75);
    const depth = Math.min(room, 2 + 10 * (turn.s - TOOTH_AT) / (1 - TOOTH_AT));
    if (depth < 1) continue;
    const half = 2 + 4 * turn.s;
    const cx = xs[turn.i];
    for (let j = indexAtX(xs, cx - half); j < n && xs[j] <= cx + half; j++) {
      const d = depth * (1 - Math.abs(xs[j] - cx) / half);
      if (turn.dir > 0) bot[j] = Math.min(bot[j], bot[turn.i] - d);
      else top[j] = Math.max(top[j], top[turn.i] + d);
    }
  }

  for (let i = 0; i < n; i++) {
    // A wall never closes in faster than the wave can fly, so entering a tunnel from anywhere
    // (or a narrowing one) can always be survived
    if (i > 0) {
      const rate = sections[secOf[i]].vy * dt * 1.001 + 1e-3;
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
    // Buried deep in the wall: pointless
    if (Math.abs(cy - path[i]) - R > hws[i] * p.loose * 2) return;
    saws.push({ x: cx, y: cy, r: R });
  };
  let lastSaw = -Infinity;
  for (const turn of turns) {
    const t = turn.i * dt;
    const sec = sections[secOf[turn.i]];
    const hw = hws[turn.i];
    // The outside of the turn is the way the wave was heading
    const side = turn.dir;
    if (sec.theme === 'saws' && turn.s >= 0.15 && t - lastSaw >= p.sawGap) {
      // Light hits get small saws, the heaviest a big one on each side
      const R = 2.5 + 7 * turn.s;
      placeSaw(turn.i, side, R, Math.max(PLAYER_R + 3, hw * p.sawClear));
      if (turn.s >= 0.65) placeSaw(turn.i, -side, R * 0.8, Math.max(PLAYER_R + 3, hw * p.sawClear * 1.1));
      lastSaw = t;
    } else if (sec.theme === 'tunnel' && turn.prom >= p.tunnelSawAt && turn.s >= 0.4 && t - lastSaw >= p.tunnelSawGap) {
      // Half buried in the tunnel wall
      placeSaw(turn.i, side, 4 + 5 * turn.s, Math.max(PLAYER_R + 2.5, hw * 0.7));
      lastSaw = t;
    }
  }
  saws.sort((s1, s2) => s1.x - s2.x);

  // ---- Block columns on hits in pillar sections, with a gap around the path ----
  const blocks: Block[] = [];
  let lastPillar = -Infinity;
  for (let k = 0; k < a.onsetTimes.length; k++) {
    const t = a.onsetTimes[k];
    const i = Math.min(n - 1, Math.round(t * RATE));
    if (sections[secOf[i]].theme !== 'pillars' || w.prom[k] < 0.45 || t - lastPillar < 0.45 - 0.2 * w.inten[k]) continue;
    lastPillar = t;
    const cx = xs[i];
    const x0 = cx - PILLAR_W / 2, x1 = cx + PILLAR_W / 2;
    let lo = Infinity, hi2 = -Infinity;
    for (let j = indexAtX(xs, x0); j < n && xs[j] <= x1; j++) { lo = Math.min(lo, path[j]); hi2 = Math.max(hi2, path[j]); }
    // Heavier hits close the gap in a bit
    const gap = hws[i] * p.pillarGap * (1.15 - 0.25 * w.heft[k]);
    // Only the part sticking out of the spiked walls matters
    if (lo - gap > top[i] + 2) blocks.push({ x0, x1, y0: top[i] - 10, y1: lo - gap });
    if (hi2 + gap < bot[i] - 2) blocks.push({ x0, x1, y0: hi2 + gap, y1: bot[i] + 10 });
  }

  const beats: { x: number; s: number }[] = [];
  for (let k = 0; k < a.onsetTimes.length; k++) {
    if (a.onsetStrength[k] >= 0.5) beats.push({ x: sampleAt(xs, a.onsetTimes[k]), s: a.onsetStrength[k] });
  }

  return { sections, xs, path, top, bot, spiky, saws, blocks, beats, checkpoints, maxHp: p.hp };
}
