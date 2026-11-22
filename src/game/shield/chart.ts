import type { TrackAnalysis } from '../../audio/analysis';
import { hitWeights, intensityAt, rng, sample, sectionIndexAt, seedFor, songParts, ZOOM_RATE, type Difficulty, type HitWeights } from '../common';
import { barStarts, findRests, raveCurve, shapesRuns, shapesSections, type Role, type ShapesRun, type Theme } from '../shapes/chart';
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
  /** Sorted by `arrive`, never overlapping a lance. Spears on one lane come into view in the order they land. */
  spears: Spear[];
  /** Indices into `spears` in the order they come into view (a heavy flies faster than its neighbours). */
  launches: number[];
  /** Longest time from a spear coming into view to its arrival: what's in view is within this of now. */
  maxLead: number;
  checkpoints: number[];
  maxHp: number;
  /** After a spear's arrival: how long the shield may still turn to block it. */
  late: number;
}

interface Params {
  /** Shortest time between spears on one side. */
  minGap: number;
  /** Shortest time between spears on different sides. */
  turnGap: number;
  /** Prominence a hit needs to count towards a run's rhythm. */
  thresh: number;
  /**
   * The finest notes that get a spear, as the shortest step of the grid in seconds: whatever the
   * tempo reads as (a fast song is often read at half its tempo), its sixteenths, eighths or
   * quarters, whichever is first at least this long.
   */
  gridTime: number;
  /** Spears a second the rhythm aims for, from calm music to music that raves. */
  rate: [number, number];
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
  easy: { minGap: 0.28, turnGap: 0.4, thresh: 0.5, gridTime: 0.33, rate: [0.8, 2.2], lead: 1.3, stages: [0, 3], hp: 6, late: 0.07, reverseChance: 0, reverseRead: 0.5, lanceStrength: 0.5 },
  normal: { minGap: 0.17, turnGap: 0.25, thresh: 0.4, gridTime: 0.17, rate: [1.2, 3.6], lead: 1, stages: [0, 4], hp: 5, late: 0.055, reverseChance: 0.12, reverseRead: 0.42, lanceStrength: 0.42 },
  hard: { minGap: 0.11, turnGap: 0.16, thresh: 0.3, gridTime: 0.09, rate: [1.8, 5.4], lead: 0.82, stages: [1, 5], hp: 4, late: 0.045, reverseChance: 0.22, reverseRead: 0.34, lanceStrength: 0.36 },
};

/**
 * How a run's notes move around the shield. Each is a pure function of where a note sits in its
 * run (bar and sixteenth), so bars that sound alike play alike, and the pattern moves round every
 * 4 bars. The side changes once per turn unit (a sixteenth, an eighth, a beat, ...: the shortest
 * the difficulty can turn in, longer when the music is calm), so notes within a unit come from
 * one side.
 * - kit: what you hear is where it comes from: kicks from one side, snares from the opposite,
 *   hats follow (or take the sides between when there's only one of kick and snare)
 * - pingpong: back and forth between opposite sides
 * - zigzag: out to the side and back, then to the other side and back
 * - roll: round the shield, then back the other way
 * - stomp: a beat at a time, opposite, then across
 * - sway: half a bar on each of two opposite sides, for sustained music
 * - rise (builds): round and round, the turns getting faster towards the drop
 */
type Dance = 'kit' | 'pingpong' | 'zigzag' | 'roll' | 'stomp' | 'sway' | 'rise';

/**
 * Shapes picks its themes from what a run sounds like; the same character suits these dances (the
 * first is likelier). When it doesn't fit, the other one does, else the first fallback that fits.
 * A run doesn't stomp or sway right after one that did (unless it repeats an earlier passage, which
 * dances like that one did), so a song that's one long drop doesn't hold its sides for minutes.
 */
const THEME_DANCES: Record<Theme, [Dance, Dance]> = {
  field: ['kit', 'zigzag'],
  bars: ['stomp', 'kit'],
  walls: ['kit', 'stomp'],
  steps: ['roll', 'zigzag'],
  grid: ['zigzag', 'pingpong'],
  rain: ['pingpong', 'roll'],
  spinner: ['sway', 'pingpong'],
};
const FIRST_DANCE = 0.65;
const FALLBACK_DANCES: Dance[] = ['zigzag', 'pingpong', 'roll'];
/** Sway holds a side for half a bar: only where the music raves less than this. */
const SWAY_DRIVE = 0.35;
const ZIGZAG = [0, 1, 0, -1];
const STOMP = [0, 2, 1, 3];
/**
 * Shortest turn unit of stomp (a beat) and sway (half a bar) in seconds, so a fast song read at
 * half its tempo doesn't stay on one side twice as long. Calm parts turn no faster than CALM_TURN.
 */
const DANCE_TIME: Partial<Record<Dance, number>> = { stomp: 0.3, sway: 0.65 };
const CALM_TURN = 0.3;
/** Turn units, in sixteenths. */
const UNITS = [1, 2, 4, 8, 16];
/** How much longer the turn unit gets as the music calms down to nothing. */
const TURN_CALM = 0.8;
/** Over a build: the turn unit starts this many times longer and shortens towards the drop. */
const RISE_SLOW = 3;
/** A kit hat on this side follows the note before it. */
const FOLLOW = -2;

const SLOTS = 16;
/** Nothing arrives before this, so the first spear can be seen coming. */
const START_AT = 0.6;
/** Share of a run's bars with a note on a slot for it to be part of the run's rhythm. */
const SLOT_KEEP = 0.3;
/** Share of the bars with a note on a slot for it to be played in the bars where none was detected. */
const SLOT_FILL = 0.55;
/** Loudness the music needs for that: it hasn't gone quiet here. */
const FILL_LEVEL = 0.2;
/** A note this prominent gets a spear even off the difficulty's grid. */
const SYNCOPATION = 0.85;
/** A note this prominent and heavy breaks into the rhythm whatever the density. */
const ACCENT_PROM = 0.9;
const ACCENT_HEFT = 0.4;
/** Where the music raves, a bar's extra notes may be this much less prominent (share of the threshold). */
const RAVE_PROM = 0.35;
/**
 * Notes in a row from one side before one turns: at most STREAK_NOTES, or as many as come in
 * STREAK_BARS bars. A dance can't always turn (a run of nothing but kicks plays kit on one side).
 */
const STREAK_NOTES = 5;
const STREAK_BARS = 1;
/** A hit gives way to a hit this much more prominent right behind it. */
const YIELD = 1.25;
/** Distance the difficulty's `lead` is about, world units. */
const REF_DIST = 37;
const LEAD_HEAVY = 0.6;
const LEAD_MIN = 0.4;
/**
 * Heavy spears land on what the music hits hardest: the heaviest hit around (within a bar, half
 * a bar where the music raves) that is clearly heavier than the notes around it, or a phrase's
 * downbeat (a bar's, where the music raves) that lands hard.
 */
const HEAVY_HEFT = 0.58;
const HEAVY_PROM = 0.8;
const HEAVY_LIFT = 1.3;
const HEAVY_DOWN = 0.68;
const HEAVY_RAVE = 0.55;
/** ...but at least this many seconds, so a fast song's heavies stay as rare as a slower one's. */
const HEAVY_WIN = 1;
/** Held notes: a lance has to land on a hit this close to the note's start. */
const LANCE_SNAP = 0.06;
const LANCE_MIN = 0.6;
/** At most this many bars long, ending on a bar line if the note goes on. */
const LANCE_BARS = 2;
/** Bars between lances. */
const LANCE_REST_BARS = 4;
/** No lances where the music raves: it would stop the action. */
const LANCE_DRIVE = 0.55;
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

/**
 * A note to block. `side` is FOLLOW for a kit hat (the side of the note before it). `heft` is 0
 * for a note the rhythm fills in where nothing was detected. `down`: on a bar's downbeat, `phrase`:
 * on a 4-bar phrase's.
 */
interface Note {
  t: number; end: number; side: number; voice: Voice; prom: number; heft: number;
  down: boolean; phrase: boolean; heavy: boolean; forced: boolean; lance: boolean;
}

/** Index of the bar a time falls in. */
function barAt(bars: number[], t: number) {
  let lo = 0, hi = bars.length - 2;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (bars[m] <= t) lo = m; else hi = m - 1; }
  return lo;
}

/** The slot of the bar a time falls on: which bar, and which of its SLOTS sixteenths. */
function slotAt(bars: number[], t: number) {
  const lo = barAt(bars, t);
  const slot = Math.round(((t - bars[lo]) / Math.max(1e-3, bars[lo + 1] - bars[lo])) * SLOTS);
  return slot >= SLOTS ? { bar: lo + 1, slot: 0 } : { bar: lo, slot };
}

/** A run's dance: the pattern, where it starts and which way it turns, and its turn unit. */
interface RunDance {
  dance: Dance;
  base: number;
  dir: number;
  /** Turn units since the run's start, for a note at a bar of the run and a slot of that bar. */
  unitIndex: (bar: number, slot: number) => number;
  /** Kit hats take the sides between instead of following (only one of kick and snare plays). */
  hatsMove: boolean;
}

function danceSide(d: RunDance, bar: number, slot: number, voice: Voice) {
  const k = d.unitIndex(bar, slot);
  const a = d.base + d.dir * (bar >> 2);
  switch (d.dance) {
    case 'kit':
      if (voice === 'kick') return a & 3;
      if (voice === 'snare') return (a + 2) & 3;
      return d.hatsMove ? (a + d.dir + 2 * (k & 1)) & 3 : FOLLOW;
    case 'pingpong':
    case 'sway': return (a + 2 * (k & 1)) & 3;
    case 'zigzag': return (a + d.dir * ZIGZAG[k & 3]) & 3;
    case 'stomp': return (a + d.dir * STOMP[k & 3]) & 3;
    case 'roll': { const m = k & 7; return (d.base + d.dir * (m < 4 ? m : 8 - m)) & 3; }
    case 'rise': return (d.base + d.dir * k) & 3;
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
}

/** Runs that sound alike share a seed, and all of their bars vote on one rhythm. */
function slotStats(a: TrackAnalysis, w: HitWeights, p: Params, bars: number[], runs: ShapesRun[]): SlotStats {
  const seen = Array.from({ length: SLOTS }, () => new Set<number>());
  const promSum = new Float32Array(SLOTS);
  const voices = Array.from({ length: SLOTS }, () => ({ kick: 0, snare: 0, hat: 0 }));
  let time = 0, nBars = 0;
  for (const run of runs) {
    time += run.end - run.start;
    nBars += barAt(bars, run.end - 1e-3) - barAt(bars, run.start) + 1;
    const half = (bars[barAt(bars, run.start) + 1] - bars[barAt(bars, run.start)]) / SLOTS / 2;
    for (let i = lowerTime(a.onsetTimes, run.start - half); i < a.onsetTimes.length && a.onsetTimes[i] < run.end - half; i++) {
      const { bar, slot } = slotAt(bars, a.onsetTimes[i]);
      if (w.prom[i] < p.thresh) continue;
      seen[slot].add(bar);
      promSum[slot] += w.prom[i];
      voices[slot][voiceOf(a, i)] += w.prom[i];
    }
  }
  nBars = Math.max(1, nBars);
  return { seen, promSum, voices, nBars, barLen: time / nBars };
}

interface RunInfo {
  run: ShapesRun;
  sec: { start: number; end: number; role: Role };
  stats: SlotStats;
  /** How hard the music raves, 0..1, at a time. */
  drive: (t: number) => number;
  /** Picks the run's dance from the voices its rhythm has and how hard it raves. */
  choose: (voices: Set<Voice>, drive: number) => Dance;
}

/**
 * The notes of one run. Its rhythm is what its seed's bars share on the sixteenth grid: the slots
 * that recur, best first, as many as the music's drive asks for (so a passage that raves plays
 * more of what it has), each with the voice it mostly has, played in every bar (filled in where
 * the detector missed one, as long as the music is going). Each bar then takes its standout hits
 * on top, up to its own drive's count, and the hardest hits always get in.
 */
function runNotes(a: TrackAnalysis, w: HitWeights, p: Params, bars: number[], { run, sec, stats: st, drive, choose }: RunInfo): Note[] {
  const first = barAt(bars, run.start);
  const slotDur = (bars[first + 1] - bars[first]) / SLOTS;
  // A hit belongs to the run of the slot it's on: one just before the bar line a run starts on is its downbeat
  const from = run.start - slotDur / 2, to = run.end - slotDur / 2;
  const hits: { i: number; bar: number; slot: number }[] = [];
  for (let i = lowerTime(a.onsetTimes, from); i < a.onsetTimes.length && a.onsetTimes[i] < to; i++) {
    hits.push({ i, ...slotAt(bars, a.onsetTimes[i]) });
  }
  if (hits.length === 0) return [];

  const calm = sec.role === 'calm' || sec.role === 'break';
  const build = sec.role === 'build';
  const presence = (s: number) => st.seen[s].size / st.nBars;
  const mean = (s: number) => (st.seen[s].size ? st.promSum[s] / st.seen[s].size : 0);
  const slotVoice = (s: number): Voice => {
    const v = st.voices[s];
    return v.kick >= v.snare && v.kick >= v.hat ? 'kick' : v.snare >= v.hat ? 'snare' : 'hat';
  };
  // A build fills up towards its drop, whatever it sounds like
  const progress = (t: number) => Math.min(1, Math.max(0, (t - sec.start) / Math.max(1e-3, sec.end - sec.start)));
  const driveAt = (t: number) => (build ? 0.2 + 0.8 * progress(t) : drive(t));
  let runDrive = 0, k = 0;
  for (let t = run.start; t < run.end; t += 0.1) { runDrive += driveAt(t); k++; }
  runDrive /= Math.max(1, k);
  const perBar = (d: number) => (p.rate[0] + (p.rate[1] - p.rate[0]) * d) * st.barLen;

  const grid = [1, 2, 4, 8].find((g) => g * slotDur >= (calm ? 2 : 1) * p.gridTime - 1e-6) ?? 8;
  const onGrid = (s: number, prom: number) => s % grid === 0 || prom >= SYNCOPATION;
  const gapSlots = Math.max(1, Math.ceil(p.minGap / slotDur - 1e-3));
  const score = (s: number) => mean(s) * presence(s) + (s % 4 === 0 ? 0.25 : s % 2 === 0 ? 0.08 : 0) + (s === 0 ? 0.15 : 0);
  const want = Math.max(1, Math.round(perBar(runDrive)));
  const kept: number[] = [];
  const cands = Array.from({ length: SLOTS }, (_, s) => s).filter((s) => presence(s) >= SLOT_KEEP && onGrid(s, mean(s)));
  for (const s of cands.sort((x, y) => score(y) - score(x))) {
    if (kept.length >= want) break;
    if (kept.every((q) => { const d = Math.abs(q - s); return Math.min(d, SLOTS - d) >= gapSlots; })) kept.push(s);
  }

  // The dance and how often it turns
  const voices = new Set(kept.map(slotVoice));
  const dance: Dance = build ? 'rise' : choose(voices, runDrive);
  const floor = Math.max(DANCE_TIME[dance] ?? 0, calm ? CALM_TURN : 0);
  const unitFor = (need: number) => UNITS.find((u) => u * slotDur >= Math.max(floor, need) - 1e-6) ?? 16;
  const unit = unitFor(p.turnGap * (1 + TURN_CALM * (1 - runDrive)));
  let unitIndex = (bar: number, slot: number) => Math.floor((bar * SLOTS + slot) / unit);
  if (dance === 'rise') {
    // Units counted bar by bar, each bar's as long as the build's progress allows
    const starts = [0];
    for (let b = first; b + 1 < bars.length && bars[b] < run.end; b++) {
      const u = unitFor(p.turnGap * (1 + RISE_SLOW * (1 - progress(bars[b]))));
      starts.push(starts[starts.length - 1] + SLOTS / u);
    }
    unitIndex = (bar, slot) => {
      const b = Math.min(starts.length - 2, Math.max(0, bar));
      const u = SLOTS / (starts[b + 1] - starts[b]);
      return starts[b] + Math.floor(slot / u);
    };
  }
  const d: RunDance = {
    dance, unitIndex,
    base: Math.floor(dice(run.seed, 1) * 4),
    dir: dice(run.seed, 2) < 0.5 ? 1 : -1,
    hatsMove: !(voices.has('kick') && voices.has('snare')),
  };

  const noteAt = (t: number, bar: number, slot: number, voice: Voice, prom: number, heft: number): Note => ({
    t, end: t, voice, prom, heft, heavy: false, forced: false, lance: false,
    down: slot === 0, phrase: slot === 0 && (bar - first) % 4 === 0,
    side: danceSide(d, bar - first, slot, voice),
  });

  const notes: Note[] = [];
  for (let bar = first; bar + 1 < bars.length && bars[bar] < to; bar++) {
    const inBar = hits.filter((h) => h.bar === bar);
    const mine: Note[] = [];
    const fits = (t: number) => mine.every((n) => Math.abs(n.t - t) >= p.minGap);
    // The rhythm: the best hit on each kept slot, or a filled-in note where the music has it
    for (const slot of kept) {
      const t = bars[bar] + ((bars[bar + 1] - bars[bar]) * slot) / SLOTS;
      if (t < from || t >= to) continue;
      let best = -1;
      for (const h of inBar) if (h.slot === slot && w.prom[h.i] >= p.thresh * 0.75 && (best < 0 || w.prom[h.i] > w.prom[best])) best = h.i;
      if (best >= 0) mine.push(noteAt(a.onsetTimes[best], bar, slot, slotVoice(slot), w.prom[best], w.heft[best]));
      else if (presence(slot) >= SLOT_FILL && sample(a.level, a.fps, t) >= FILL_LEVEL) mine.push(noteAt(t, bar, slot, slotVoice(slot), mean(slot) * 0.7, 0));
    }
    // Standout hits on top, as many as this bar's drive asks for; the hardest always get in
    const barDrive = driveAt((bars[bar] + bars[bar + 1]) / 2);
    const room = Math.round(perBar(barDrive));
    const lesser = p.thresh * (1 - RAVE_PROM * barDrive);
    const extra = inBar.filter((h) => !kept.includes(h.slot) && w.prom[h.i] >= lesser && onGrid(h.slot, w.prom[h.i]))
      .sort((x, y) => w.prom[y.i] - w.prom[x.i]);
    for (const h of extra) {
      const t = a.onsetTimes[h.i];
      const accent = w.prom[h.i] >= ACCENT_PROM && w.heft[h.i] >= ACCENT_HEFT;
      if ((mine.length < room || accent) && fits(t)) mine.push(noteAt(t, bar, h.slot, voiceOf(a, h.i), w.prom[h.i], w.heft[h.i]));
    }
    notes.push(...mine);
  }
  return notes;
}

/**
 * Marks the notes the music hits hardest as heavy: the heaviest note around that stands clearly
 * above the notes near it, or a downbeat that lands hard (a phrase's; a bar's where it raves).
 * No cooldown: a passage of evenly hard hits only gets its phrase downbeats.
 */
function markHeavies(notes: Note[], barLen: number, drive: (t: number) => number) {
  let lo = 0, hi = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    while (notes[lo].t < n.t - barLen) lo++;
    while (hi < notes.length && notes[hi].t <= n.t + barLen) hi++;
    if (n.lance || n.heft < HEAVY_HEFT || n.prom < HEAVY_PROM) continue;
    const rave = drive(n.t) >= HEAVY_RAVE;
    const win = Math.max(HEAVY_WIN, rave ? barLen / 2 : barLen);
    let top = true;
    const near: number[] = [];
    for (let j = lo; j < hi; j++) {
      if (j === i || notes[j].lance) continue;
      const m = notes[j];
      if (Math.abs(m.t - n.t) <= win && (m.heft > n.heft || (m.heft === n.heft && j < i))) top = false;
      if (m.heft > 0) near.push(m.heft);
    }
    if (!top) continue;
    near.sort((x, y) => x - y);
    const median = near.length ? near[near.length >> 1] : 0;
    n.heavy = n.heft >= median * HEAVY_LIFT || ((n.phrase || (rave && n.down)) && n.heft >= HEAVY_DOWN);
  }
}

/**
 * Held notes loud enough to block all the way through: only ones that start on a hit (so the
 * lance lands on something you hear), where the music doesn't rave (it stops everything else),
 * at most LANCE_BARS bars, LANCE_REST_BARS bars apart, stopping where the music does.
 */
function pickLances(a: TrackAnalysis, w: HitWeights, p: Params, rests: [number, number][], sections: ShieldSection[], bars: number[], barLen: number, drive: (t: number) => number) {
  const lances: Note[] = [];
  const beat = barLen / 4;
  let free = START_AT;
  for (let i = 0; i < a.noteStart.length; i++) {
    if (a.noteStrength[i] < p.lanceStrength) continue;
    let hit = -1;
    for (let j = lowerTime(a.onsetTimes, a.noteStart[i] - LANCE_SNAP); j < a.onsetTimes.length && a.onsetTimes[j] <= a.noteStart[i] + LANCE_SNAP; j++) {
      if (w.prom[j] >= p.thresh && (hit < 0 || Math.abs(a.onsetTimes[j] - a.noteStart[i]) < Math.abs(a.onsetTimes[hit] - a.noteStart[i]))) hit = j;
    }
    if (hit < 0) continue;
    const t = a.onsetTimes[hit];
    const role = sections[sectionIndexAt(sections, t)].role;
    if (t < free || restAt(rests, t) || role === 'build' || role === 'drop' || drive(t) >= LANCE_DRIVE) continue;
    let end = a.noteEnd[i];
    // A note that goes on ends its lance on a bar line
    if (end - t > LANCE_BARS * barLen) {
      const cap = t + LANCE_BARS * barLen, line = bars[barAt(bars, cap)];
      end = line > t + beat ? line : cap;
    }
    for (const [start] of rests) if (start > t && start < end) end = start;
    if (end - t < Math.max(LANCE_MIN, beat)) continue;
    lances.push({ t, end, side: -1, voice: 'snare', prom: 1, heft: 0, down: false, phrase: false, heavy: false, forced: false, lance: true });
    free = end + LANCE_REST_BARS * barLen;
  }
  return lances;
}

/** The hit at a moment the music makes a point of, if there is one. */
function hitNear(a: TrackAnalysis, t: number) {
  const i = lowerTime(a.onsetTimes, t - 0.02);
  return i < a.onsetTimes.length && a.onsetTimes[i] <= t + 0.02 ? i : -1;
}

/** How much a note insists on its place when two are too close: the lesser one gives way. */
const rank = (n: Note) => (n.forced ? 10 : n.lance ? 5 : n.heavy ? 2 + n.heft : n.prom);

/**
 * Shield style: fixed in the centre, turn the shield to block spears that land on the music's notes.
 * The song is cut like Shapes (parts with roles, runs of bars that sound alike, repeats sharing a
 * seed); each run plays its rhythm as a dance around the shield, so the same music blocks the same,
 * and the harder the music raves, the more of its notes it plays and the faster it turns.
 */
export function buildShieldChart(a: TrackAnalysis, difficulty: Difficulty): ShieldChart {
  const p = PARAMS[difficulty];
  const w = hitWeights(a);
  const shapes = shapesSections(a);
  const sections: ShieldSection[] = shapes.map((s) => ({ start: s.start, end: s.end, role: s.role, color: s.color }));
  const rests = findRests(a);
  const bars = barStarts(a);
  const barLen = a.tempo > 0 ? 240 / a.tempo : 2;
  const runs = shapesRuns(a, w, { bigAt: 0.75 }, shapes, rng(seedFor(a)));
  const parts = speedParts(a, p);
  const chartInfo = { parts, sections };
  const rave = raveCurve(a, shapes);
  const drive = (t: number) => rave[Math.min(rave.length - 1, Math.max(0, Math.round(t * ZOOM_RATE)))];

  const groups = new Map<number, ShapesRun[]>();
  for (const run of runs) groups.set(run.seed, [...(groups.get(run.seed) ?? []), run]);
  const stats = new Map([...groups].map(([seed, group]) => [seed, slotStats(a, w, p, bars, group)]));
  // A repeat dances like the passage it repeats
  const danceOf = new Map<number, Dance>();
  let prevDance: Dance | null = null;
  const choose = (run: ShapesRun) => (voices: Set<Voice>, runDrive: number) => {
    const fits = (d: Dance) => (d !== 'kit' || voices.size >= 2) && (d !== 'sway' || runDrive < SWAY_DRIVE);
    let dance = danceOf.get(run.seed);
    if (!dance || !fits(dance)) {
      const [first, second] = THEME_DANCES[run.theme];
      const order = dice(run.seed, 3) < FIRST_DANCE ? [first, second] : [second, first];
      dance = [...order, ...FALLBACK_DANCES].find((d) => fits(d) && !(d === prevDance && (d === 'stomp' || d === 'sway'))) ?? 'zigzag';
      if (!danceOf.has(run.seed)) danceOf.set(run.seed, dance);
    }
    prevDance = dance;
    return dance;
  };
  const notes = runs.flatMap((run) => runNotes(a, w, p, bars, { run, sec: sections[sectionIndexAt(sections, run.start)], stats: stats.get(run.seed)!, drive, choose: choose(run) }))
    .filter((n) => n.t >= START_AT && !restAt(rests, n.t))
    .sort((x, y) => x.t - y.t);
  markHeavies(notes, barLen, drive);
  // The moments the music makes a point of always land, heavy: a drop's first hit and a rest's return
  const points = [...sections.filter((s) => s.role === 'drop').map((s) => s.start), ...rests.map((q) => q[1])];
  for (const t of points) {
    const i = hitNear(a, t);
    if (i < 0) continue;
    const same = notes.find((n) => Math.abs(n.t - a.onsetTimes[i]) < 0.03);
    if (same) Object.assign(same, { forced: true, heavy: true });
    else notes.push({ t: a.onsetTimes[i], end: a.onsetTimes[i], side: -1, voice: voiceOf(a, i), prom: 1, heft: w.heft[i], down: true, phrase: true, heavy: true, forced: true, lance: false });
  }
  const lances = pickLances(a, w, p, rests, sections, bars, barLen, drive)
    .filter((l) => !notes.some((n) => n.forced && n.t > l.t - p.turnGap && n.t < l.end + p.turnGap));
  const clear = notes.filter((n) => n.forced || !lances.some((l) => n.t > l.t - p.turnGap && n.t < l.end + p.turnGap));
  const sorted = [...clear, ...lances].sort((x, y) => x.t - y.t);

  // Sides settle in order: a hat that follows takes the side before it, a note with no side of its
  // own turns to the far side. Two notes too close for their sides (minGap on one side, turnGap
  // across) don't both stay: the lesser gives way, so a fast stream breathes before it turns
  const events: Note[] = [];
  for (const n0 of sorted) {
    const n = { ...n0 };
    let keep = true;
    while (events.length) {
      const prev = events[events.length - 1];
      let side = n0.side === FOLLOW ? prev.side : n0.side < 0 ? (prev.side + 2) & 3 : n0.side;
      let streak = events.length - 1;
      while (streak > 0 && events[streak - 1].side === prev.side) streak--;
      // Too long on one side: this one turns, if it can (mostly across, sometimes a quarter turn)
      if (side === prev.side && !n.lance && n.t - prev.end >= p.turnGap
        && (events.length - streak >= STREAK_NOTES || n.t - events[streak].t >= STREAK_BARS * barLen)) {
        side = (side + [2, 2, 1, 3][Math.floor(dice(Math.round(n.t * 100), 11) * 4)]) & 3;
      }
      n.side = side;
      const need = side === prev.side ? p.minGap : p.turnGap;
      if (n.t - prev.end >= need) break;
      if (!prev.forced && !prev.lance && rank(n) > rank(prev) * (side === prev.side ? YIELD : 1)) { events.pop(); continue; }
      keep = false;
      break;
    }
    if (!keep) continue;
    if (events.length === 0 && n.side < 0) n.side = 0;
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
  /** Per lane: the music time the last spear on it came into view; one on the same lane may not overtake it. */
  const laneFly = [-Infinity, -Infinity, -Infinity, -Infinity];
  let prevEnd = -Infinity;
  for (const e of events) {
    const side = e.side as Side;
    const heavy = (e.heavy || e.forced) && !e.lance;

    // Launched at the speed of the moment it's launched: a change of speed never moves a landing
    const flyTo = localTime(rests, e.t);
    const guess = songTime(rests, Math.max(0, flyTo - leadFor(e.t, heavy)));
    let kind: Spear['kind'] = e.lance ? 'lance' : 'spear';
    let from = side, flip = 0;
    const flipBy = e.t - p.reverseRead - REVERSE_FLIP;
    const calmFlight = localTime(rests, e.t) - localTime(rests, guess) === e.t - guess;
    if (!e.lance && !heavy && e.t - prevEnd >= p.turnGap && calmFlight && intensityAt(a, e.t) >= REVERSE_INTEN
      && flipBy >= guess + REVERSE_SHOWN && dice(Math.round(e.t * 100), 7) < p.reverseChance) {
      kind = 'reverse';
      from = ((side + 2) & 3) as Side;
    }
    const lanes = kind === 'reverse' ? [side, from] : [side];
    const lead = Math.min(leadFor(guess, heavy), flyTo - Math.max(...lanes.map((l) => laneFly[l])));
    const flyFrom = flyTo - lead;
    const spawn = songTime(rests, flyFrom);
    const far = borderAt(chartInfo, spawn);
    if (kind === 'reverse') {
      // The jump is part of the rhythm where it can be
      const beat = a.beatTimes[lowerTime(a.beatTimes, flipBy + 1e-3) - 1];
      flip = beat !== undefined && beat >= spawn + REVERSE_SHOWN && flipBy - beat <= REVERSE_SNAP ? beat : flipBy;
      if (flip < spawn + REVERSE_SHOWN) { kind = 'spear'; from = side; }
    }
    const flyEnd = localTime(rests, e.end);
    spears.push({ spawn, far, arrive: e.t, end: e.end, flyFrom, flyTo, flyEnd, side, from, flip, kind, voice: e.voice, heavy });
    // A lance's tail comes into view a flight after its end
    for (const l of lanes) laneFly[l] = flyFrom + (flyEnd - flyTo);
    prevEnd = e.end;
  }
  const launches = spears.map((_, i) => i).sort((x, y) => spears[x].spawn - spears[y].spawn);
  const maxLead = spears.reduce((m, s) => Math.max(m, s.arrive - s.spawn), 0);

  const checkpoints = [0];
  for (const b of bars) {
    if (b - checkpoints[checkpoints.length - 1] >= CHECKPOINT_EVERY && a.duration - b > CHECKPOINT_END) checkpoints.push(b);
  }
  return { parts, sections, rests, beats: a.beatTimes, spears, launches, maxLead, checkpoints, maxHp: p.hp, late: p.late };
}
