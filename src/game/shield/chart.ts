import type { TrackAnalysis } from '../../audio/analysis';
import { hitWeights, rng, sectionIndexAt, seedFor, type Difficulty } from '../common';
import { songRepeats } from '../shapes/chart';

/** The side a spear comes from and the shield faces: 0 up, 1 right, 2 down, 3 left. */
export type Side = 0 | 1 | 2 | 3;

/** Shield's distance from the centre, and where spears come into view, world units. */
export const SHIELD_R = 11;
export const FAR_R = 48;

export interface Spear {
  /** When it comes into view. */
  spawn: number;
  /** When it reaches the shield, on a hit (or a held note's start). */
  arrive: number;
  /** When it's over: `arrive`, or the end of a held note for a lance. */
  end: number;
  /** The side to block. */
  side: Side;
  /** The side it comes in from; the opposite of `side` for a reverse spear. */
  from: Side;
  /** Reverse spear: when it jumps over to `side`. */
  flip: number;
  /** A reverse spear flies in tail first and jumps to the far side; a lance lasts as long as its note. */
  kind: 'spear' | 'reverse' | 'lance';
  heavy: boolean;
}

export interface ShieldChart {
  /** Sorted by `arrive` and by `spawn`, never overlapping a lance. */
  spears: Spear[];
  checkpoints: number[];
  maxHp: number;
  /** After a spear's arrival: how long the shield may still turn to block it. */
  late: number;
}

interface Params {
  /** Shortest time between spears, at full intensity. */
  minGap: number;
  /** Shortest time between spears on different sides. */
  turnGap: number;
  /** Prominence a hit needs to send a spear. */
  thresh: number;
  /** Flight time at low intensity, seconds. */
  lead: number;
  hp: number;
  late: number;
  reverseChance: number;
  /** Seconds a reverse spear leaves between landing on its real side and arriving. */
  reverseRead: number;
  /** Loudest share of the mids a held note must take to become a lance. */
  lanceStrength: number;
}

const PARAMS: Record<Difficulty, Params> = {
  easy: { minGap: 0.32, turnGap: 0.5, thresh: 0.6, lead: 1.35, hp: 6, late: 0.07, reverseChance: 0, reverseRead: 0.5, lanceStrength: 0.45 },
  normal: { minGap: 0.2, turnGap: 0.3, thresh: 0.45, lead: 1.05, hp: 5, late: 0.055, reverseChance: 0.14, reverseRead: 0.42, lanceStrength: 0.35 },
  hard: { minGap: 0.13, turnGap: 0.2, thresh: 0.3, lead: 0.85, hp: 4, late: 0.04, reverseChance: 0.26, reverseRead: 0.34, lanceStrength: 0.25 },
};

/** Nothing arrives before this, so the first spear can be seen coming. */
const START_AT = 0.6;
/** How much longer the gaps get as the intensity falls to nothing. */
const GAP_QUIET = 0.9;
/** A hit on the beat needs this much less prominence. */
const BEAT_BONUS = 0.12;
const BEAT_NEAR = 0.05;
/** After this long without a spear, any hit will do. */
const IDLE = 1.6;
/** A hit gives way to a hit this much more prominent right behind it. */
const YIELD = 1.25;
/** Flight time at full intensity against low intensity, and of a heavy spear against a normal one. */
const LEAD_LOUD = 0.75;
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
/** Sides pick a new pattern every this many bars (a fixed block where there's no beat grid). */
const PHRASE_BARS = 2;
const PHRASE_FALLBACK = 4;
/** Longest run on one side before the pattern is pushed on. */
const SAME_MAX = 5;
const CHECKPOINT_EVERY = 25;
const CHECKPOINT_END = 8;

type Voice = 'kick' | 'snare' | 'hat';

/**
 * Which side the next spear of a phrase comes from. `voices` gives each drum its own side, so the
 * blocks play the beat; the rest walk around the shield.
 */
interface Pattern {
  kind: 'voices' | 'spin' | 'ping' | 'pairs';
  a: number;
  /** Spin direction. */
  dir: 1 | 3;
  /** Side per voice. */
  sides: Record<Voice, number>;
}

interface Event { t: number; end: number; voice: Voice; heavy: boolean; lance: boolean; inten: number }

function lowerTime(arr: Float32Array, t: number) {
  let a = 0, b = arr.length;
  while (a < b) { const m = (a + b) >> 1; if (arr[m] < t) a = m + 1; else b = m; }
  return a;
}

function phraseStarts(a: TrackAnalysis): number[] {
  const downs: number[] = [];
  for (let i = 0; i < a.beatTimes.length; i++) if (a.beatInBar[i] === 0) downs.push(a.beatTimes[i]);
  const starts = [0];
  if (downs.length >= 2) {
    for (let i = 0; i < downs.length; i += PHRASE_BARS) if (downs[i] > 0.5) starts.push(downs[i]);
  } else {
    for (let t = PHRASE_FALLBACK; t < a.duration; t += PHRASE_FALLBACK) starts.push(t);
  }
  return starts;
}

function rollPattern(r: () => number, rate: number, voices: number, prev: Pattern | null): Pattern {
  const weights: [Pattern['kind'], number][] = [
    ['voices', voices >= 2 ? 3 : 0.5],
    ['spin', 0.5 + rate * 0.5],
    ['ping', 1.5],
    ['pairs', 1],
  ];
  if (prev) for (const w of weights) if (w[0] === prev.kind) w[1] *= 0.4;
  let roll = r() * weights.reduce((sum, w) => sum + w[1], 0);
  let kind = weights[0][0];
  for (const w of weights) {
    kind = w[0];
    roll -= w[1];
    if (roll <= 0) break;
  }
  const a = Math.floor(r() * 4);
  const skip = r() < 0.5 ? 1 : 3;
  return {
    kind, a,
    dir: r() < 0.5 ? 1 : 3,
    sides: { kick: a, snare: (a + skip) & 3, hat: (a + skip + skip) & 3 },
  };
}

function patternSide(p: Pattern, i: number, voice: Voice) {
  switch (p.kind) {
    case 'voices': return p.sides[voice];
    case 'spin': return (p.a + p.dir * i) & 3;
    case 'ping': return (p.a + 2 * (i & 1)) & 3;
    case 'pairs': return (p.a + p.dir * (i >> 1)) & 3;
  }
}

/** Held notes loud enough to block all the way through, spaced apart. */
function pickLances(a: TrackAnalysis, p: Params) {
  const lances: { t: number; end: number }[] = [];
  let free = START_AT;
  for (let i = 0; i < a.noteStart.length; i++) {
    const t = a.noteStart[i];
    const end = Math.min(a.noteEnd[i], t + LANCE_MAX);
    if (a.noteStrength[i] < p.lanceStrength || end - t < LANCE_MIN || t < free) continue;
    lances.push({ t, end });
    free = end + LANCE_REST;
  }
  return lances;
}

/** The hits that send a spear (around the lances), with the lances: everything to block, in order. */
function pickEvents(a: TrackAnalysis, p: Params): Event[] {
  const { prom, heft, inten } = hitWeights(a);
  const n = a.onsetTimes.length;
  const lances = pickLances(a, p);
  const events: Event[] = [];
  let last = -Infinity, lanceEnd = -Infinity, lastHeavy = -Infinity, nextLance = 0;
  const addLance = () => {
    const l = lances[nextLance++];
    events.push({ t: l.t, end: l.end, voice: 'snare', heavy: false, lance: true, inten: 0.5 });
    last = lanceEnd = l.end;
  };
  for (let i = 0; i < n; i++) {
    const t = a.onsetTimes[i];
    while (nextLance < lances.length && lances[nextLance].t <= t) addLance();
    if (t < START_AT || t < lanceEnd + p.turnGap) continue;
    if (nextLance < lances.length && lances[nextLance].t - t < p.turnGap) continue;
    const gap = p.minGap * (1 + GAP_QUIET * (1 - inten[i]));
    const since = t - last;
    if (since < gap) continue;
    let yields = false;
    for (let j = i + 1; j < n && a.onsetTimes[j] - t < gap; j++) if (prom[j] > prom[i] * YIELD) yields = true;
    if (yields) continue;
    const k = lowerTime(a.beatTimes, t - BEAT_NEAR);
    const onBeat = k < a.beatTimes.length && a.beatTimes[k] - t <= BEAT_NEAR;
    if (since < IDLE && prom[i] < p.thresh - (onBeat ? BEAT_BONUS : 0)) continue;
    const voice: Voice = a.onsetLowness[i] > 0.5 ? 'kick' : a.onsetBrightness[i] > 0.45 ? 'hat' : 'snare';
    const heavy = heft[i] >= HEAVY_HEFT && prom[i] >= HEAVY_PROM && t - lastHeavy >= HEAVY_REST;
    if (heavy) lastHeavy = t;
    events.push({ t, end: t, voice, heavy, lance: false, inten: inten[i] });
    last = t;
  }
  while (nextLance < lances.length) addLance();
  return events;
}

/**
 * Shield style: fixed in the centre, turn the shield to block spears that land on the music's hits.
 * The song is cut into phrases of a couple of bars, each with its own way of walking around the
 * shield; a repeated passage takes the pattern of what it repeats, so a refrain blocks the same.
 */
export function buildShieldChart(a: TrackAnalysis, difficulty: Difficulty): ShieldChart {
  const p = PARAMS[difficulty];
  const r = rng(seedFor(a));
  const events = pickEvents(a, p);
  const starts = phraseStarts(a);
  const phrases = starts.map((start, k) => ({ start, end: starts[k + 1] ?? a.duration }));

  const patterns: Pattern[] = [];
  const origin = songRepeats(a);
  let at = 0;
  for (let k = 0; k < phrases.length; k++) {
    const { start, end } = phrases[k];
    const heard = origin(start + 0.01);
    const j = heard >= 0 ? sectionIndexAt(phrases, heard) : k;
    let count = 0;
    const voices = new Set<Voice>();
    for (; at < events.length && events[at].t < end; at++) { count++; voices.add(events[at].voice); }
    patterns.push(j < k ? patterns[j] : rollPattern(r, count / Math.max(0.5, end - start), voices.size, patterns[k - 1] ?? null));
  }

  const spears: Spear[] = [];
  let phrase = -1, inPhrase = 0, prevEnd = -Infinity, prevSide = -1, same = 0, prevSpawn = 0;
  for (const e of events) {
    const k = sectionIndexAt(phrases, e.t);
    if (k !== phrase) { phrase = k; inPhrase = 0; }
    const pat = patterns[k];
    const free = e.t - prevEnd >= p.turnGap;
    let side = free || prevSide < 0 ? patternSide(pat, inPhrase, e.voice) : prevSide;
    inPhrase++;
    if (side === prevSide && same >= SAME_MAX && free) side = (side + pat.dir) & 3;
    same = side === prevSide ? same + 1 : 1;

    // Spears keep coming into view in the order they land, so none overtakes another
    const flight = p.lead * (1 - (1 - LEAD_LOUD) * e.inten) * (e.heavy ? LEAD_HEAVY : 1);
    const lead = Math.min(Math.max(LEAD_MIN, flight), e.t - prevSpawn);
    const spawn = e.t - lead;

    let kind: Spear['kind'] = e.lance ? 'lance' : 'spear';
    let from = side, flip = 0;
    const flipBy = e.t - p.reverseRead - REVERSE_FLIP;
    if (!e.lance && !e.heavy && free && e.inten >= REVERSE_INTEN && flipBy >= spawn + REVERSE_SHOWN && r() < p.reverseChance) {
      kind = 'reverse';
      from = (side + 2) & 3;
      // The jump is part of the rhythm where it can be
      const beat = a.beatTimes[lowerTime(a.beatTimes, flipBy + 1e-3) - 1];
      flip = beat !== undefined && beat >= spawn + REVERSE_SHOWN && flipBy - beat <= REVERSE_SNAP ? beat : flipBy;
    }
    spears.push({ spawn, arrive: e.t, end: e.end, side: side as Side, from: from as Side, flip, kind, heavy: e.heavy });
    prevEnd = e.end;
    prevSide = side;
    prevSpawn = spawn;
  }

  const checkpoints = [0];
  for (const { start } of phrases) {
    if (start - checkpoints[checkpoints.length - 1] >= CHECKPOINT_EVERY && a.duration - start > CHECKPOINT_END) checkpoints.push(start);
  }
  return { spears, checkpoints, maxHp: p.hp, late: p.late };
}

/** Radians of a side around the centre. */
export const sideAngle = (side: number) => (side * Math.PI) / 2 - Math.PI / 2;

/** Distance from the centre at time t of a point that lands at `at`, in a spear's flight. */
export function flightDist(s: Spear, t: number, at = s.arrive) {
  const f = (at - t) / Math.max(1e-3, s.arrive - s.spawn);
  return SHIELD_R + f * (FAR_R - SHIELD_R);
}

/** Where a spear is around the centre at time t, and whether it's still flying tail first. */
export function spearPose(s: Spear, t: number) {
  if (s.kind !== 'reverse' || t >= s.flip + REVERSE_FLIP) return { angle: sideAngle(s.side), backwards: false };
  if (t < s.flip) return { angle: sideAngle(s.from), backwards: true };
  return { angle: sideAngle(s.from) + (Math.PI * (t - s.flip)) / REVERSE_FLIP, backwards: false };
}
