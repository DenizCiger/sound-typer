import type { TrackAnalysis } from '../../audio/analysis';
import { hitWeights, intensityAt, rng, sample, sectionIndexAt, seedFor, songParts, type Difficulty, type HitWeights } from '../common';
import { barStarts, findRests, shapesRuns, shapesSections, type Role, type ShapesRun, type Theme } from '../shapes/chart';
import { SPEED_STAGES } from '../wave/chart';

/** The side a spear comes from and the shield faces: 0 up, 1 right, 2 down, 3 left. */
export type Side = 0 | 1 | 2 | 3;
export type Voice = 'kick' | 'snare' | 'hat';

/** Shield's distance from the centre, world units. */
export const SHIELD_R = 11;
/** Where spears come into view at the slowest and the fastest speed stage: the border's reach. */
const FAR_SLOW = 34;
const FAR_FAST = 56;

export const farFor = (stage: number) => FAR_SLOW + ((FAR_FAST - FAR_SLOW) * stage) / (SPEED_STAGES.length - 1);

export interface Spear {
  /** When it comes into view, on the music's grid where it has one. */
  spawn: number;
  /** How far out it comes into view: the border when it was launched. */
  far: number;
  /** When it reaches the shield, on a hit (or a held note's start). */
  arrive: number;
  /** When it's over: `arrive`, or the end of a held note for a lance. */
  end: number;
  /** Its flight in music time (`localTime`), which stands still while the music rests. */
  flyFrom: number;
  flyTo: number;
  flyEnd: number;
  /** The side to block. */
  side: Side;
  /** The side it comes in from; the opposite of `side` for a reverse spear. */
  from: Side;
  /** Reverse spear: when it jumps over to `side`. */
  flip: number;
  /** A reverse spear flies in tail first and jumps to the far side; a lance lasts as long as its note. */
  kind: 'spear' | 'reverse' | 'lance';
  /** The sound it plays, which sets its shape. */
  voice: Voice;
  heavy: boolean;
}

/** A stretch of the song at one speed. */
export interface SpeedPart { start: number; end: number; stage: number }

export interface ShieldSection { start: number; end: number; role: Role; color: string }

export interface ShieldChart {
  parts: SpeedPart[];
  /** What each part of the song does: a build squeezes the border in, a drop bursts it open. */
  sections: ShieldSection[];
  /** Silences (start, return): spears hang in the air, the return hit lands. */
  rests: [number, number][];
  beats: Float32Array;
  /** Sorted by `arrive` and by `spawn`, never overlapping a lance. */
  spears: Spear[];
  checkpoints: number[];
  maxHp: number;
  /** After a spear's arrival: how long the shield may still turn to block it. */
  late: number;
}

interface Params {
  /** Shortest time between spears. */
  minGap: number;
  /** Shortest time between spears on different sides. */
  turnGap: number;
  /** Prominence a hit needs to count towards a run's rhythm. */
  thresh: number;
  /** The finest notes that get a spear: 4 quarters, 2 eighths, 1 sixteenths. */
  grid: number;
  /** Seconds to fly REF_DIST at 1× speed. */
  lead: number;
  /** Lowest and highest speed stage used. */
  stages: [number, number];
  hp: number;
  late: number;
  reverseChance: number;
  /** Seconds a reverse spear leaves between landing on its real side and arriving. */
  reverseRead: number;
  /** Loudest share of the mids a held note must take to become a lance. */
  lanceStrength: number;
}

const PARAMS: Record<Difficulty, Params> = {
  easy: { minGap: 0.32, turnGap: 0.5, thresh: 0.5, grid: 4, lead: 1.35, stages: [0, 3], hp: 6, late: 0.07, reverseChance: 0, reverseRead: 0.5, lanceStrength: 0.45 },
  normal: { minGap: 0.2, turnGap: 0.3, thresh: 0.42, grid: 2, lead: 1.05, stages: [0, 4], hp: 5, late: 0.055, reverseChance: 0.12, reverseRead: 0.42, lanceStrength: 0.35 },
  hard: { minGap: 0.13, turnGap: 0.2, thresh: 0.32, grid: 1, lead: 0.85, stages: [1, 5], hp: 4, late: 0.04, reverseChance: 0.22, reverseRead: 0.34, lanceStrength: 0.25 },
};

/**
 * How a run's rhythm moves around the shield. Each is a pure function of where a note sits in the
 * bar, so bars that sound alike play alike:
 * - backbeat: kicks on one side, snares on the opposite, moving on every 4 bars
 * - stomp: big notes, a whole bar on one side answered from the opposite by the next
 * - march: one quarter turn per beat
 * - hats: a stream from one side per bar, turning with each bar
 * - sway: a slow back and forth for sustained music, leaving room for lances
 * - rise (builds): a spin that picks up towards the drop
 */
type Dance = 'backbeat' | 'stomp' | 'march' | 'hats' | 'sway' | 'rise';

/** Shapes picks its themes from what a run sounds like; the same character suits these. */
const THEME_DANCE: Record<Theme, Dance> = { field: 'backbeat', bars: 'stomp', walls: 'stomp', steps: 'march', grid: 'march', rain: 'hats', spinner: 'sway' };
const DANCE_VOICES: Record<Dance, Voice[]> = {
  backbeat: ['kick', 'snare'],
  stomp: ['kick', 'snare', 'hat'],
  march: ['kick', 'snare'],
  hats: ['hat', 'snare'],
  sway: ['kick', 'snare', 'hat'],
  rise: ['kick', 'snare', 'hat'],
};

const SLOTS = 16;
/** Nothing arrives before this, so the first spear can be seen coming. */
const START_AT = 0.6;
/** Share of a run's bars with a note on a slot for it to be part of the run's rhythm. */
const SLOT_KEEP = 0.4;
/** Share of the bars with a note on a slot for it to be played in the bars where none was detected. */
const SLOT_FILL = 0.6;
/** Loudness the music needs for that: it hasn't gone quiet here. */
const FILL_LEVEL = 0.2;
/** A note this prominent gets a spear even off the difficulty's grid. */
const SYNCOPATION = 0.85;
/** A note this prominent breaks into the rhythm as an extra heavy spear. */
const ACCENT_PROM = 0.9;
/** How much longer the gaps get as the intensity falls to nothing. */
const GAP_QUIET = 0.9;
/** A hit gives way to a hit this much more prominent right behind it. */
const YIELD = 1.25;
/** Distance the difficulty's `lead` is about, world units. */
const REF_DIST = 37;
const LEAD_HEAVY = 0.6;
const LEAD_MIN = 0.4;
const HEAVY_HEFT = 0.72;
const HEAVY_PROM = 0.85;
/** Seconds between heavy spears, so they stay accents in a song of uniformly strong hits. */
const HEAVY_REST = 1.5;
const LANCE_MIN = 0.6;
const LANCE_MAX = 4;
/** Seconds between lances. */
const LANCE_REST = 3;
/** Seconds a reverse spear takes to jump over. */
const REVERSE_FLIP = 0.1;
/** How long a reverse spear must be in view, tail first, before it jumps. */
const REVERSE_SHOWN = 0.2;
const REVERSE_INTEN = 0.3;
/** A reverse spear jumps on a beat this much before it has to. */
const REVERSE_SNAP = 0.2;
/** How much of its reach the border loses by the end of a build. */
const BUILD_SQUEEZE = 0.3;
const CHECKPOINT_EVERY = 25;
const CHECKPOINT_END = 8;

/** Radians of a side around the centre. */
export const sideAngle = (side: number) => (side * Math.PI) / 2 - Math.PI / 2;

/** Dice that depend only on a run's seed and a position in it, so a repeated passage rolls the same. */
function dice(...keys: number[]) {
  let h = 2166136261;
  for (const k of keys) h = Math.imul(h ^ k, 16777619);
  return rng(h)();
}

/** Song time with the rests taken out: what spears fly by, so they hang while the music is silent. */
export function localTime(rests: [number, number][], t: number) {
  let out = t;
  for (const [start, back] of rests) {
    if (t <= start) break;
    out -= Math.min(t, back) - start;
  }
  return out;
}

/** The song time a music time was reached (the end of a rest, if it was reached before one). */
function songTime(rests: [number, number][], local: number) {
  let t = local;
  for (const [start, back] of rests) {
    if (t < start) break;
    t += back - start;
  }
  return t;
}

export function restAt(rests: [number, number][], t: number) {
  return rests.some(([start, back]) => t >= start && t < back);
}

/** The border's reach at time t: the part's, squeezed in over a build and bursting open on the drop. */
export function borderAt(c: Pick<ShieldChart, 'parts' | 'sections'>, t: number) {
  const far = farFor(c.parts[sectionIndexAt(c.parts, t)].stage);
  const sec = c.sections[sectionIndexAt(c.sections, t)];
  if (sec.role !== 'build') return far;
  return far * (1 - BUILD_SQUEEZE * Math.min(1, Math.max(0, (t - sec.start) / (sec.end - sec.start))));
}

/** Distance from the centre at music time `local` of a point of a spear that lands at `at`. */
export function flightDist(s: Spear, local: number, at = s.flyTo) {
  const f = (at - local) / Math.max(1e-3, s.flyTo - s.flyFrom);
  return SHIELD_R + f * (s.far - SHIELD_R);
}

/** Where a spear is around the centre at time t, and whether it's still flying tail first. */
export function spearPose(s: Spear, t: number) {
  if (s.kind !== 'reverse' || t >= s.flip + REVERSE_FLIP) return { angle: sideAngle(s.side), backwards: false };
  if (t < s.flip) return { angle: sideAngle(s.from), backwards: true };
  return { angle: sideAngle(s.from) + (Math.PI * (t - s.flip)) / REVERSE_FLIP, backwards: false };
}

function lowerTime(arr: Float32Array, t: number) {
  let a = 0, b = arr.length;
  while (a < b) { const m = (a + b) >> 1; if (arr[m] < t) a = m + 1; else b = m; }
  return a;
}

/**
 * The song's parts with a speed each, as in Wave: on a song-relative scale, so its calmest part is
 * the slowest and its most intense the fastest (with a minimum range, so a song that barely changes
 * doesn't swing wildly). Neighbours at the same speed are one part.
 */
function speedParts(a: TrackAnalysis, p: Params): SpeedPart[] {
  const parts = songParts(a);
  const sorted = parts.map((q) => q.inten).sort((x, y) => x - y);
  const low = sorted[0], range = Math.max(0.35, sorted[sorted.length - 1] - low);
  const [lo, hi] = p.stages;
  const merged: SpeedPart[] = [];
  for (const part of parts) {
    const stage = Math.round(lo + Math.min(1, (part.inten - low) / range) * (hi - lo));
    const prev = merged[merged.length - 1];
    if (prev?.stage === stage) prev.end = part.end;
    else merged.push({ start: part.start, end: part.end, stage });
  }
  return merged;
}

const voiceOf = (a: TrackAnalysis, i: number): Voice => (a.onsetLowness[i] > 0.5 ? 'kick' : a.onsetBrightness[i] > 0.45 ? 'hat' : 'snare');

/** A note to block; `side` -1 means it turns to the far side from the note before it. */
interface Note { t: number; end: number; side: number; voice: Voice; prom: number; inten: number; heavyOk: boolean; forced: boolean; lance: boolean }

/** The slot of the bar a time falls on: which bar, and which of its SLOTS sixteenths. */
function slotAt(bars: number[], t: number) {
  let lo = 0, hi = bars.length - 2;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (bars[m] <= t) lo = m; else hi = m - 1; }
  const slot = Math.round(((t - bars[lo]) / Math.max(1e-3, bars[lo + 1] - bars[lo])) * SLOTS);
  return slot >= SLOTS ? { bar: lo + 1, slot: 0 } : { bar: lo, slot };
}

function danceSide(dance: Dance, a: number, dir: number, bar: number, slot: number, voice: Voice, twoVoices: boolean) {
  const beat = slot >> 2;
  const moved = a + dir * (bar >> 2);
  switch (dance) {
    case 'backbeat': return (twoVoices ? moved + (voice === 'snare' ? 2 : voice === 'hat' ? dir : 0) : moved + 2 * (beat & 1)) & 3;
    case 'stomp': return (moved + 2 * (bar & 1)) & 3;
    case 'march': return (a + dir * (bar * 4 + beat)) & 3;
    case 'hats': return (a + dir * bar) & 3;
    case 'sway': return (a + 2 * (bar & 1)) & 3;
    case 'rise': return (a + dir * (bar * SLOTS + slot)) & 3;
  }
}

/** What the bars of a group of runs have in common, slot by slot. */
interface SlotStats {
  /** Bars with a real note on each slot. */
  seen: Set<number>[];
  promSum: Float32Array;
  voices: { kick: number; snare: number; hat: number }[];
  nBars: number;
  barLen: number;
  inten: number;
}

/** Runs that sound alike share a seed, and all of their bars vote on one rhythm. */
function slotStats(a: TrackAnalysis, w: HitWeights, p: Params, bars: number[], runs: ShapesRun[]): SlotStats {
  const seen = Array.from({ length: SLOTS }, () => new Set<number>());
  const promSum = new Float32Array(SLOTS);
  const voices = Array.from({ length: SLOTS }, () => ({ kick: 0, snare: 0, hat: 0 }));
  const allBars = new Set<number>();
  let inten = 0, n = 0, time = 0;
  for (const run of runs) {
    time += run.end - run.start;
    for (let i = lowerTime(a.onsetTimes, run.start); i < a.onsetTimes.length && a.onsetTimes[i] < run.end; i++) {
      const { bar, slot } = slotAt(bars, a.onsetTimes[i]);
      allBars.add(bar);
      inten += w.inten[i];
      n++;
      if (w.prom[i] < p.thresh) continue;
      seen[slot].add(bar);
      promSum[slot] += w.prom[i];
      voices[slot][voiceOf(a, i)] += w.prom[i];
    }
  }
  const nBars = Math.max(1, allBars.size);
  return { seen, promSum, voices, nBars, barLen: time / nBars, inten: n ? inten / n : 0 };
}

/**
 * The notes of one run: the rhythm its seed's bars share on the sixteenth grid, keeping what recurs
 * (so a detection that flickers from bar to bar doesn't scramble it), each kept slot with the voice
 * it mostly has, played in every bar. A note that recurs enough is played even where the detector
 * missed it, as long as the music is going.
 */
function runNotes(a: TrackAnalysis, w: HitWeights, p: Params, bars: number[], run: ShapesRun, role: Role, st: SlotStats): Note[] {
  const dance: Dance = role === 'build' ? 'rise' : THEME_DANCE[run.theme];
  const first = sectionIndexAtTimes(bars, run.start);
  const hits: { i: number; bar: number; slot: number }[] = [];
  for (let i = lowerTime(a.onsetTimes, run.start); i < a.onsetTimes.length && a.onsetTimes[i] < run.end; i++) {
    hits.push({ i, ...slotAt(bars, a.onsetTimes[i]) });
  }
  if (hits.length === 0) return [];

  const presence = (s: number) => st.seen[s].size / st.nBars;
  const slotVoice = (s: number): Voice => {
    const v = st.voices[s];
    return v.kick >= v.snare && v.kick >= v.hat ? 'kick' : v.snare >= v.hat ? 'snare' : 'hat';
  };

  // Calm parts and the big dances play the coarser notes
  const calm = role === 'calm' || role === 'break';
  const grid = dance === 'sway' ? 8 : dance === 'stomp' || calm ? Math.max(4, p.grid * 2) : p.grid;
  const mean = (s: number) => (st.seen[s].size ? st.promSum[s] / st.seen[s].size : 0);
  const score = (s: number) => mean(s) * presence(s) + (s % 4 === 0 ? 0.3 : 0) + (s === 0 ? 0.2 : 0);
  const gapSlots = Math.ceil((p.minGap * (1 + GAP_QUIET * (1 - st.inten))) / Math.max(1e-3, st.barLen / SLOTS));
  const prune = (slots: number[]) => {
    const kept: number[] = [];
    for (const s of [...slots].sort((x, y) => score(y) - score(x))) {
      if (kept.every((k) => { const d = Math.abs(k - s); return Math.min(d, SLOTS - d) >= gapSlots; })) kept.push(s);
    }
    return kept;
  };
  const all = Array.from({ length: SLOTS }, (_, s) => s).filter((s) => st.seen[s].size > 0);
  let kept = prune(all.filter((s) => presence(s) >= SLOT_KEEP
    && DANCE_VOICES[dance].includes(slotVoice(s))
    && (s % grid === 0 || mean(s) >= SYNCOPATION)));
  // A run whose hits don't fit the dance still gets its most recurring notes
  if (kept.length === 0) kept = prune(all).slice(0, 2);
  const twoVoices = new Set(kept.map(slotVoice)).size >= 2;

  const base = Math.floor(dice(run.seed, 1) * 4), turn = dice(run.seed, 2) < 0.5 ? 1 : 3;
  const noteAt = (t: number, bar: number, slot: number, voice: Voice, prom: number, inten: number, heavyOk: boolean): Note => ({
    t, end: t, voice, prom, inten, heavyOk, forced: false, lance: false,
    side: danceSide(dance, base, turn, bar - first, slot, voice, twoVoices),
  });

  const best = new Map<string, { i: number; bar: number; slot: number }>();
  for (const h of hits) {
    if (!kept.includes(h.slot)) continue;
    const key = `${h.bar}:${h.slot}`;
    const b = best.get(key);
    if (!b || w.prom[h.i] > w.prom[b.i]) best.set(key, h);
  }
  const notes: Note[] = [];
  for (const h of best.values()) {
    notes.push(noteAt(a.onsetTimes[h.i], h.bar, h.slot, slotVoice(h.slot), w.prom[h.i], w.inten[h.i], h.slot % 4 === 0 && w.heft[h.i] >= HEAVY_HEFT && w.prom[h.i] >= HEAVY_PROM));
  }
  // The detector missed it in this bar, but the rhythm has it and the music is going
  for (let bar = first; bar + 1 < bars.length && bars[bar] < run.end; bar++) {
    for (const slot of kept) {
      const t = bars[bar] + ((bars[bar + 1] - bars[bar]) * slot) / SLOTS;
      if (t < run.start || t >= run.end || presence(slot) < SLOT_FILL || best.has(`${bar}:${slot}`) || sample(a.level, a.fps, t) < FILL_LEVEL) continue;
      notes.push(noteAt(t, bar, slot, slotVoice(slot), mean(slot) * 0.7, intensityAt(a, t), false));
    }
  }
  // Standouts outside the rhythm break into it
  for (const h of hits) {
    if (kept.includes(h.slot) || w.prom[h.i] < ACCENT_PROM || w.heft[h.i] < HEAVY_HEFT) continue;
    notes.push(noteAt(a.onsetTimes[h.i], h.bar, h.slot, voiceOf(a, h.i), w.prom[h.i], w.inten[h.i], true));
  }
  return notes;
}

function sectionIndexAtTimes(times: number[], t: number) {
  let lo = 0, hi = times.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (times[m] <= t) lo = m; else hi = m - 1; }
  return lo;
}

/** Held notes loud enough to block all the way through, spaced apart, stopping where the music does. */
function pickLances(a: TrackAnalysis, p: Params, rests: [number, number][]) {
  const lances: Note[] = [];
  let free = START_AT;
  for (let i = 0; i < a.noteStart.length; i++) {
    const t = a.noteStart[i];
    let end = Math.min(a.noteEnd[i], t + LANCE_MAX);
    for (const [start] of rests) if (start > t && start < end) end = start;
    if (a.noteStrength[i] < p.lanceStrength || end - t < LANCE_MIN || t < free || restAt(rests, t)) continue;
    lances.push({ t, end, side: -1, voice: 'snare', prom: 1, inten: 0.5, heavyOk: false, forced: false, lance: true });
    free = end + LANCE_REST;
  }
  return lances;
}

/** The hit at a moment the music makes a point of, if there is one. */
function hitNear(a: TrackAnalysis, t: number) {
  const i = lowerTime(a.onsetTimes, t - 0.02);
  return i < a.onsetTimes.length && a.onsetTimes[i] <= t + 0.02 ? i : -1;
}

/**
 * Shield style: fixed in the centre, turn the shield to block spears that land on the music's notes.
 * The song is cut like Shapes (parts with roles, runs of bars that sound alike, repeats sharing a
 * seed); each run plays its rhythm as a dance around the shield, so the same music blocks the same.
 */
export function buildShieldChart(a: TrackAnalysis, difficulty: Difficulty): ShieldChart {
  const p = PARAMS[difficulty];
  const w = hitWeights(a);
  const shapes = shapesSections(a);
  const sections: ShieldSection[] = shapes.map((s) => ({ start: s.start, end: s.end, role: s.role, color: s.color }));
  const rests = findRests(a);
  const bars = barStarts(a);
  const runs = shapesRuns(a, w, { bigAt: 0.75 }, shapes, rng(seedFor(a)));
  const parts = speedParts(a, p);
  const chartInfo = { parts, sections };

  const groups = new Map<number, ShapesRun[]>();
  for (const run of runs) groups.set(run.seed, [...(groups.get(run.seed) ?? []), run]);
  const stats = new Map([...groups].map(([seed, group]) => [seed, slotStats(a, w, p, bars, group)]));
  const notes = runs.flatMap((run) => runNotes(a, w, p, bars, run, sections[sectionIndexAt(sections, run.start)].role, stats.get(run.seed)!))
    .filter((n) => n.t >= START_AT && !restAt(rests, n.t));
  // The moments the music makes a point of always land, heavy: a drop's first hit and a rest's return
  const points = [...sections.filter((s) => s.role === 'drop').map((s) => s.start), ...rests.map((q) => q[1])];
  for (const t of points) {
    const i = hitNear(a, t);
    if (i >= 0) notes.push({ t: a.onsetTimes[i], end: a.onsetTimes[i], side: -1, voice: voiceOf(a, i), prom: 1, inten: w.inten[i], heavyOk: true, forced: true, lance: false });
  }
  const lances = pickLances(a, p, rests);
  const clear = notes.filter((n) => n.forced || !lances.some((l) => n.t > l.t - p.turnGap && n.t < l.end + p.turnGap));
  const usable = lances.filter((l) => !clear.some((n) => n.forced && n.t > l.t - p.turnGap && n.t < l.end + p.turnGap));
  const sorted = [...clear, ...usable].sort((x, y) => x.t - y.t);

  // No two closer than the gap: the lesser gives way
  const events: Note[] = [];
  for (const n of sorted) {
    const prev = events[events.length - 1];
    if (prev && n.t - prev.end < p.minGap) {
      if (!prev.forced && !prev.lance && (n.forced || n.prom > prev.prom * YIELD)) events[events.length - 1] = n;
      continue;
    }
    events.push(n);
  }

  const halfBeat = a.tempo > 0 ? 30 / a.tempo : 0;
  const leadFor = (t: number, heavy: boolean) => {
    const far = borderAt(chartInfo, t);
    const speed = (REF_DIST / p.lead) * SPEED_STAGES[parts[sectionIndexAt(parts, t)].stage];
    const flight = ((far - SHIELD_R) / speed) * (heavy ? LEAD_HEAVY : 1);
    // A whole number of half beats, so spears that land on the grid are launched on it too
    const steps = halfBeat > 0 ? Math.max(1, Math.round(flight / halfBeat)) : 0;
    return Math.max(LEAD_MIN, steps ? steps * halfBeat : flight);
  };

  const spears: Spear[] = [];
  let prevEnd = -Infinity, prevSide = 0, prevFly = 0, lastHeavy = -Infinity;
  for (const e of events) {
    const free = e.t - prevEnd >= p.turnGap;
    let side = e.side >= 0 ? e.side : (prevSide + 2) & 3;
    if (!free) side = prevSide;
    const heavy = e.heavyOk && !e.lance && (e.forced || e.t - lastHeavy >= HEAVY_REST);
    if (heavy) lastHeavy = e.t;

    // Launched at the speed of the moment it's launched: a change of speed never moves a landing.
    // Spears keep coming into view in the order they land, so none overtakes another
    const flyTo = localTime(rests, e.t);
    const guess = songTime(rests, Math.max(0, flyTo - leadFor(e.t, heavy)));
    const lead = Math.min(leadFor(guess, heavy), flyTo - prevFly);
    const flyFrom = flyTo - lead;
    const spawn = songTime(rests, flyFrom);
    const far = borderAt(chartInfo, spawn);

    let kind: Spear['kind'] = e.lance ? 'lance' : 'spear';
    let from = side, flip = 0;
    const flipBy = e.t - p.reverseRead - REVERSE_FLIP;
    const calmFlight = localTime(rests, e.t) - localTime(rests, spawn) === e.t - spawn;
    if (!e.lance && !heavy && free && calmFlight && e.inten >= REVERSE_INTEN && flipBy >= spawn + REVERSE_SHOWN
      && dice(Math.round(e.t * 100), 7) < p.reverseChance) {
      kind = 'reverse';
      from = (side + 2) & 3;
      // The jump is part of the rhythm where it can be
      const beat = a.beatTimes[lowerTime(a.beatTimes, flipBy + 1e-3) - 1];
      flip = beat !== undefined && beat >= spawn + REVERSE_SHOWN && flipBy - beat <= REVERSE_SNAP ? beat : flipBy;
    }
    spears.push({
      spawn, far, arrive: e.t, end: e.end, flyFrom, flyTo, flyEnd: localTime(rests, e.end),
      side: side as Side, from: from as Side, flip, kind, voice: e.voice, heavy,
    });
    prevEnd = e.end;
    prevSide = side;
    prevFly = flyFrom;
  }

  const checkpoints = [0];
  for (const b of bars) {
    if (b - checkpoints[checkpoints.length - 1] >= CHECKPOINT_EVERY && a.duration - b > CHECKPOINT_END) checkpoints.push(b);
  }
  return { parts, sections, rests, beats: a.beatTimes, spears, checkpoints, maxHp: p.hp, late: p.late };
}
