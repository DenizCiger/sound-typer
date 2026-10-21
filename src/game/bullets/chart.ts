import type { TrackAnalysis } from '../../audio/analysis';
import { budgetWindow, buildSections as buildBaseSections, rng, sample, sectionIndexAt, seedFor, type BaseSection, type Difficulty } from '../common';

/**
 * Procedural bullet-hell "chart" for a track. Everything is generated up front from the
 * offline analysis (pure, no DOM, deterministic per track), so patterns fire exactly on the
 * hits, telegraphs can warn ahead of time and seeking just moves a cursor.
 */

/** An emitter's orbit in normalized arena coordinates (0..1 on both axes). */
export interface EmitterPath {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** Orbit speed in revolutions per second. */
  freq: number;
  phase: number;
}

export interface Section extends BaseSection {
  emitters: EmitterPath[];
}

export type ChartEvent =
  /** Bullets in a circle around the emitter. Bassy hits. */
  | { kind: 'ring'; t: number; emitter: number; count: number; speed: number; phase: number; size: number; decel: number; curve: number }
  /** A spread of bullets aimed at the player. Snappy mid/high hits. */
  | { kind: 'fan'; t: number; emitter: number; count: number; spread: number; speed: number; size: number }
  /** Single small bullet aimed at the player. Weak hits (hats, ghost notes). */
  | { kind: 'pellet'; t: number; emitter: number; speed: number }
  /** Spiral stream bullet from the section's spinner, driven by loudness. */
  | { kind: 'stream'; t: number; emitter: number; angle: number; speed: number }
  /** Beam aimed at the player when its warning starts, fires at `t`. Biggest hits. */
  | { kind: 'laser'; t: number; emitter: number; warn: number; duration: number };

export interface Chart {
  sections: Section[];
  /** Sorted by `t`. */
  events: ChartEvent[];
}

interface DifficultyParams {
  density: number;
  speed: number;
  /** Bullets per second the generator may spawn (sliding 1 s window). */
  budget: number;
  pelletMin: number;
  streamRate: number;
  /** Strength a hit needs for a laser (above 1 = never). */
  laserMin: number;
  /** How many emitters a big hit fires from at once. */
  maxEmitters: number;
  /** Minimum seconds between hit patterns, so fast drum fills don't stack up. */
  minGap: number;
  /** Curving rings in loud sections. */
  curves: boolean;
}

export const DIFFICULTY: Record<Difficulty, DifficultyParams> = {
  // Easy has no aimed pellets (pelletMin above the pellet range) and no lasers
  easy: { density: 0.45, speed: 0.7, budget: 18, pelletMin: 0.45, streamRate: 2.5, laserMin: 2, maxEmitters: 1, minGap: 0.3, curves: false },
  normal: { density: 0.85, speed: 0.9, budget: 48, pelletMin: 0.28, streamRate: 6, laserMin: 0.9, maxEmitters: 2, minGap: 0.12, curves: true },
  hard: { density: 1.35, speed: 1.15, budget: 100, pelletMin: 0.12, streamRate: 11, laserMin: 0.8, maxEmitters: 4, minGap: 0, curves: true },
};

const LASER_COOLDOWN = 2.5;
const LASER_WARN = 0.7;

type Layout = (r: () => number) => EmitterPath[];

const LAYOUTS: Layout[] = [
  // One boss in the middle of the top half
  (r) => [{ cx: 0.5, cy: 0.25, rx: 0.12 + r() * 0.1, ry: 0.05, freq: 0.08 + r() * 0.06, phase: r() * 6.28 }],
  // Centre of the arena, slow orbit
  (r) => [{ cx: 0.5, cy: 0.45, rx: 0.08, ry: 0.08, freq: 0.1 + r() * 0.05, phase: r() * 6.28 }],
  // Pair sweeping across the top
  (r) => {
    const f = 0.07 + r() * 0.05;
    return [
      { cx: 0.3, cy: 0.18, rx: 0.15, ry: 0.06, freq: f, phase: 0 },
      { cx: 0.7, cy: 0.18, rx: 0.15, ry: 0.06, freq: f, phase: Math.PI },
    ];
  },
  // Flanks
  (r) => [
    { cx: 0.1, cy: 0.4, rx: 0.03, ry: 0.2, freq: 0.09 + r() * 0.04, phase: 0 },
    { cx: 0.9, cy: 0.4, rx: 0.03, ry: 0.2, freq: 0.09 + r() * 0.04, phase: Math.PI },
  ],
  // Triangle around the centre
  (r) => {
    const f = 0.05 + r() * 0.04;
    const p = r() * 6.28;
    return [0, 1, 2].map((i) => ({ cx: 0.5, cy: 0.42, rx: 0.32, ry: 0.28, freq: f, phase: p + (i * 2 * Math.PI) / 3 }));
  },
  // Four corners
  (r) => [
    [0.12, 0.12], [0.88, 0.12], [0.12, 0.75], [0.88, 0.75],
  ].map(([cx, cy], i) => ({ cx, cy, rx: 0.03, ry: 0.03, freq: 0.15 + r() * 0.1, phase: i * 1.57 })),
];

export function emitterPosition(p: EmitterPath, t: number): [number, number] {
  const a = 2 * Math.PI * p.freq * t + p.phase;
  return [p.cx + p.rx * Math.cos(a), p.cy + p.ry * Math.sin(a)];
}

function buildSections(a: TrackAnalysis, r: () => number): Section[] {
  let prevLayout = -1;
  return buildBaseSections(a, r).map((s) => {
    let layout = Math.floor(r() * LAYOUTS.length);
    if (layout === prevLayout) layout = (layout + 1) % LAYOUTS.length;
    prevLayout = layout;
    return { ...s, emitters: LAYOUTS[layout](r) };
  });
}

export function buildChart(a: TrackAnalysis, difficulty: Difficulty): Chart {
  const d = DIFFICULTY[difficulty];
  const r = rng(seedFor(a));
  const sections = buildSections(a, r);
  const events: ChartEvent[] = [];

  // Keep dense songs survivable
  let budget = budgetWindow(d.budget);

  // ---- Continuous spiral streams, timed by integrating loudness ----
  const streamEvents: ChartEvent[] = [];
  for (const s of sections) {
    if (s.energy < 0.3) continue;
    const arms = 1 + Math.floor(r() * (difficulty === 'easy' ? 2 : 3));
    const spin = (r() < 0.5 ? -1 : 1) * (0.6 + r() * 1.2);
    const emitter = Math.floor(r() * s.emitters.length);
    let acc = r();
    for (let t = s.start + 0.5; t < s.end - 0.3; t += 0.01) {
      const lvl = sample(a.level, a.fps, t);
      const act = sample(a.activity, a.fps, t);
      const drive = Math.max(0, lvl * (0.8 + 0.35 * act) - 0.35) / 0.65;
      acc += d.streamRate * drive * drive * 0.01;
      if (acc < 1) continue;
      acc -= 1;
      for (let k = 0; k < arms; k++) {
        streamEvents.push({ kind: 'stream', t, emitter, angle: spin * t + (k * 2 * Math.PI) / arms, speed: 18 * d.speed });
      }
    }
  }

  // ---- Hits ----
  let lastLaser = -Infinity;
  let ringPhase = 0;
  let robin = 0;
  let skip = 0;
  let lastPattern = -Infinity;
  for (let i = 0; i < a.onsetTimes.length; i++) {
    const t = a.onsetTimes[i];
    const s = a.onsetStrength[i];
    const low = a.onsetLowness[i];
    if (t < 0.6) continue; // give the player a moment
    const sec = sections[sectionIndexAt(sections, t)];
    const ne = sec.emitters.length;
    const left = budget.left(t);

    if (s >= d.laserMin && t - lastLaser > LASER_COOLDOWN && t > LASER_WARN + 1) {
      lastLaser = t;
      events.push({ kind: 'laser', t, emitter: Math.floor(r() * ne), warn: LASER_WARN, duration: 0.3 });
    }

    if (s < d.pelletMin || t - lastPattern < d.minGap) continue;
    if (s < 0.45) {
      // Thin out weak hits on easier settings
      skip += d.density;
      if (skip < 1 || left < 1) continue;
      skip -= 1;
      events.push({ kind: 'pellet', t, emitter: robin++ % ne, speed: (34 + 10 * s) * d.speed });
      budget.spend(t, 1);
      lastPattern = t;
      continue;
    }

    const big = s >= 0.75;
    if (low > 0.45 || big) {
      let count = Math.round((10 + 16 * s) * d.density * (big ? 1.25 : 1));
      count = Math.min(count, Math.max(6, left));
      if (left < 6) continue;
      ringPhase += Math.PI / count;
      // Big hits fire from several emitters at once; others alternate
      const first = robin++;
      const from = [...Array(big ? Math.min(ne, d.maxEmitters) : 1).keys()].map((k) => (first + k) % ne);
      const per = Math.max(6, Math.round(count / Math.sqrt(from.length)));
      const curve = d.curves && sec.energy > 0.55 && r() < 0.35 ? (r() < 0.5 ? -1 : 1) * 0.5 : 0;
      for (const emitter of from) {
        events.push({
          kind: 'ring', t, emitter, count: per, phase: ringPhase + r() * 0.3,
          speed: (20 + 14 * s) * d.speed, size: big ? 1.15 : 0.9, decel: big ? 14 : 0, curve,
        });
        budget.spend(t, per);
      }
      lastPattern = t;
    } else {
      if (left < 3) continue;
      const count = Math.min(left, 3 + 2 * Math.round(2 * s * d.density));
      events.push({ kind: 'fan', t, emitter: robin++ % ne, count, spread: 0.18 + 0.1 * r(), speed: (30 + 12 * s) * d.speed, size: 0.75 });
      budget.spend(t, count);
      lastPattern = t;
    }
  }

  // Streams yield to hit patterns when the budget is used up
  budget = budgetWindow(d.budget);
  const merged = [...events].sort((x, y) => x.t - y.t);
  const kept: ChartEvent[] = [];
  let hi = 0;
  for (const e of streamEvents) {
    while (hi < merged.length && merged[hi].t <= e.t) {
      const m = merged[hi++];
      budget.spend(m.t, m.kind === 'ring' || m.kind === 'fan' ? m.count : 1);
    }
    if (budget.left(e.t) > 0) { kept.push(e); budget.spend(e.t, 1); }
  }

  return { sections, events: merged.concat(kept).sort((x, y) => x.t - y.t) };
}
