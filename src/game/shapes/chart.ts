import type { TrackAnalysis } from '../../audio/analysis';
import { budgetWindow, buildSections, hitWeights, rng, sample, sectionIndexAt, seedFor, type BaseSection, type Difficulty } from '../common';

/**
 * Just Shapes & Beats style chart: big geometric hazards that show up as a faint warning,
 * turn solid exactly on a hit, then shrink away. Every hazard is a pure function of time
 * (except targeted bars, which lock onto the player's row/column when their warning starts),
 * so the simulation and renderer share the geometry below and seeking needs no replay.
 *
 * Every hit is weighed by how much it stands out locally (`prom`: whether and what it spawns) and
 * how hard it lands (`heft`: how big, wide, fast and lasting the attack is), so a quiet intro's
 * bumps spawn small, light hazards and a drop's slams spawn wide bars, crosses and bursts.
 *
 * Design rules: fast and dense, but readable. Bars across the arena are the main event; small
 * stuff comes in predictable patterns (trails stepping across the arena, volleys of parallel
 * shots) rather than at random; circles/boxes pop up spread apart; homing is limited to small
 * seekers that never come back to back; and every hazard warns at least long enough to walk
 * out of it, so a dash is never forced.
 *
 * Positions are normalized to the arena (0..1); sizes and speeds are in world units
 * (the arena's shorter side is 100).
 */

/** Player walking speed, world units per second. */
export const PLAYER_SPEED = 55;
/** Longest arena side in world units we plan for (a wide desktop window). */
const MAX_SPAN = 180;

interface Timing {
  id: number;
  /** Warning appears. */
  warn: number;
  /** Turns solid (on the beat). */
  hit: number;
  /** Gone. */
  end: number;
}

export type Hazard = Timing & (
  /** Circle that pops on the beat. Targeted ones (small seekers) land where the player was. */
  | { kind: 'bomb'; x: number; y: number; r: number; target?: boolean }
  /** Spinning square. */
  | { kind: 'box'; x: number; y: number; size: number; rot: number; spin: number }
  /**
   * Bar across the whole arena. axis 'h' = horizontal bar at y = at. `span` (share of the
   * arena, for lanes) overrides `width` (world units) when set.
   */
  | { kind: 'bar'; axis: 'h' | 'v'; at: number; width: number; span?: number; target: boolean }
  /**
   * Wall sweeping across the arena with a gap to slip through. axis 'v' = vertical wall moving
   * sideways. With `kicks` (song times) it creeps and lurches forward on each of those beats.
   */
  | { kind: 'wall'; axis: 'h' | 'v'; from: 0 | 1; gap: number; gapSize: number; width: number; kicks?: number[] }
  /**
   * Beam (infinite line) through a point, rotating from a0 to a1. With `path`, pivot and angle
   * follow samples taken every `path.step` seconds from `hit` instead.
   */
  | { kind: 'beam'; x: number; y: number; a0: number; a1: number; width: number; path?: BeamPath }
  /** Small circle flying in a straight line from (x, y). */
  | { kind: 'shot'; x: number; y: number; angle: number; speed: number; r: number }
);

export interface BeamPath {
  step: number;
  /** Normalized pivot positions. */
  x: number[];
  y: number[];
  /** Angles in radians, unwrapped (continuous). */
  a: number[];
}

/**
 * field: pop-ups, seekers and trails + bars on big hits. bars: full bars on every real hit,
 * volleys in between. steps: a bar marching across the arena one lane per hit. walls: sweeping
 * walls with gaps. spinner: beams around
 * a drifting pivot, ray bursts, pop-ups. rain: falling shots, seekers, big pop-ups.
 */
export type Theme = 'field' | 'bars' | 'steps' | 'walls' | 'spinner' | 'rain';

export interface ShapesSection extends BaseSection {
  theme: Theme;
}

export interface ShapesChart {
  sections: ShapesSection[];
  /** Sorted by `warn`. */
  hazards: Hazard[];
  /** Song positions the player rewinds to after running out of health. Starts with 0. */
  checkpoints: number[];
  maxHp: number;
  /** Seconds after a dash ends before the next one. */
  dashCooldown: number;
}

interface Params {
  /** Minimum seconds of warning before a hazard turns solid (bigger ones get more). */
  lead: number;
  /** Seconds to notice a warning before moving, for the walk-out guarantee. */
  reaction: number;
  /** Hazard cost per second (sliding window). */
  budget: number;
  hp: number;
  gapSize: number;
  speed: number;
  /** Least prominent hit that still spawns something (shots, trail bombs). */
  shotMin: number;
  /** Prominence that counts as a big hit. */
  bigAt: number;
  /** Share of full bars that lock onto the player's row/column. */
  targetRatio: number;
  /** Pop-up circles/boxes alive at once. */
  pops: number;
  /** Seconds between homing seekers; they never chain. */
  seekerGap: number;
  dashCooldown: number;
  /** Rotating beams per spinner section. */
  beams: number;
  /**
   * Seconds between a lane going away and the next one going solid in a steps march, so the
   * player can always step back over the march instead of being forced to dash. Lanes end just
   * before the next one lands, so this is all the march has to leave out of the beat.
   */
  stepSlack: number;
  /** Walls may start once the previous one is this far through its sweep. */
  wallSpacing: number;
  /** Shot volleys on weak hits outside rain sections. */
  volleys: boolean;
  /** Longest stretch without anything new before any usable hit fills it in. */
  idleMax: number;
}

const PARAMS: Record<Difficulty, Params> = {
  easy: { lead: 0.85, reaction: 0.4, budget: 3.5, hp: 6, gapSize: 26, speed: 0.9, shotMin: 0.45, bigAt: 0.8, targetRatio: 0.25, pops: 3, seekerGap: 1.4, dashCooldown: 0.2, stepSlack: 0.2, beams: 1, wallSpacing: 0.8, volleys: false, idleMax: 2 },
  normal: { lead: 0.68, reaction: 0.32, budget: 5.5, hp: 4, gapSize: 20, speed: 1.0, shotMin: 0.3, bigAt: 0.75, targetRatio: 0.4, pops: 5, seekerGap: 0.9, dashCooldown: 0.25, stepSlack: 0.13, beams: 2, wallSpacing: 0.65, volleys: true, idleMax: 1.2 },
  hard: { lead: 0.55, reaction: 0.27, budget: 7, hp: 3, gapSize: 18, speed: 1.1, shotMin: 0.2, bigAt: 0.7, targetRatio: 0.45, pops: 6, seekerGap: 0.75, dashCooldown: 0.3, stepSlack: 0.1, beams: 2, wallSpacing: 0.55, volleys: true, idleMax: 0.8 },
};

const COST: Record<Hazard['kind'], number> = { shot: 0.25, bomb: 0.8, box: 0.8, bar: 1, wall: 2, beam: 0 };
const CHECKPOINT_EVERY = 25;
const CALM_THEMES: Theme[] = ['field', 'rain', 'steps'];
const ALL_THEMES: Theme[] = ['field', 'bars', 'steps', 'walls', 'spinner', 'rain'];
const STEP_LANES = 8;
/** How long a steps lane stays solid, at most and at least. */
const STEP_LIFE = 0.4;
const STEP_MIN = 0.1;
/** Share of a lurching wall's sweep that's a steady creep; the rest comes in jolts on the beats. */
const WALL_CREEP = 0.3;
/** How long a wall's lurch takes. */
const LURCH = 0.14;
/** Intensity from which big hits get the heavy attacks, and from which bars may home in. */
const HEAVY_INTEN = 0.3;
const TARGET_INTEN = 0.45;
/** Full bars of one axis alive at once may cover at most this many world units of the arena. */
const BAR_COVER = 30;
const MAX_POP_RADIUS = 14;
const SEEKER_RADIUS = 6;
const TRAIL_RADIUS = 4.5;
const TRAIL_STEP = 0.11;
/** Heft from which a big hit gets the heavy attacks (walls, ray bursts, rings of shots). */
const HEAVY = 0.45;
/** Heft from which bars slam a cross and pop-ups burst into a ring of shots. */
const SLAM = 0.75;

export function buildShapesChart(a: TrackAnalysis, difficulty: Difficulty): ShapesChart {
  const p = PARAMS[difficulty];
  const r = rng(seedFor(a) ^ 0x5eed);
  const w = hitWeights(a);
  let prev: Theme | null = null;
  const sections: ShapesSection[] = buildSections(a, r).map((s) => {
    // Walls only come on big hits; a section without many would sit empty
    let strong = 0;
    for (let i = 0; i < a.onsetTimes.length; i++) {
      if (a.onsetTimes[i] >= s.start && a.onsetTimes[i] < s.end && w.prom[i] >= p.bigAt && w.heft[i] >= HEAVY && w.inten[i] >= HEAVY_INTEN) strong++;
    }
    const punchy = strong / Math.max(1, s.end - s.start) >= 0.35;
    const pool = (s.energy < 0.3 ? CALM_THEMES : ALL_THEMES)
      .filter((t) => t !== prev && (punchy || t !== 'walls'));
    const theme = pool[Math.floor(r() * pool.length)];
    prev = theme;
    return { ...s, theme };
  });

  const checkpoints = [0];
  for (const s of sections) {
    if (s.start - checkpoints[checkpoints.length - 1] >= CHECKPOINT_EVERY && a.duration - s.start > 8) checkpoints.push(s.start);
  }

  const hazards: Hazard[] = [];
  const budget = budgetWindow(p.budget);
  // Heft of the hit being placed: it scales every attack and what it costs, so a quiet passage
  // fits several light hazards
  let heft = 0;
  const cost = (kind: Hazard['kind']) => COST[kind] * (0.6 + 0.6 * heft);
  let id = 0;
  let lastSpawn = 0;
  const push = (h: Omit<Timing, 'id'> & Record<string, unknown>) => {
    const hz = { ...h, id: id++, warn: Math.max(0, h.warn) } as Hazard;
    // Section-long beams are free and pushed out of order; they'd jam the window's queue
    if (COST[hz.kind] > 0) {
      budget.spend(hz.hit, cost(hz.kind));
      lastSpawn = Math.max(lastSpawn, hz.hit);
    }
    hazards.push(hz);
  };
  /** Warning start for a hazard you'd have to walk `escape` world units to get out of. */
  const warnFor = (t: number, escape: number, extra = 1) => t - Math.max(p.lead * extra, escape / PLAYER_SPEED + p.reaction);
  const spot = () => 0.15 + r() * 0.7;

  // ---- Spinners: beams around a drifting pivot, driven by the music, for the whole section ----
  const pivots = new Map<ShapesSection, (t: number) => [number, number]>();
  for (const s of sections) {
    if (s.theme !== 'spinner' || s.end - s.start < 4) continue;
    const hit = s.start + 1;
    const end = s.end - 0.1;
    // The pivot wanders on a slow Lissajous curve around the middle of the arena
    const fx = 0.05 + r() * 0.06, fy = 0.05 + r() * 0.06, px = r() * 6.28, py = r() * 6.28;
    const pivot = (t: number): [number, number] => [
      0.5 + 0.22 * Math.sin(2 * Math.PI * fx * (t - s.start) + px),
      0.5 + 0.2 * Math.sin(2 * Math.PI * fy * (t - s.start) + py),
    ];
    pivots.set(s, pivot);

    // Spin speed follows the loudness; hits kick it forward, the biggest ones reverse it
    const kicks: { t: number; s: number }[] = [];
    for (let i = 0; i < a.onsetTimes.length; i++) {
      const t = a.onsetTimes[i];
      if (t >= hit && t < end && w.prom[i] >= 0.65) kicks.push({ t, s: w.heft[i] });
    }
    let dir = r() < 0.5 ? -1 : 1;
    let lastFlip = hit;
    let angle = r() * Math.PI;
    let ki = 0;
    let kick = 0;
    const step = 0.05;
    const path: BeamPath = { step, x: [], y: [], a: [] };
    for (let t = hit; t <= end + step; t += step) {
      while (ki < kicks.length && kicks[ki].t <= t) {
        const k = kicks[ki++];
        if (k.s >= 0.8 && t - lastFlip > 4) { dir = -dir; lastFlip = t; }
        // A short jolt on the beat rather than a sustained speed-up, harder for heavier hits
        kick = Math.max(kick, 1.8 * k.s * k.s);
      }
      const lvl = sample(a.level, a.fps, t), act = sample(a.activity, a.fps, t);
      const drive = Math.min(1, lvl * (0.8 + 0.35 * act));
      angle += dir * ((0.2 + 0.55 * drive * drive) * p.speed + kick) * step;
      kick *= Math.exp(-step / 0.12);
      const [x, y] = pivot(t);
      path.x.push(x);
      path.y.push(y);
      path.a.push(angle);
    }
    const beams = difficulty === 'normal' && r() < 0.5 ? 1 : p.beams;
    for (let k = 0; k < beams; k++) {
      const off = (k * Math.PI) / beams;
      push({ kind: 'beam', warn: s.start, hit, end, x: 0.5, y: 0.5, a0: 0, a1: 0, width: 4.5, path: { ...path, a: path.a.map((v) => v + off) } });
    }
  }

  // The music's intensity at the hit being placed stretches the budget (quiet passages thin
  // out, loud ones get the full load) and speeds up anything that flies
  let inten = 0;
  let scale = 1;
  const pace = () => 0.8 + 0.5 * inten;

  // ---- Ray bursts: short beams fanning out of the spinner's pivot on big hits ----
  let lastBurst = -Infinity;
  const burst = (t: number, sec: ShapesSection) => {
    const pivot = pivots.get(sec);
    if (!pivot || t - lastBurst < 0.9 - 0.4 * inten || budget.left(t, scale) < cost('bar')) return false;
    lastBurst = t;
    const [x, y] = pivot(t);
    const n = (difficulty === 'hard' ? 3 : 2) + (heft >= SLAM ? 1 : 0);
    const base = r() * Math.PI;
    for (let k = 0; k < n; k++) {
      const angle = base + (k * Math.PI) / n;
      push({ kind: 'beam', warn: warnFor(t, 3), hit: t, end: t + 0.25 + 0.3 * heft, x, y, a0: angle, a1: angle, width: 2.5 + 2.5 * heft });
    }
    return true;
  };

  // ---- Rings: a slam bursts into shots flying out from where it landed ----
  const ring = (t: number, x: number, y: number) => {
    const n = 6 + Math.round(4 * heft) + (difficulty === 'hard' ? 2 : 0);
    if (difficulty === 'easy' || budget.left(t, scale) < cost('shot') * n) return;
    const speed = (24 + 22 * heft) * p.speed * pace();
    const base = r() * Math.PI * 2;
    for (let k = 0; k < n; k++) {
      push({ kind: 'shot', warn: t, hit: t, end: t + 200 / speed, x, y, angle: base + (k * 2 * Math.PI) / n, speed, r: 1.3 + 1.2 * heft });
    }
  };

  // ---- Pop-ups: circles/boxes that pop on the beat, spread out from each other ----
  const pops: { x: number; y: number; end: number }[] = [];
  const pop = (t: number, big: boolean, max = p.pops) => {
    const alive = pops.filter((l) => l.end > t);
    if (alive.length >= max || budget.left(t, scale) < cost('bomb')) return false;
    // Best of a few candidate spots: the one furthest from the others, so they don't pile up
    let bx = 0.5, by = 0.5, best = -1;
    for (let k = 0; k < 4; k++) {
      const x = spot(), y = spot();
      const d = alive.reduce((m, l) => Math.min(m, Math.hypot(l.x - x, l.y - y)), 2);
      if (d > best) { best = d; bx = x; by = y; }
    }
    const end = t + 0.3 + 0.35 * heft;
    const size = Math.min(MAX_POP_RADIUS, (3.5 + 10 * heft) * (big ? 1.15 : 1));
    if (r() < 0.6) {
      push({ kind: 'bomb', warn: warnFor(t, size), hit: t, end, x: bx, y: by, r: size });
    } else {
      push({ kind: 'box', warn: warnFor(t, size), hit: t, end, x: bx, y: by, size: size * 1.6, rot: r() * Math.PI, spin: (r() < 0.5 ? -1 : 1) * (1 + 2 * heft) });
    }
    pops.push({ x: bx, y: by, end });
    if (big && heft >= SLAM) ring(t, bx, by);
    return true;
  };

  // ---- Seekers: small bombs that land where the player stood, never back to back ----
  let lastSeeker = -Infinity;
  const seeker = (t: number) => {
    if (t - lastSeeker < p.seekerGap || budget.left(t, scale) < cost('bomb')) return false;
    lastSeeker = t;
    const size = SEEKER_RADIUS * (0.7 + 0.5 * heft);
    push({ kind: 'bomb', warn: warnFor(t, size), hit: t, end: t + 0.3 + 0.2 * heft, x: 0.5, y: 0.5, r: size, target: true });
    return true;
  };

  // ---- Trails: small bombs stepping across the arena, one per hit ----
  let trail = { x: 0.2, y: 0.5, dx: TRAIL_STEP, dy: 0 };
  const newTrail = () => {
    const angle = r() * Math.PI * 2;
    trail = { x: spot(), y: spot(), dx: Math.cos(angle) * TRAIL_STEP, dy: Math.sin(angle) * TRAIL_STEP };
  };
  const trailBomb = (t: number) => {
    if (budget.left(t, scale) < cost('bomb')) return;
    const size = TRAIL_RADIUS * (0.65 + 0.6 * heft);
    push({ kind: 'bomb', warn: warnFor(t, size), hit: t, end: t + 0.4 + 0.2 * heft, x: trail.x, y: trail.y, r: size });
    trail.x += trail.dx;
    trail.y += trail.dy;
    // Bounce off the edges
    if (trail.x < 0.08 || trail.x > 0.92) { trail.dx = -trail.dx; trail.x += 2 * trail.dx; }
    if (trail.y < 0.08 || trail.y > 0.92) { trail.dy = -trail.dy; trail.y += 2 * trail.dy; }
  };

  // ---- Volleys: a row of parallel shots from one edge ----
  let volleyEdge = 0;
  let volleyCount = 0;
  const volley = (t: number) => {
    // Light hits fire a shot or two, heavy ones a full row
    const n = 1 + Math.round(3 * heft);
    if (budget.left(t, scale) < cost('shot') * n) return;
    // Same edge for a few volleys so they read as a pattern, then rotate
    if (volleyCount++ % 4 === 0) volleyEdge = Math.floor(r() * 4);
    const speed = (40 + 24 * heft) * p.speed * pace();
    const offset = r() / n;
    for (let k = 0; k < n; k++) {
      const u = (k + offset) / n;
      const [x, y, angle] = volleyEdge === 0 ? [u, -0.02, Math.PI / 2] : volleyEdge === 1 ? [1.02, u, Math.PI] : volleyEdge === 2 ? [u, 1.02, -Math.PI / 2] : [-0.02, u, 0];
      push({ kind: 'shot', warn: t - p.lead * 0.7, hit: t, end: t + 260 / speed, x, y, angle, speed, r: 1.3 + 1.4 * heft });
    }
  };

  // ---- Full bars: never pile up so much of the arena that there's nowhere left to stand ----
  const bars: { axis: 'h' | 'v'; at: number | null; width: number; warn: number; end: number }[] = [];
  const fullBar = (t: number, axis: 'h' | 'v', target: boolean, extra = 1) => {
    const width = 3 + 10 * heft;
    const warn = warnFor(t, width / 2, extra), end = t + 0.35 + 0.2 * heft;
    // Dense hits would otherwise fill half the screen within a second: count every bar on the
    // same axis that's warning or solid at any point while this one is
    const live = bars.filter((b) => b.axis === axis && b.end > warn && b.warn < end);
    if (live.reduce((sum, b) => sum + b.width, width) > BAR_COVER) return false;
    // Best of a few spots: the one furthest from the other bars, leaving lanes between them
    let at = spot(), best = -1;
    for (let k = 0; k < 4; k++) {
      const c = spot();
      const d = live.reduce((m, b) => (b.at === null ? m : Math.min(m, Math.abs(b.at - c))), 2);
      if (d > best) { best = d; at = c; }
    }
    bars.push({ axis, at: target ? null : at, width, warn, end });
    push({ kind: 'bar', warn, hit: t, end, axis, at, width, target });
    return true;
  };

  let alt = 0;
  let lastWall = -Infinity;
  let lastGap = 0.5;
  let lastAxis: 'h' | 'v' = 'v';
  let lastFrom: 0 | 1 = 0;
  let step = 0, stepDir = 1;
  let stepFree = -Infinity;
  let stepAxis: 'h' | 'v' = 'v';
  let secIndex = -1;

  for (let i = 0; i < a.onsetTimes.length; i++) {
    const t = a.onsetTimes[i];
    const prom = w.prom[i];
    const low = a.onsetLowness[i];
    inten = w.inten[i];
    // Near silence, only the hits that stand out
    if (t < 1.5 || prom < (inten < 0.1 ? 0.45 : p.shotMin)) continue;
    const si = sectionIndexAt(sections, t);
    const sec = sections[si];
    if (si !== secIndex) {
      // Fresh section: new lane orientation, starting side and trail
      secIndex = si;
      stepAxis = r() < 0.5 ? 'h' : 'v';
      stepDir = r() < 0.5 ? 1 : -1;
      step = stepDir > 0 ? 0 : STEP_LANES - 1;
      newTrail();
    }
    heft = w.heft[i];
    const big = prom >= p.bigAt;
    // Big hits in a quiet passage stand out but don't land hard: they get the light attacks
    const heavy = big && heft >= HEAVY && inten >= HEAVY_INTEN;
    // Bars that home in on the player are for the intense parts only
    const homing = heavy && inten >= TARGET_INTEN && r() < p.targetRatio;
    const mid = prom >= 0.45;
    const weak = !mid;
    scale = 0.3 + 0.9 * inten;
    const left = budget.left(t, scale);
    // In a dense stream, a lesser hit leaves room for a clearly bigger one right behind it
    if (!big) {
      let ahead = false;
      for (let j = i + 1; j < a.onsetTimes.length && a.onsetTimes[j] - t < 0.2; j++) {
        if (w.prom[j] >= p.bigAt && w.heft[j] > heft + 0.15) ahead = true;
      }
      if (ahead && left < COST.bar * 2) continue;
    }
    const idle = t - lastSpawn > p.idleMax * (1 + 1.5 * (1 - inten));
    const before = hazards.length;

    switch (sec.theme) {
      case 'field':
        if (heavy && left >= cost('bar') && fullBar(t, alt++ % 2 ? 'h' : 'v', homing)) break;
        if (mid) { if (low < 0.35 || !seeker(t)) pop(t, big); }
        else if (difficulty !== 'easy') trailBomb(t);
        break;

      case 'bars':
        if (weak) { if (p.volleys) volley(t); break; }
        if (left < cost('bar')) break;
        {
          const axis = alt++ % 2 ? 'h' : 'v';
          // The heaviest hits slam a cross
          if (fullBar(t, axis, homing, big ? 1.1 : 1) && difficulty !== 'easy' && heavy && heft >= SLAM && left >= cost('bar') * 2) {
            fullBar(t, axis === 'h' ? 'v' : 'h', false, 1.1);
          }
        }
        break;

      case 'steps': {
        // A lane only goes solid once the previous one is gone (plus some slack): the march
        // can't turn into a solid block the player has to dash through when hits come in a burst.
        // Lanes are shorter-lived in intense parts, so the march keeps up with fast music
        if (weak || left < cost('bar') || t < stepFree) {
          // Volleys only from what the march leaves over, so it doesn't skip beats for them
          if (p.volleys && !big && left >= COST.bar * 1.5) volley(t);
          break;
        }
        // Each lane goes away just before the march's next beat lands, so the march can step on
        // every beat and still never has two lanes solid at once
        let life = STEP_LIFE * (1.15 - 0.45 * inten);
        for (let j = i + 1; j < a.onsetTimes.length && a.onsetTimes[j] < t + life + p.stepSlack; j++) {
          if (w.prom[j] >= 0.45 && a.onsetTimes[j] - t >= STEP_MIN + p.stepSlack) { life = a.onsetTimes[j] - t - p.stepSlack; break; }
        }
        stepFree = t + life + p.stepSlack;
        const span = 1 / STEP_LANES;
        push({ kind: 'bar', warn: warnFor(t, (span * MAX_SPAN) / 2), hit: t, end: t + life, axis: stepAxis, at: (step + 0.5) * span, width: 0, span: span * 0.92, target: false });
        step += stepDir;
        if (step < 0 || step >= STEP_LANES) {
          // Bounce back from the edge, turning the march around
          stepDir = -stepDir;
          step += 2 * stepDir;
        }
        if (heavy && low > 0.4) pop(t, true);
        break;
      }

      case 'walls': {
        // Walls don't scale with speed fully: a wall much faster than the player can only be dashed
        const dur = (3.6 - 1.0 * sec.energy) / Math.sqrt(p.speed);
        if (heavy && t - lastWall > dur * p.wallSpacing && left >= cost('wall')) {
          // Keep the axis and direction within a run of walls; switch once things calm down
          if (t - lastWall > dur * 2) {
            lastAxis = r() < 0.5 ? 'h' : 'v';
            lastFrom = r() < 0.5 ? 0 : 1;
          }
          // Each gap within reach of the previous one, so a run of walls stays threadable
          const gap = t - lastWall < dur * 2 ? Math.min(0.8, Math.max(0.2, lastGap + (r() - 0.5) * 0.6)) : 0.2 + r() * 0.6;
          lastGap = gap;
          lastWall = t;
          // The wall lurches forward on the beats of its sweep instead of gliding
          const kicks: number[] = [];
          for (let j = i + 1; j < a.onsetTimes.length && a.onsetTimes[j] < t + dur - LURCH * 2; j++) {
            if (w.prom[j] >= 0.5 && a.onsetTimes[j] - (kicks[kicks.length - 1] ?? t) >= 0.2) kicks.push(a.onsetTimes[j]);
          }
          const wall = { kind: 'wall', warn: t - p.lead * 1.2, hit: t, end: t + dur, axis: lastAxis, from: lastFrom, gap, gapSize: p.gapSize, width: 6 + 6 * heft, kicks: kicks.length >= 3 ? kicks : undefined } as const;
          push(wall);
          // The heaviest hits close in from both sides at once, gaps lined up
          if (heft >= 0.65 && difficulty !== 'easy' && budget.left(t, scale) >= cost('wall')) push({ ...wall, from: lastFrom === 0 ? 1 : 0 });
        } else if (mid) {
          pop(t, big, Math.ceil(p.pops / 2));
        } else if (difficulty !== 'easy') {
          trailBomb(t);
        }
        break;
      }

      case 'spinner':
        // The beams already sweep the whole arena; lighter on everything else
        if (heavy && burst(t, sec)) break;
        if (mid && pop(t, big, Math.ceil(p.pops / 2))) break;
        if (difficulty === 'hard' || (difficulty === 'normal' && inten > 0.5)) trailBomb(t);
        break;

      case 'rain':
        if (big) {
          pop(t, true);
        } else if (mid && low > 0.5 && seeker(t)) {
          // Seeker placed
        } else if (left >= cost('shot')) {
          const speed = (34 + 24 * heft) * p.speed * pace();
          push({ kind: 'shot', warn: t - p.lead * 0.6, hit: t, end: t + 260 / speed, x: spot(), y: -0.02, angle: Math.PI / 2 + (r() - 0.5) * 0.3, speed, r: 1.2 + 1.6 * heft });
        }
        break;
    }

    // Nothing for a while and this hit didn't spawn anything either: fill the silence (longer
    // silences are fine when the music is calm)
    if (idle && hazards.length === before) {
      if (p.volleys && (sec.theme === 'bars' || sec.theme === 'steps')) volley(t);
      else trailBomb(t);
    }
  }

  hazards.sort((x, y) => x.warn - y.warn);
  return { sections, hazards, checkpoints, maxHp: p.hp, dashCooldown: p.dashCooldown };
}

// ---- Geometry, shared by collisions and drawing ----

export type Geo =
  | { type: 'circle'; x: number; y: number; r: number }
  | { type: 'rect'; x: number; y: number; hw: number; hh: number; rot: number }
  | { type: 'line'; x: number; y: number; angle: number; hw: number };

export interface ArenaInfo {
  w: number;
  h: number;
  /** Normalized player position locked in when a targeted hazard's warning started. */
  targets: Map<number, [number, number]>;
}

/** Pop on the beat, then shrink away at the end. */
function envelope(hz: Hazard, t: number) {
  if (t < hz.hit) return 1;
  const age = t - hz.hit;
  // Lane bars don't pop: they'd spill into the lanes that are meant to be safe
  const pop = age < 0.1 && !(hz.kind === 'bar' && hz.span) ? 1.25 - 2.5 * age : 1;
  const tail = Math.min(1, (hz.end - t) / 0.2);
  return pop * Math.max(0, tail);
}

/** How far through its sweep a wall is at time t, 0..1. */
function wallProgress(hz: Extract<Hazard, { kind: 'wall' }>, t: number) {
  const p = Math.min(1, Math.max(0, (t - hz.hit) / (hz.end - hz.hit)));
  if (!hz.kicks) return p;
  let jolts = 0;
  for (const k of hz.kicks) {
    if (t <= k) break;
    // Fast out, settling in: a lurch, not a slide
    const u = Math.min(1, (t - k) / LURCH);
    jolts += 1 - (1 - u) * (1 - u) * (1 - u);
  }
  return WALL_CREEP * p + (1 - WALL_CREEP) * (jolts / hz.kicks.length);
}

/** The latest beat a lurching wall jolted on, for the renderer's flash. */
export function lastKick(hz: Hazard, t: number) {
  if (hz.kind !== 'wall' || !hz.kicks) return hz.hit;
  let last = hz.hit;
  for (const k of hz.kicks) { if (k > t) break; last = k; }
  return last;
}

/** Shapes of a hazard at time t (during its warning they describe where it will be). */
export function geometry(hz: Hazard, t: number, arena: ArenaInfo): Geo[] {
  const { w, h } = arena;
  const target = arena.targets.get(hz.id);
  const k = envelope(hz, t);
  const big = Math.hypot(w, h);
  switch (hz.kind) {
    case 'bomb': {
      const [x, y] = hz.target && target ? target : [hz.x, hz.y];
      return [{ type: 'circle', x: x * w, y: y * h, r: hz.r * k }];
    }
    case 'box': {
      const rot = hz.rot + hz.spin * Math.max(0, t - hz.hit);
      return [{ type: 'rect', x: hz.x * w, y: hz.y * h, hw: (hz.size / 2) * k, hh: (hz.size / 2) * k, rot }];
    }
    case 'bar': {
      const at = hz.target && target ? (hz.axis === 'h' ? target[1] : target[0]) : hz.at;
      const width = hz.span ? hz.span * (hz.axis === 'h' ? h : w) : hz.width;
      const half = (width / 2) * k;
      return hz.axis === 'h'
        ? [{ type: 'rect', x: w / 2, y: at * h, hw: big, hh: half, rot: 0 }]
        : [{ type: 'rect', x: at * w, y: h / 2, hw: half, hh: big, rot: 0 }];
    }
    case 'wall': {
      const p = wallProgress(hz, t);
      const span = hz.axis === 'v' ? w : h; // direction of travel
      const across = hz.axis === 'v' ? h : w;
      const from = -hz.width, to = span + hz.width;
      const at = hz.from === 0 ? from + (to - from) * p : to - (to - from) * p;
      const g0 = hz.gap * across - hz.gapSize / 2, g1 = hz.gap * across + hz.gapSize / 2;
      const segs: [number, number][] = [[-10, g0], [g1, across + 10]];
      return segs.map(([a, b]) => hz.axis === 'v'
        ? { type: 'rect' as const, x: at, y: (a + b) / 2, hw: hz.width / 2, hh: (b - a) / 2, rot: 0 }
        : { type: 'rect' as const, x: (a + b) / 2, y: at, hw: (b - a) / 2, hh: hz.width / 2, rot: 0 });
    }
    case 'beam': {
      const tail = Math.max(0, Math.min(1, (hz.end - t) / 0.2));
      if (hz.path) {
        const { step, x, y, a } = hz.path;
        const f = Math.min(x.length - 1, Math.max(0, (t - hz.hit) / step));
        const i = Math.min(x.length - 2, Math.floor(f)), u = Math.max(0, f - i);
        const lerp = (v: number[]) => v[i] + (v[i + 1] - v[i]) * u;
        return [{ type: 'line', x: lerp(x) * w, y: lerp(y) * h, angle: lerp(a), hw: (hz.width / 2) * tail }];
      }
      const p = Math.min(1, Math.max(0, (t - hz.hit) / (hz.end - hz.hit)));
      return [{ type: 'line', x: hz.x * w, y: hz.y * h, angle: hz.a0 + (hz.a1 - hz.a0) * p, hw: (hz.width / 2) * tail }];
    }
    case 'shot': {
      const d = Math.max(0, t - hz.hit) * hz.speed;
      return [{ type: 'circle', x: hz.x * w + Math.cos(hz.angle) * d, y: hz.y * h + Math.sin(hz.angle) * d, r: hz.r }];
    }
  }
}

/** Distance from a point to a shape's surface (negative inside). */
export function distanceTo(g: Geo, px: number, py: number) {
  switch (g.type) {
    case 'circle':
      return Math.hypot(px - g.x, py - g.y) - g.r;
    case 'rect': {
      const c = Math.cos(-g.rot), s = Math.sin(-g.rot);
      const dx = px - g.x, dy = py - g.y;
      const lx = Math.abs(dx * c - dy * s) - g.hw;
      const ly = Math.abs(dx * s + dy * c) - g.hh;
      return Math.hypot(Math.max(lx, 0), Math.max(ly, 0)) + Math.min(Math.max(lx, ly), 0);
    }
    case 'line':
      return Math.abs(-(px - g.x) * Math.sin(g.angle) + (py - g.y) * Math.cos(g.angle)) - g.hw;
  }
}
