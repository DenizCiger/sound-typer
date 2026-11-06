import { PRINT_CHROMA, PRINT_FPS, PRINT_SIZE, type TrackAnalysis } from '../../audio/analysis';
import { ARENA_ASPECT, budgetWindow, hitWeights, intensityAt, rng, sample, scaleFor, sectionIndexAt, seedFor, snapToHit, songParts, zoomCurve, ZOOM_RATE, type BaseSection, type Coverage, type Difficulty, type HitWeights } from '../common';

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
 * Sections follow the song's structure (`songParts`): each part gets a role (calm, main, build,
 * drop, break) and a colour. Builds hold back and squeeze the arena; drops open with a slam.
 * Themes come in runs of bars (the analysis' beat grid): a run lasts as long as its bars sound
 * alike and ends when the music changes, so attacks follow the music rather than a timer. Each
 * run's theme is picked by its character (accented → bars, bassy and punchy → walls, steady →
 * steps, hats → rain, sustained → spinner), and a run that sounds like an earlier one reuses its
 * theme.
 *
 * Positions are normalized to the arena (0..1); sizes and speeds are in world units
 * (the arena's shorter side is 100). The arena itself grows and shrinks around its centre with
 * the music (`zoom`); a hazard is placed in the arena as it was when its warning started.
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
  /**
   * A rest in the music the hazard was solid through: it froze in place from the first to the
   * second time, and `end` is that much later.
   */
  freeze?: [number, number];
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
  /** Checkerboard over the play area: the cells of one parity flash solid, `fill` of their size. */
  | { kind: 'grid'; cell: number; parity: 0 | 1; fill: number }
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
 * a drifting pivot, ray bursts, pop-ups. rain: falling shots, seekers, big pop-ups. grid: half a
 * checkerboard flashing on the bar's big hit, pop-ups on the kicks.
 */
export type Theme = 'field' | 'bars' | 'steps' | 'walls' | 'spinner' | 'rain' | 'grid';

/**
 * What a part of the song does. calm/main play their theme; a build holds back and squeezes the
 * arena in the seconds before a drop; a drop opens with a slam and leans on the big themes; a
 * break is the calm right after something intense.
 */
export type Role = 'calm' | 'main' | 'build' | 'drop' | 'break';

export interface ShapesSection extends BaseSection {
  role: Role;
  /** Song-relative intensity of the part, 0 (this song's calmest) to 1 (its most intense). */
  level: number;
  /** Hazard colour as "r, g, b"; parts of the same kind share it, so a returning chorus looks the same. */
  color: string;
}

/** Bars in a row that play one theme: as long as they sound alike, within one section. */
export interface ShapesRun {
  start: number;
  end: number;
  theme: Theme;
  /** Share of the run's real hits that are kicks: steps march on those when there are enough. */
  kicks: number;
  /** Seeds the run's placement: a run repeating an earlier one shares its seed, so it lays out the same. */
  seed: number;
}

export interface ShapesChart {
  sections: ShapesSection[];
  runs: ShapesRun[];
  /** Sorted by `warn`. */
  hazards: Hazard[];
  /** Song positions the player rewinds to after running out of health. Starts with 0. */
  checkpoints: number[];
  maxHp: number;
  /** Seconds after a dash ends before the next one. */
  dashCooldown: number;
  /** Arena scale over the song (`zoomCurve`): attacks cover about the same share of it throughout. */
  zoom: Float32Array;
  /** Rests in the music (start, return on a hit): everything freezes, then the music snaps back. */
  rests: [number, number][];
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
  /** Beats between homing seekers; they never chain. */
  seekerBeats: number;
  dashCooldown: number;
  /** Rotating beams per spinner section. */
  beams: number;
  /**
   * Seconds between a lane going away and the next one going solid in a steps march, so the
   * player can always step back over the march instead of being forced to dash. Lanes end just
   * before the next one lands, so this is all the march has to leave out of the beat.
   */
  stepSlack: number;
  /** Bars between walls (never closer than WALL_GAP_MIN seconds). */
  wallBars: number;
  /** Shot volleys on weak hits outside rain sections. */
  volleys: boolean;
  /** Longest stretch without anything new before any usable hit fills it in. */
  idleMax: number;
}

const PARAMS: Record<Difficulty, Params> = {
  easy: { lead: 0.85, reaction: 0.4, budget: 3.5, hp: 6, gapSize: 26, speed: 0.9, shotMin: 0.45, bigAt: 0.8, targetRatio: 0.25, pops: 3, seekerBeats: 3, dashCooldown: 0.2, stepSlack: 0.2, beams: 1, wallBars: 2, volleys: false, idleMax: 2 },
  normal: { lead: 0.68, reaction: 0.32, budget: 5.5, hp: 4, gapSize: 20, speed: 1.0, shotMin: 0.3, bigAt: 0.75, targetRatio: 0.4, pops: 5, seekerBeats: 2, dashCooldown: 0.25, stepSlack: 0.13, beams: 2, wallBars: 1, volleys: true, idleMax: 1.2 },
  hard: { lead: 0.55, reaction: 0.27, budget: 7, hp: 3, gapSize: 18, speed: 1.1, shotMin: 0.2, bigAt: 0.7, targetRatio: 0.45, pops: 6, seekerBeats: 1.5, dashCooldown: 0.3, stepSlack: 0.1, beams: 2, wallBars: 1, volleys: true, idleMax: 0.8 },
};

const COST: Record<Hazard['kind'], number> = { shot: 0.25, bomb: 0.8, box: 0.8, bar: 1, wall: 2, beam: 0, grid: 2.5 };
const CHECKPOINT_EVERY = 25;
const CALM_THEMES: Theme[] = ['field', 'rain', 'steps'];
const ALL_THEMES: Theme[] = ['field', 'bars', 'steps', 'walls', 'spinner', 'rain', 'grid'];
/** Themes a drop leans on. */
const BIG_THEMES: Theme[] = ['bars', 'walls', 'spinner', 'grid'];
/** Grid cell size, world units, and how long a flash stays solid. */
const GRID_CELL = 22;
const GRID_LIFE = 0.3;
/** Empty bars after a flash and its counter-flash before the grid may flash again. */
const GRID_REST_BARS = 2;
/**
 * Rests: the loudness falls below REST_DROP of the second before (while music was playing, at
 * least REST_PLAYING), stays down REST_MIN..REST_MAX seconds and comes back past REST_BACK on a
 * hit at least REST_HIT strong. Not near the song's ends, and REST_GAP apart.
 */
const REST_DROP = 0.4;
const REST_BACK = 0.6;
const REST_PLAYING = 0.35;
const REST_MIN = 0.2;
const REST_MAX = 3;
const REST_HIT = 0.4;
const REST_GAP = 4;
/** A run of bars ends when a bar differs this much from the run so far (mean feature difference). */
const RUN_CHANGE = 0.2;
/** ...or at a four bar phrase when it differs this much, or after this many bars regardless. */
const RUN_PHRASE_CHANGE = 0.1;
const RUN_MAX_BARS = 8;
/** A run that sounds this close to an earlier one plays the same theme again. */
const RUN_RECALL = 0.07;
/** Each use of a theme in the last RECENT_RUNS runs makes rolling it less likely; the grid isn't recalled past RECENT_MAX uses or right after itself. */
const RECENT_RUNS = 6;
const RECENT_MAX = 2;
/**
 * Repeats (`songRepeats`): stretches of at least REPEAT_MIN beats that sound like the music at
 * least REPEAT_LAG beats earlier (16 bars, so a 4 bar loop isn't a repeat of itself and can still
 * change attacks). Beats are alike above the REPEAT_TOP share of the track's beat pairs, and at
 * least REPEAT_SIM; REPEAT_GAP unlike beats in a row don't end a stretch. A run takes after what
 * it repeats when at least REPEAT_SHARE of it is a repeat.
 */
const REPEAT_MIN = 16;
const REPEAT_LAG = 64;
const REPEAT_TOP = 0.85;
const REPEAT_SIM = 0.45;
const REPEAT_GAP = 4;
const REPEAT_SHARE = 0.5;
/**
 * Held notes become beams whatever the theme is, the way a spinner's do: at least NOTE_BEAM_MIN
 * seconds and at least NOTE_BEAM_LEVEL loud, with `noteStrength` * (0.5 + level) at least
 * NOTE_BEAM_STRENGTH (one trumpet in a full orchestra takes little of the energy, but the louder
 * the music the less it needs). Notes this close together (NOTE_JOIN, seconds) are one phrase, one
 * beam; from NOTE_CROSS two beams.
 */
const NOTE_BEAM_MIN = 1.5;
const NOTE_BEAM_STRENGTH = 0.45;
const NOTE_BEAM_LEVEL = 0.3;
const NOTE_JOIN = 0.25;
const NOTE_CROSS = 0.6;
/** Bars without a beat grid (silence, or no steady beat) are cut this long, seconds. */
const BAR_FALLBACK = 2;
/**
 * Hits are sorted into instrument voices, and each theme gives every voice its own attack, so
 * the screen plays the parts of the music instead of one attack taking over: a kick is mostly
 * bass, a hat mostly treble.
 */
type Voice = 'kick' | 'snare' | 'hat';
const KICK_LOW = 0.5;
const HAT_BRIGHT = 0.5;
const HAT_LOW = 0.3;
/** Steps march on kicks when at least this share of a run's hits are kicks, else on hits on beats 1 and 3 (where kicks would be). */
const STEP_KICKS = 0.2;
/**
 * Spinner beams live while a sustained sound holds (`beamHolds`): about as tonal as the run's
 * average or more (and at least HOLD_TONAL) and loud enough. A hold the music cuts short still
 * needs BEAM_MIN seconds (or a beat) to be worth a beam; at most BEAM_BARS bars.
 */
const HOLD_TONAL = 0.4;
/** A hold ends once the tonal share falls this far below where it started counting (brief dips don't cut it). */
const HOLD_SLACK = 0.1;
/** Spinners only for runs with this much sustained sound on average: without held sounds, no beams. */
const SPINNER_TONAL = 0.45;
const HOLD_LEVEL = 0.25;
const BEAM_BARS = 2;
const BEAM_MIN = 0.8;
/** Spinners and steps need some room to play out, seconds. */
const SPINNER_MIN = 4;
const STEPS_MIN = 2.5;
/** A part this much more intense than the one before (song-relative), and at least DROP_LEVEL, is a drop. */
const DROP_JUMP = 0.25;
const DROP_LEVEL = 0.6;
/** A part at most BREAK_LEVEL that falls this much from the one before is a break. */
const BREAK_FALL = 0.3;
const BREAK_LEVEL = 0.4;
/** Below this absolute intensity a part is calm, however it compares to the rest of the song. */
const CALM_INTEN = 0.16;
/** The build before a drop: the last seconds of the part before it, at most and at least. */
const BUILD_MAX = 8;
const BUILD_MIN = 3;
/** Builds only take hits that stand out this much, and only this share of the budget. */
const BUILD_PROM = 0.6;
const BUILD_BUDGET = 0.5;
/** Beats between volleys in a build. */
const BUILD_VOLLEY_BEATS = 4;
/** Beats between ray bursts, fewer when the music is intense (down to BURST_BEATS - 1). */
const BURST_BEATS = 2;
/** Walls come at least this many seconds apart whatever the tempo, so a run of them stays threadable. */
const WALL_GAP_MIN = 0.9;
/** The arena squeezes in to this scale by the end of a build, so the drop bursts it open. */
const BUILD_SQUEEZE = 0.5;
/** Hazard colours: violet for calm parts, pink and orange for the rest, amber builds, red drops. */
const COLORS = { calm: '150, 90, 255', break: '190, 80, 255', main: '255, 36, 112', loud: '255, 110, 40', build: '255, 190, 60', drop: '255, 44, 60' };
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
/** Arena scale bounds: 2.5x zoom when little is going on, out past the screen when it's packed. */
const ZOOM_CALM = 0.4;
const ZOOM_WIDE = 1.12;
/** Share of the play area attacks (warnings included) should cover; the area scales to keep it. */
const COVER = 0.3;
/** No single hazard spans more than this share of the play area's short side. */
const MAX_SPAN_SHARE = 0.4;
/** Heft from which a big hit gets the heavy attacks (walls, ray bursts, rings of shots). */
const HEAVY = 0.45;
/** Heft from which bars slam a cross and pop-ups burst into a ring of shots. */
const SLAM = 0.75;


/** Splits the song into parts with roles and colours; the end of the part before a drop is its build. */
function shapesSections(a: TrackAnalysis): ShapesSection[] {
  const parts = songParts(a);
  // Song-relative scale like Wave's speed stages, with a minimum range so a flat song stays flat
  const sorted = parts.map((q) => q.inten).sort((x, y) => x - y);
  const low = sorted[0], range = Math.max(0.35, sorted[sorted.length - 1] - low);
  const levels = parts.map((q) => Math.min(1, (q.inten - low) / range));
  const roles = parts.map((q, k): Role => {
    const prev = k > 0 ? levels[k - 1] : levels[k];
    if (k > 0 && levels[k] >= DROP_LEVEL && levels[k] - prev >= DROP_JUMP && q.inten >= HEAVY_INTEN) return 'drop';
    if (k > 0 && levels[k] <= BREAK_LEVEL && prev - levels[k] >= BREAK_FALL) return 'break';
    return q.inten < CALM_INTEN || (levels[k] < 0.2 && q.inten < HEAVY_INTEN) ? 'calm' : 'main';
  });

  const sections: ShapesSection[] = [];
  parts.forEach((q, k) => {
    const color = COLORS[roles[k] === 'main' && levels[k] >= 0.55 ? 'loud' : roles[k]];
    const sec = { start: q.start, end: q.end, energy: q.inten, level: levels[k], role: roles[k], color };
    if (roles[k + 1] === 'drop' && roles[k] !== 'drop' && q.end - q.start >= BUILD_MIN * 2) {
      const at = snapToHit(a, Math.max(q.start + BUILD_MIN, q.end - BUILD_MAX), 1);
      if (q.end - at >= BUILD_MIN && at - q.start >= BUILD_MIN) {
        sections.push({ ...sec, end: at });
        sections.push({ ...sec, start: at, role: 'build', color: COLORS.build });
        return;
      }
    }
    sections.push(sec);
  });
  return sections;
}

/** Moments the music stops dead and comes back on a hit: (start, return) pairs. */
function findRests(a: TrackAnalysis): [number, number][] {
  const out: [number, number][] = [];
  const n = a.level.length, fps = a.fps;
  for (let f = Math.round(3 * fps); f < n - 3 * fps; f++) {
    let pre = 0;
    for (let k = f - fps; k < f - 5; k++) pre += a.level[k];
    pre /= fps - 5;
    if (pre < REST_PLAYING || a.level[f] >= REST_DROP * pre) continue;
    let e = f;
    while (e < n && a.level[e] < REST_BACK * pre && e - f <= REST_MAX * fps) e++;
    // The music has to come back on a hit, which is when the snap lands
    let back = -1;
    for (let i = lowerTime(a.onsetTimes, e / fps - 0.1); i < a.onsetTimes.length && a.onsetTimes[i] < e / fps + 0.1; i++) {
      if (a.onsetStrength[i] >= REST_HIT) { back = a.onsetTimes[i]; break; }
    }
    const start = f / fps;
    if (back > 0 && back - start >= REST_MIN && back - start <= REST_MAX && (out.length === 0 || start - out[out.length - 1][1] >= REST_GAP)) out.push([start, back]);
    f = e;
  }
  return out;
}

/** First index of sorted times that is >= t. */
function lowerTime(times: Float32Array, t: number) {
  let lo = 0, hi = times.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] < t) lo = m + 1; else hi = m; }
  return lo;
}

/** Bar start times from the beat grid; stretches without one are cut every BAR_FALLBACK seconds. */
function barStarts(a: TrackAnalysis): number[] {
  const downs: number[] = [];
  for (let k = 0; k < a.beatTimes.length; k++) if (a.beatInBar[k] === 0) downs.push(a.beatTimes[k]);
  const bars = [0];
  for (const t of [...downs, a.duration]) {
    const prev = bars[bars.length - 1];
    // A gap much longer than a bar has no beat in it
    for (let f = prev + BAR_FALLBACK; t - f > BAR_FALLBACK * 0.5 && t - prev > BAR_FALLBACK * 1.5; f += BAR_FALLBACK) bars.push(f);
    if (t - bars[bars.length - 1] > 0.3 && t < a.duration) bars.push(t);
  }
  bars.push(a.duration);
  return bars;
}

/**
 * Finds what repeats (a refrain coming back) by comparing what every beat sounds like with every
 * earlier beat, looking for diagonals. Works on beats rather than bars, since downbeats are the
 * least reliable part of the grid. Returns where a time was first heard: -1 if it's new.
 */
function songRepeats(a: TrackAnalysis): (t: number) => number {
  const beats = a.beatTimes.length >= REPEAT_LAG ? a.beatTimes : Float32Array.from({ length: Math.floor(a.duration * 2) }, (_, k) => k / 2);
  const n = beats.length;
  const none = new Int32Array(n).fill(-1);
  const at = (o: Int32Array) => (t: number) => {
    const k = lowerTime(beats, t + 0.001) - 1;
    return k < 0 || k >= n || o[k] < 0 ? -1 : beats[o[k]] + t - beats[k];
  };
  if (n <= REPEAT_LAG) return at(none);

  // Per beat: its average print, against the track's average (what's always there says nothing)
  const prints = a.print.length / PRINT_SIZE;
  const v = new Float32Array(n * PRINT_SIZE);
  const mean = new Float32Array(PRINT_SIZE);
  for (let k = 0; k < n; k++) {
    const p0 = Math.min(prints - 1, Math.floor(beats[k] * PRINT_FPS));
    const p1 = Math.min(prints, Math.max(p0 + 1, Math.floor((k + 1 < n ? beats[k + 1] : beats[k] + 0.5) * PRINT_FPS)));
    for (let d = 0; d < PRINT_SIZE; d++) {
      let s = 0;
      for (let q = p0; q < p1; q++) s += a.print[q * PRINT_SIZE + d];
      v[k * PRINT_SIZE + d] = s / Math.max(1, p1 - p0);
      mean[d] += v[k * PRINT_SIZE + d] / n;
    }
  }
  // Harmony and timbre count separately, each scaled to unit length
  for (let k = 0; k < n; k++) {
    let c = 0, s = 0;
    for (let d = 0; d < PRINT_SIZE; d++) {
      const x = (v[k * PRINT_SIZE + d] -= mean[d]);
      if (d < PRINT_CHROMA) c += x * x; else s += x * x;
    }
    c = Math.sqrt(c) || 1;
    s = Math.sqrt(s) || 1;
    for (let d = 0; d < PRINT_SIZE; d++) v[k * PRINT_SIZE + d] /= d < PRINT_CHROMA ? c : s;
  }
  const sim = (i: number, j: number) => {
    let c = 0, s = 0;
    for (let d = 0; d < PRINT_SIZE; d++) {
      const x = v[i * PRINT_SIZE + d] * v[j * PRINT_SIZE + d];
      if (d < PRINT_CHROMA) c += x; else s += x;
    }
    return 0.6 * c + 0.4 * s;
  };
  const sample: number[] = [];
  for (let i = REPEAT_LAG; i < n; i += 3) for (let j = (i % 5); j <= i - REPEAT_LAG; j += 5) sample.push(sim(i, j));
  if (sample.length === 0) return at(none);
  sample.sort((x, y) => x - y);
  const like = Math.max(REPEAT_SIM, sample[Math.floor((sample.length - 1) * REPEAT_TOP)]);

  const stretches: { from: number; to: number; lag: number; score: number }[] = [];
  for (let lag = REPEAT_LAG; lag < n; lag++) {
    let from = -1, last = -1, sum = 0;
    const flush = () => {
      if (from >= 0 && last - from + 1 >= REPEAT_MIN) stretches.push({ from, to: last, lag, score: sum });
      from = -1;
      sum = 0;
    };
    for (let i = lag; i < n; i++) {
      const s = sim(i, i - lag);
      if (s >= like) {
        if (from < 0) from = i;
        last = i;
        sum += s;
      } else if (from >= 0 && i - last > REPEAT_GAP) flush();
    }
    flush();
  }
  // The longest, closest matches first; each beat keeps the first one it's in
  stretches.sort((x, y) => y.score - x.score);
  const origin = new Int32Array(n).fill(-1);
  for (const q of stretches) for (let i = q.from; i <= q.to; i++) if (origin[i] < 0) origin[i] = i - q.lag;
  return at(origin);
}

/**
 * When a spinner's beams are out in a run: while a sustained sound (a held note, a pad, a long
 * vocal) holds. They stay at least a bar unless the music really drops, at most BEAM_BARS bars,
 * and leave on a beat; then at least a beat before the next one (a bar after one that hit the
 * cap, so a long pad doesn't become one endless spinner again).
 */
function beamHolds(a: TrackAnalysis, start: number, runEnd: number): [number, number][] {
  const step = 0.05;
  const end = runEnd - 0.1;
  const beat = 60 / a.tempo;
  const bar = beat * 4;
  // Averaged over a beat, so the kicks punching holes in a pad don't read as the pad ending
  const smooth = (curve: Float32Array) => {
    const sums = [0];
    for (let t = start; t <= end + step; t += step) sums.push(sums[sums.length - 1] + sample(curve, a.fps, t));
    const reach = Math.max(1, Math.round(beat / 2 / step));
    return (t: number) => {
      const k = Math.round((t - start) / step);
      const i0 = Math.max(0, k - reach), i1 = Math.min(sums.length - 1, k + reach + 1);
      return (sums[i1] - sums[i0]) / Math.max(1, i1 - i0);
    };
  };
  const tonal = smooth(a.tonal), level = smooth(a.level);
  let mean = 0, n = 0;
  for (let t = start; t <= end; t += step) { mean += sample(a.tonal, a.fps, t); n++; }
  const hold = Math.max(HOLD_TONAL, mean / Math.max(1, n) - 0.05);

  const holds: [number, number][] = [];
  let t = start + 0.3;
  while (t <= end) {
    if (tonal(t) < hold || level(t) < HOLD_LEVEL) { t += step; continue; }
    const from = snapToHit(a, t, 0.25);
    const cap = from + bar * BEAM_BARS;
    // Follow the sound; a dip of up to a beat doesn't end it, the music dropping out does
    let last = t, dropped = false, capped = false;
    for (let u = t; u <= end; u += step) {
      if (level(u) < HOLD_LEVEL) { dropped = true; break; }
      if (u >= cap) { capped = true; last = cap; break; }
      if (tonal(u) >= hold - HOLD_SLACK) last = u;
      else if (u - last > beat) break;
      if (u + step > end) last = end;
    }
    let e = dropped ? last : Math.max(last, from + bar);
    // Leave on the next beat, when there's a beat grid around here
    const k = lowerTime(a.beatTimes, e);
    if (!capped && !dropped && k < a.beatTimes.length && a.beatTimes[k] - e < beat * 1.1) e = a.beatTimes[k];
    e = Math.min(e, end, cap);
    if (e - from >= Math.max(beat, BEAM_MIN)) holds.push([from, e]);
    t = Math.max(t + step, e + beat * (capped ? 4 : 1));
  }
  return holds;
}

/** What a stretch of music does, each 0..1, for telling bars apart and picking themes. */
interface Feel {
  /** Real hits per bar, out of 8. */
  dense: number;
  /** Shares of those hits that are kicks, hats (bright), heavy. */
  kick: number;
  hat: number;
  heavy: number;
  /** Sustained sound, brightness and intensity, averaged. */
  tonal: number;
  bright: number;
  inten: number;
}

const FEEL_WEIGHTS: Record<keyof Feel, number> = { dense: 1.5, kick: 1, hat: 1, heavy: 1, tonal: 1, bright: 0.5, inten: 1.5 };

function feelDistance(x: Feel, y: Feel) {
  let d = 0, n = 0;
  for (const k of Object.keys(FEEL_WEIGHTS) as (keyof Feel)[]) { d += FEEL_WEIGHTS[k] * Math.abs(x[k] - y[k]); n += FEEL_WEIGHTS[k]; }
  return d / n;
}

/**
 * Groups bars into runs that each play one theme. A run goes on while its bars sound alike and
 * ends when the music changes (or at a phrase once it has drifted, or after RUN_MAX_BARS), and
 * never crosses a section. The theme fits the run's character; a run that sounds like an earlier
 * one gets the same theme, so a repeating riff brings back the same attack.
 */
function shapesRuns(a: TrackAnalysis, w: HitWeights, p: Params, sections: ShapesSection[], r: () => number): ShapesRun[] {
  const bars = barStarts(a);
  const feel = (start: number, end: number): Feel => {
    let n = 0, kick = 0, hat = 0, heavy = 0;
    for (let i = 0; i < a.onsetTimes.length; i++) {
      const t = a.onsetTimes[i];
      if (t < start || t >= end || w.prom[i] < 0.45) continue;
      n++;
      if (a.onsetLowness[i] > 0.5) kick++;
      if (a.onsetBrightness[i] > 0.5) hat++;
      if (w.heft[i] >= 0.55) heavy++;
    }
    let tonal = 0, bright = 0, inten = 0, k = 0;
    for (let t = start; t < end; t += 0.1) { tonal += sample(a.tonal, a.fps, t); bright += sample(a.brightness, a.fps, t); inten += intensityAt(a, t); k++; }
    const bar = (end - start) / Math.max(0.5, (60 / a.tempo) * 4);
    return { dense: Math.min(1, n / bar / 8), kick: n ? kick / n : 0, hat: n ? hat / n : 0, heavy: n ? heavy / n : 0, tonal: k ? tonal / k : 0, bright: k ? bright / k : 0, inten: k ? inten / k : 0 };
  };

  // Walls only come on big hits; a run without many would sit empty
  const punchy = (start: number, end: number) => {
    let strong = 0;
    for (let i = 0; i < a.onsetTimes.length; i++) {
      const t = a.onsetTimes[i];
      if (t >= start && t < end && w.prom[i] >= p.bigAt && w.heft[i] >= HEAVY && w.inten[i] >= HEAVY_INTEN) strong++;
    }
    return strong / Math.max(1, end - start) >= 0.35;
  };
  // How regular the beat is: the spread of the gaps between real hits against their mean
  const steadiness = (start: number, end: number) => {
    const times: number[] = [];
    for (let i = 0; i < a.onsetTimes.length; i++) if (a.onsetTimes[i] >= start && a.onsetTimes[i] < end && w.prom[i] >= 0.45) times.push(a.onsetTimes[i]);
    const gaps = times.slice(1).map((t, k) => t - times[k]);
    if (gaps.length < 4) return 0;
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    return Math.max(0, 1 - Math.sqrt(gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length) / mean);
  };

  const runs: ShapesRun[] = [];
  const past: { feel: Feel; theme: Theme; seed: number }[] = [];
  let prev: Theme | null = null;
  let seeds = 0;
  const origin = songRepeats(a);
  const runAt = (t: number) => (runs.length && t >= runs[0].start && t < runs[runs.length - 1].end ? runs[sectionIndexAt(runs, t)] : null);
  /** The earlier run this stretch mostly repeats, if it does. */
  const repeated = (start: number, end: number) => {
    const votes = new Map<ShapesRun, number>();
    let n = 0, best: ShapesRun | null = null, most = 0;
    for (let t = start; t < end; t += 0.25) {
      n++;
      const o = origin(t);
      const q = o >= 0 ? runAt(o) : null;
      if (!q) continue;
      const c = (votes.get(q) ?? 0) + 1;
      votes.set(q, c);
      if (c > most) { most = c; best = q; }
    }
    return most >= n * REPEAT_SHARE ? best : null;
  };
  for (const sec of sections) {
    const calm = sec.role === 'calm' || sec.role === 'break' || sec.role === 'build';
    /** Settles a run's theme as soon as it's cut, so later repeats can look it up. */
    const commit = (start: number, end: number) => {
      const f = feel(start, end);
      const len = end - start;
      const fits = (t: Theme) => (calm ? CALM_THEMES : ALL_THEMES).includes(t)
        && !(t === 'spinner' && (len < SPINNER_MIN || f.tonal < SPINNER_TONAL || beamHolds(a, start, end).length === 0)) && !(t === 'steps' && len < STEPS_MIN) && !(t === 'walls' && !punchy(start, end));
      const uses = (t: Theme) => runs.slice(-RECENT_RUNS).filter((q) => q.theme === t).length;
      const copy = repeated(start, end);
      const recall = past.find((q) => feelDistance(q.feel, f) < RUN_RECALL && fits(q.theme) && (q.theme !== 'grid' || (prev !== 'grid' && uses('grid') < RECENT_MAX)));
      let theme: Theme;
      let seed = seeds;
      if (copy && fits(copy.theme)) {
        theme = copy.theme;
        seed = copy.seed;
      } else if (recall) {
        theme = recall.theme;
        seed = recall.seed;
      } else {
        seeds++;
        // The dice only lean: each theme is weighted by how well it fits what the music is doing
        const steady = steadiness(start, end);
        const weight = (t: Theme) => {
          const fit = t === 'field' ? 0.5 + 0.6 * (1 - sec.level)
            : t === 'bars' ? 0.3 + 2 * f.heavy
            : t === 'steps' ? 0.2 + steady * Math.min(1, f.dense * 2)
            : t === 'walls' ? 0.3 + 2 * f.kick
            : t === 'spinner' ? 0.2 + 1.5 * f.tonal * (1 - f.dense)
            : t === 'grid' ? 0.1 + 0.7 * f.kick * steady
            : 0.2 + 1.6 * f.hat * (1 - f.kick);
          return (sec.role === 'drop' && BIG_THEMES.includes(t) ? fit * 1.8 : fit) / (1 + uses(t));
        };
        const pool = ALL_THEMES.filter((t) => fits(t) && t !== prev);
        let roll = r() * pool.reduce((sum, t) => sum + weight(t), 0);
        theme = pool.find((t) => (roll -= weight(t)) < 0) ?? pool[0] ?? 'field';
        past.push({ feel: f, theme, seed });
      }
      prev = theme;
      runs.push({ start, end, theme, kicks: f.kick, seed });
    };

    // This section's bars, cut at its edges (a sliver of a bar there joins its neighbour)
    const half = (60 / a.tempo) * 2;
    const cuts = [sec.start, ...bars.filter((b) => b > sec.start + half && b < sec.end - half), sec.end];
    let run = [cuts[0], cuts[1]], sum = feel(cuts[0], cuts[1]), count = 1;
    for (let k = 1; k + 1 < cuts.length; k++) {
      const f = feel(cuts[k], cuts[k + 1]);
      const mean = Object.fromEntries(Object.entries(sum).map(([key, v]) => [key, v / count])) as unknown as Feel;
      const d = feelDistance(f, mean);
      // While repeating something, runs change where they changed the first time
      const o0 = origin(cuts[k - 1]), o1 = origin(cuts[k]);
      const q0 = o0 >= 0 ? runAt(o0) : null, q1 = o1 >= 0 ? runAt(o1) : null;
      const following = q0 && q1 && Math.abs(o1 - cuts[k] - (o0 - cuts[k - 1])) < 0.3;
      if (following ? q0 !== q1 : d > RUN_CHANGE || count >= RUN_MAX_BARS || (count % 4 === 0 && d > RUN_PHRASE_CHANGE)) {
        commit(run[0], run[1]);
        run = [cuts[k], cuts[k + 1]];
        sum = f;
        count = 1;
      } else {
        run[1] = cuts[k + 1];
        for (const key of Object.keys(sum) as (keyof Feel)[]) sum[key] += f[key];
        count++;
      }
    }
    commit(run[0], run[1]);
  }
  return runs;
}

export function buildShapesChart(a: TrackAnalysis, difficulty: Difficulty): ShapesChart {
  const p = PARAMS[difficulty];
  const seed0 = seedFor(a) ^ 0x5eed;
  let r = rng(seed0);
  /** Dice for a spot in a run: the same spot in a repeat of it rolls the same, so it lays out the same. */
  const dice = (run: ShapesRun, offset: number) => rng((seed0 ^ Math.imul(run.seed + 1, 0x9e3779b1) ^ Math.imul(offset + 1, 0x85ebca6b)) >>> 0);
  const w = hitWeights(a);
  const sections = shapesSections(a);
  const runs = shapesRuns(a, w, p, sections, r);
  // The heaviest hit of each bar: walls only come on those, so there's at most one per bar
  const barTimes = barStarts(a);
  const barTop = new Set<number>();
  for (let b = 0, i = 0; b + 1 < barTimes.length; b++) {
    let top = -1;
    for (; i < a.onsetTimes.length && a.onsetTimes[i] < barTimes[b + 1]; i++) if (top < 0 || w.heft[i] > w.heft[top]) top = i;
    if (top >= 0) barTop.add(top);
  }
  /** Whether t is on a beat whose position in the bar passes `at` (0 is the downbeat). */
  const onBeat = (t: number, at: (pos: number) => boolean) => {
    const k = Math.min(a.beatTimes.length - 1, lowerTime(a.beatTimes, t));
    for (const j of [k - 1, k]) if (j >= 0 && Math.abs(a.beatTimes[j] - t) < 0.07 && at(a.beatInBar[j])) return true;
    return false;
  };
  const downbeat = (t: number) => onBeat(t, (pos) => pos === 0);

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

  // Cooldowns that are about the music rather than walking time count in beats
  const beat = 60 / a.tempo;

  // ---- Spinners: beams around a drifting pivot, driven by the music, while a sound holds ----
  const pivots = new Map<ShapesRun, (t: number) => [number, number]>();
  /** A pivot and the path of a beam around it from `hit` to `end`. */
  const spin = (hit: number, end: number, dice: () => number) => {
    // The pivot wanders on a slow Lissajous curve around the middle of the arena
    const fx = 0.05 + dice() * 0.06, fy = 0.05 + dice() * 0.06, px = dice() * 6.28, py = dice() * 6.28;
    const pivot = (t: number): [number, number] => [
      0.5 + 0.22 * Math.sin(2 * Math.PI * fx * (t - hit) + px),
      0.5 + 0.2 * Math.sin(2 * Math.PI * fy * (t - hit) + py),
    ];
    // Spin speed follows the loudness; hits kick it forward, the biggest ones reverse it
    const kicks: { t: number; s: number }[] = [];
    for (let i = 0; i < a.onsetTimes.length; i++) {
      const t = a.onsetTimes[i];
      if (t >= hit && t < end && w.prom[i] >= 0.65) kicks.push({ t, s: w.heft[i] });
    }
    let dir = dice() < 0.5 ? -1 : 1;
    let lastFlip = hit;
    let angle = dice() * Math.PI;
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
    return { pivot, path };
  };
  /** Beams on a path; `off` spaces several of them evenly around the pivot. */
  const beamsOn = (path: BeamPath, h: number, e: number, count: number, width: number) => {
    for (let k = 0; k < count; k++) {
      const off = (k * Math.PI) / count;
      push({ kind: 'beam', warn: h - Math.max(p.lead * 1.4, 0.8), hit: h, end: e, x: 0.5, y: 0.5, a0: 0, a1: 0, width, path: { ...path, a: path.a.map((v) => v + off) } });
    }
  };
  for (const s of runs) {
    if (s.theme !== 'spinner' || s.end - s.start < SPINNER_MIN) continue;
    const hit = s.start;
    const roll = dice(s, 0);
    const { pivot, path } = spin(hit, s.end - 0.1, roll);
    pivots.set(s, pivot);
    const beams = difficulty === 'normal' && roll() < 0.5 ? 1 : p.beams;
    for (const [h, e] of beamHolds(a, s.start, s.end)) {
      const i0 = Math.max(0, Math.round((h - hit) / path.step)), i1 = Math.min(path.a.length, Math.round((e - hit) / path.step) + 2);
      if (i1 - i0 < 3) continue;
      beamsOn({ step: path.step, x: path.x.slice(i0, i1), y: path.y.slice(i0, i1), a: path.a.slice(i0, i1) }, h, e, beams, 4.5);
    }
  }

  // ---- Held notes: a beam for as long as the note lasts, whatever the run is playing ----
  const held: { start: number; end: number; pivot: (t: number) => [number, number] }[] = [];
  {
    const phrases: { start: number; end: number; strength: number }[] = [];
    for (let i = 0; i < a.noteStart.length; i++) {
      const start = a.noteStart[i], end = a.noteEnd[i];
      let lvl = 0, c = 0;
      for (let t = start; t < end; t += 0.1) { lvl += sample(a.level, a.fps, t); c++; }
      lvl /= Math.max(1, c);
      if (lvl < NOTE_BEAM_LEVEL || a.noteStrength[i] * (0.5 + lvl) < NOTE_BEAM_STRENGTH) continue;
      const last = phrases[phrases.length - 1];
      if (last && start - last.end <= NOTE_JOIN) {
        last.end = end;
        last.strength = Math.max(last.strength, a.noteStrength[i]);
      } else phrases.push({ start, end, strength: a.noteStrength[i] });
    }
    for (const q of phrases) {
      if (q.end - q.start < NOTE_BEAM_MIN) continue;
      // A build holds back for its drop, and a spinner already has beams of its own
      if (sections[sectionIndexAt(sections, q.start)].role === 'build') continue;
      if (runs.some((s) => s.theme === 'spinner' && s.start < q.end && s.end > q.start)) continue;
      const run = runs[sectionIndexAt(runs, q.start)];
      const h = snapToHit(a, q.start, 0.1);
      const { pivot, path } = spin(h, q.end, dice(run, 1000 + Math.round((q.start - run.start) / beat)));
      beamsOn(path, h, q.end, q.strength >= NOTE_CROSS && difficulty !== 'easy' ? 2 : 1, 3.5 + 3.5 * q.strength);
      held.push({ start: h, end: q.end, pivot });
    }
  }

  // The music's intensity at the hit being placed stretches the budget (quiet passages thin
  // out, loud ones get the full load) and speeds up anything that flies
  let inten = 0;
  let scale = 1;
  const pace = () => 0.8 + 0.5 * inten;

  // ---- Ray bursts: short beams fanning out of the spinner's pivot on big hits ----
  let lastBurst = -Infinity;
  const burst = (t: number, pivot?: (t: number) => [number, number]) => {
    if (!pivot || t - lastBurst < (BURST_BEATS - inten) * beat || budget.left(t, scale) < cost('bar')) return false;
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
  const ring = (t: number, x: number, y: number, force = false) => {
    const n = 6 + Math.round(4 * heft) + (difficulty === 'hard' ? 2 : 0);
    if (difficulty === 'easy' || (!force && budget.left(t, scale) < cost('shot') * n)) return;
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
    if (t - lastSeeker < p.seekerBeats * beat || budget.left(t, scale) < cost('bomb')) return false;
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
    // A new bar turns the trail a quarter, so its path follows the bars
    if (downbeat(t)) {
      const turn = r() < 0.5 ? 1 : -1;
      trail = { ...trail, dx: -trail.dy * turn, dy: trail.dx * turn };
    }
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

  // ---- Grid: half the arena flashes on the bar's big hit, the other half on the next bar's, then
  // it rests for a while (the run's other attacks carry on) ----
  let gridFree = -Infinity;
  let gridParity: 0 | 1 = 0;
  let gridOpen = false;
  let gridLast = -Infinity;
  const grid = (t: number) => {
    // Warned long enough to walk off a cell, with walking time after the last flash too
    const walk = GRID_CELL / 2 / PLAYER_SPEED + p.reaction;
    if (difficulty === 'easy' || t < gridFree || budget.left(t, scale) < cost('grid')) return false;
    // Only a flash right after the last one answers it; otherwise this one opens a new pair
    const answer = gridOpen && t - gridLast <= 2 * 4 * beat;
    gridParity = gridParity ? 0 : 1;
    push({ kind: 'grid', warn: warnFor(t, GRID_CELL / 2), hit: t, end: t + GRID_LIFE, cell: GRID_CELL, parity: gridParity, fill: 0.92 });
    gridFree = t + GRID_LIFE + walk;
    // (the bars' heaviest hits wobble around the bar line, hence the slack)
    if (answer) gridFree = Math.max(gridFree, t + (GRID_REST_BARS + 1) * 4 * beat - 0.1);
    gridOpen = !answer;
    gridLast = t;
    return true;
  };

  // ---- Snap: when the music comes back from a rest, pop-ups warned all through the silence land
  // on the return hit, the first bursting into a ring ----
  const snap = (t: number, from: number) => {
    const n = difficulty === 'easy' ? 2 : difficulty === 'hard' ? 4 : 3;
    const placed: [number, number][] = [];
    for (let k = 0; k < n; k++) {
      let bx = 0.5, by = 0.5, best = -1;
      for (let c = 0; c < 6; c++) {
        const x = spot(), y = spot();
        const d = placed.reduce((m, [px, py]) => Math.min(m, Math.hypot(px - x, py - y)), 2);
        if (d > best) { best = d; bx = x; by = y; }
      }
      placed.push([bx, by]);
      const size = Math.min(MAX_POP_RADIUS, 6 + 8 * heft);
      const warn = Math.min(from, warnFor(t, size));
      if (k % 2) push({ kind: 'box', warn, hit: t, end: t + 0.45, x: bx, y: by, size: size * 1.6, rot: r() * Math.PI, spin: (r() < 0.5 ? -1 : 1) * 2 });
      else push({ kind: 'bomb', warn, hit: t, end: t + 0.45, x: bx, y: by, r: size });
    }
    ring(t, placed[0][0], placed[0][1], true);
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
  const voiceOf = (i: number): Voice => a.onsetLowness[i] > KICK_LOW ? 'kick'
    : a.onsetBrightness[i] > HAT_BRIGHT && a.onsetLowness[i] < HAT_LOW ? 'hat' : 'snare';
  /** Whether hit i moves the steps march in this run. */
  const steps = (i: number, run: ShapesRun) => w.prom[i] >= 0.45 && (run.kicks >= STEP_KICKS ? voiceOf(i) === 'kick' : onBeat(a.onsetTimes[i], (pos) => pos % 2 === 0));
  let runIndex = -1;
  let stepsSinceTurn = 0;
  let slammed = -1;
  let lastVolley = -Infinity;
  const rests = findRests(a);
  let restIndex = 0;

  for (let i = 0; i < a.onsetTimes.length; i++) {
    const t = a.onsetTimes[i];
    const prom = w.prom[i];
    inten = w.inten[i];
    const si = sectionIndexAt(sections, t);
    const sec = sections[si];
    // The music snaps back from a rest (on a drop, the drop's slam is the snap)
    while (restIndex < rests.length && rests[restIndex][1] < t) restIndex++;
    const rest = rests[restIndex];
    if (rest && rest[1] === t && !(sec.role === 'drop' && t - sec.start < 0.5)) {
      heft = Math.max(w.heft[i], HEAVY);
      snap(t, rest[0]);
      continue;
    }
    // Nothing new while the music holds its breath
    if (rest && t > rest[0] && t < rest[1]) continue;
    // Near silence, only the hits that stand out
    if (t < 1.5 || prom < (inten < 0.1 ? 0.45 : p.shotMin)) continue;
    const build = sec.role === 'build';
    const ri = sectionIndexAt(runs, t);
    const run = runs[ri];
    // Dice from the hit's place in its run (16th notes): a repeat of the run lays out the same, and
    // a hit only one of them has doesn't throw off the rest
    r = dice(run, ri === runIndex ? 1 + Math.round((t - run.start) / (beat / 4)) : 0);
    if (ri !== runIndex) {
      // Fresh run: new lane orientation, starting side and trail
      runIndex = ri;
      stepAxis = r() < 0.5 ? 'h' : 'v';
      stepDir = r() < 0.5 ? 1 : -1;
      step = stepDir > 0 ? 0 : STEP_LANES - 1;
      stepsSinceTurn = 0;
      alt = 0;
      volleyCount = 0;
      lastGap = 0.5;
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
    const voice = voiceOf(i);
    scale = (0.3 + 0.9 * inten) * (build ? BUILD_BUDGET : 1);
    const left = budget.left(t, scale);
    // In a dense stream, a lesser hit leaves room for a clearly bigger one right behind it
    if (!big) {
      let ahead = false;
      for (let j = i + 1; j < a.onsetTimes.length && a.onsetTimes[j] - t < 0.2; j++) {
        if (w.prom[j] >= p.bigAt && w.heft[j] > heft + 0.15) ahead = true;
      }
      if (ahead && left < COST.bar * 2) continue;
    }
    // Under a held note its beam is the main thing: the hits fire around it as they do in a spinner
    const note = held.find((q) => t >= q.start - 0.1 && t < q.end);
    const idle = !note && t - lastSpawn > p.idleMax * (1 + 1.5 * (1 - inten));
    const before = hazards.length;

    // A drop opens on its first beat with a cross of bars, bursting into shots where they meet
    // (the build before it saved up the budget for that)
    if (sec.role === 'drop' && si !== slammed && t - sec.start < 0.5) {
      slammed = si;
      heft = Math.max(heft, SLAM);
      if (fullBar(t, 'h', false, 1.1)) {
        const y = (hazards[hazards.length - 1] as { at: number }).at;
        if (fullBar(t, 'v', false, 1.1)) ring(t, (hazards[hazards.length - 1] as { at: number }).at, y, true);
      }
      continue;
    }
    // A build holds back for the drop: only the standout hits, mostly a trail stepping along
    // with the roll, now and then a volley
    if (build) {
      if (prom >= BUILD_PROM || idle) {
        if (big && p.volleys && t - lastVolley >= BUILD_VOLLEY_BEATS * beat) { volley(t); lastVolley = t; }
        else trailBomb(t);
      }
      continue;
    }

    // The beam landing is this hit's attack
    if (note && Math.abs(t - note.start) <= 0.1) continue;

    // Every theme gives each voice its own attack; weak hits only ever get light ones
    switch (note ? 'spinner' : run.theme) {
      case 'field':
        if (heavy && left >= cost('bar') && fullBar(t, alt++ % 2 ? 'h' : 'v', homing)) break;
        if (weak || voice === 'hat') { if (difficulty !== 'easy') trailBomb(t); }
        else if (voice === 'kick') pop(t, big);
        else if (!seeker(t)) pop(t, big);
        break;

      case 'bars':
        if (weak || voice === 'hat') { if (p.volleys) volley(t); break; }
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
        // The march is the kick line: it steps on kicks (on beats 1 and 3 when there are few)
        // and pauses when they do; the other voices get their own attacks around it
        if (!steps(i, run)) {
          if (heavy && left >= cost('bar')) fullBar(t, stepAxis === 'h' ? 'v' : 'h', false);
          else if (mid && voice === 'snare') pop(t, big, Math.ceil(p.pops / 2));
          else if (p.volleys && left >= COST.bar * 1.5) volley(t);
          break;
        }
        // A lane only goes solid once the previous one is gone (plus some slack): the march
        // can't turn into a solid block the player has to dash through when hits come in a burst.
        // Lanes are shorter-lived in intense parts, so the march keeps up with fast music
        if (left < cost('bar') || t < stepFree) break;
        // Each lane goes away just before the march's next step lands, so the march can step on
        // every one and still never has two lanes solid at once
        let life = STEP_LIFE * (1.15 - 0.45 * inten);
        for (let j = i + 1; j < a.onsetTimes.length && a.onsetTimes[j] < t + life + p.stepSlack; j++) {
          if (steps(j, run) && a.onsetTimes[j] - t >= STEP_MIN + p.stepSlack) { life = a.onsetTimes[j] - t - p.stepSlack; break; }
        }
        stepFree = t + life + p.stepSlack;
        // The march turns around on a new bar (once it has gone a few lanes), so it phrases with
        // the music instead of just sweeping edge to edge
        if (downbeat(t) && stepsSinceTurn >= STEP_LANES / 2) {
          stepDir = -stepDir;
          step += 2 * stepDir;
          stepsSinceTurn = 0;
        }
        const span = 1 / STEP_LANES;
        push({ kind: 'bar', warn: warnFor(t, (span * MAX_SPAN) / 2), hit: t, end: t + life, axis: stepAxis, at: (step + 0.5) * span, width: 0, span: span * 0.92, target: false });
        step += stepDir;
        stepsSinceTurn++;
        if (step < 0 || step >= STEP_LANES) {
          // Bounce back from the edge, turning the march around
          stepDir = -stepDir;
          step += 2 * stepDir;
          stepsSinceTurn = 0;
        }
        break;
      }

      case 'walls': {
        // Walls don't scale with speed fully: a wall much faster than the player can only be dashed
        const dur = (3.6 - 1.0 * sec.energy) / Math.sqrt(p.speed);
        // (the bars' heaviest hits wobble around the bar line, hence the slack)
        if (heavy && barTop.has(i) && t - lastWall > Math.max(WALL_GAP_MIN, p.wallBars * 4 * beat - 0.1) && left >= cost('wall')) {
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
        } else if (mid && voice === 'snare') {
          pop(t, big, Math.ceil(p.pops / 2));
        } else if (difficulty !== 'easy' && voice !== 'kick') {
          trailBomb(t);
        }
        break;
      }

      case 'spinner':
        // The beams sweep the arena while the sound holds; the hits fire around them
        if (heavy && burst(t, note?.pivot ?? pivots.get(run))) break;
        if (mid && voice !== 'hat' && pop(t, big, Math.ceil(p.pops / 2))) break;
        if (voice === 'hat' && (difficulty === 'hard' || (difficulty === 'normal' && inten > 0.5))) trailBomb(t);
        break;

      case 'grid':
        // The bar's big hit flashes the grid, kicks and snares pop up, hats trail
        if (heavy && barTop.has(i) && grid(t)) break;
        if (mid && voice !== 'hat') pop(t, big, Math.ceil(p.pops / 2));
        else if (voice === 'hat' && difficulty !== 'easy') trailBomb(t);
        break;

      case 'rain':
        // Hats and snares rain down, kicks drop seekers, the big hits pop
        if (big) {
          pop(t, true);
        } else if (mid && voice === 'kick' && seeker(t)) {
          // Seeker placed
        } else if (voice !== 'kick' && left >= cost('shot')) {
          const speed = (34 + 24 * heft) * p.speed * pace();
          push({ kind: 'shot', warn: t - p.lead * 0.6, hit: t, end: t + 260 / speed, x: spot(), y: -0.02, angle: Math.PI / 2 + (r() - 0.5) * 0.3, speed, r: 1.2 + 1.6 * heft });
        }
        break;
    }

    // Nothing for a while and this hit didn't spawn anything either: fill the silence (longer
    // silences are fine when the music is calm)
    if (idle && hazards.length === before) {
      if (p.volleys && (run.theme === 'bars' || run.theme === 'steps')) volley(t);
      else trailBomb(t);
    }
  }

  // Whatever is solid when the music stops freezes until it comes back
  for (const [s0, s1] of rests) {
    for (const hz of hazards) {
      if (hz.hit < s0 && hz.end > s0 && !hz.freeze) {
        hz.freeze = [s0, s1];
        hz.end += s1 - s0;
      }
    }
  }
  hazards.sort((x, y) => x.warn - y.warn);

  // The arena is sized by how much of it the attacks cover: it shrinks around the few there
  // are when it's calm and grows as they pile up, looking a little ahead so it's out in time
  const n = Math.ceil(a.duration * ZOOM_RATE) + 2;
  const cover: Coverage[] = Array.from({ length: n }, () => ({ fixed: 0, line: 0, blob: 0 }));
  const biggest = new Float32Array(n);
  const H = 100, W = 100 * ARENA_ASPECT;
  for (const h of hazards) {
    const c: Coverage = { fixed: 0, line: 0, blob: 0 };
    const extent = h.kind === 'bomb' || h.kind === 'shot' ? h.r * 2 : h.kind === 'box' ? h.size * Math.SQRT2 : h.kind === 'bar' && !h.span ? h.width : 0;
    switch (h.kind) {
      case 'bomb': case 'shot': c.blob = (Math.PI * h.r * h.r) / (W * H); break;
      case 'box': c.blob = (h.size * h.size) / (W * H); break;
      case 'bar': if (h.span) c.fixed = h.span; else c.line = h.width / (h.axis === 'h' ? H : W); break;
      case 'wall': c.line = h.width / (h.axis === 'h' ? H : W); break;
      case 'beam': c.line = (h.width * Math.hypot(W, H)) / (W * H); break;
      // Its cells fit whatever the area is and it's gone in a blink: no reason to zoom out for it
      case 'grid': break;
    }
    for (let i = Math.max(0, Math.floor(h.warn * ZOOM_RATE)); i < Math.min(n, Math.ceil(h.end * ZOOM_RATE)); i++) {
      cover[i].fixed += c.fixed;
      cover[i].line += c.line;
      cover[i].blob += c.blob;
      biggest[i] = Math.max(biggest[i], extent);
    }
  }
  // Builds squeeze the arena in, closer the nearer the drop, so the drop bursts it open
  // (and the look ahead stops at the drop, so it doesn't open early)
  const squeeze = new Float32Array(n).fill(ZOOM_WIDE);
  const ahead = new Int32Array(n).fill(n - 1);
  for (const s of sections) {
    if (s.role !== 'build') continue;
    const last = Math.min(n, Math.ceil(s.end * ZOOM_RATE));
    for (let i = Math.floor(s.start * ZOOM_RATE); i < last; i++) {
      const k = Math.min(1, Math.max(0, (i / ZOOM_RATE - s.start) / (s.end - s.start)));
      squeeze[i] = ZOOM_WIDE + (BUILD_SQUEEZE - ZOOM_WIDE) * Math.sqrt(k);
      ahead[i] = last - 1;
    }
  }
  const want = cover.map((c, i) => Math.max(Math.min(squeeze[i], scaleFor(c, COVER, ZOOM_CALM, ZOOM_WIDE)), Math.min(ZOOM_WIDE, biggest[i] / (100 * MAX_SPAN_SHARE))));
  const zoom = zoomCurve(a.duration, (t) => {
    const i = Math.round(t * ZOOM_RATE);
    let m = 0;
    for (let k = i; k <= Math.min(ahead[Math.min(n - 1, i)], i + ZOOM_RATE * 0.75); k++) m = Math.max(m, want[k]);
    return m;
  });
  return { sections, runs, hazards, checkpoints, maxHp: p.hp, dashCooldown: p.dashCooldown, zoom, rests };
}

// ---- Geometry, shared by collisions and drawing ----

export type Geo =
  | { type: 'circle'; x: number; y: number; r: number }
  | { type: 'rect'; x: number; y: number; hw: number; hh: number; rot: number }
  | { type: 'line'; x: number; y: number; angle: number; hw: number };

export interface ArenaInfo {
  /** The screen-filling arena; the play area is this scaled by `scaleAt` around its centre. */
  w: number;
  h: number;
  /** Arena scale at a song time. */
  scaleAt: (t: number) => number;
  /** Player position (world units) locked in when a targeted hazard's warning started. */
  targets: Map<number, [number, number]>;
}

/** The play area at time t: left, top, width, height in world units. */
export function playArea(arena: ArenaInfo, t: number): [number, number, number, number] {
  const s = arena.scaleAt(t);
  return [(arena.w * (1 - s)) / 2, (arena.h * (1 - s)) / 2, arena.w * s, arena.h * s];
}

/** The hazard's own clock: song time, standing still through the rest it froze in. */
function localTime(hz: Hazard, t: number) {
  if (!hz.freeze) return t;
  const [s0, s1] = hz.freeze;
  return t < s0 ? t : t < s1 ? s0 : t - (s1 - s0);
}

/** When the hazard ends on its own clock. */
function endOf(hz: Hazard) {
  return hz.freeze ? hz.end - (hz.freeze[1] - hz.freeze[0]) : hz.end;
}

/** Pop on the beat, then shrink away at the end (on the hazard's own clock). */
function envelope(hz: Hazard, t: number) {
  if (t < hz.hit) return 1;
  const age = t - hz.hit;
  // Lane bars don't pop: they'd spill into the lanes that are meant to be safe
  const pop = age < 0.1 && !(hz.kind === 'bar' && hz.span) ? 1.25 - 2.5 * age : 1;
  const tail = Math.min(1, (endOf(hz) - t) / 0.2);
  return pop * Math.max(0, tail);
}

/** How far through its sweep a wall is at time t, 0..1. */
function wallProgress(hz: Extract<Hazard, { kind: 'wall' }>, t: number) {
  const p = Math.min(1, Math.max(0, (t - hz.hit) / (endOf(hz) - hz.hit)));
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
export function geometry(hz: Hazard, songTime: number, arena: ArenaInfo): Geo[] {
  const t = localTime(hz, songTime);
  // Normalized positions land in the play area as it was when the warning started
  const [ax, ay, w, h] = playArea(arena, hz.warn);
  const X = (n: number) => ax + n * w, Y = (n: number) => ay + n * h;
  const target = arena.targets.get(hz.id);
  const k = envelope(hz, t);
  const big = Math.hypot(arena.w, arena.h) * 2;
  switch (hz.kind) {
    case 'bomb': {
      const [x, y] = hz.target && target ? target : [X(hz.x), Y(hz.y)];
      return [{ type: 'circle', x, y, r: hz.r * k }];
    }
    case 'box': {
      const rot = hz.rot + hz.spin * Math.max(0, t - hz.hit);
      return [{ type: 'rect', x: X(hz.x), y: Y(hz.y), hw: (hz.size / 2) * k, hh: (hz.size / 2) * k, rot }];
    }
    case 'bar': {
      const at = hz.target && target ? (hz.axis === 'h' ? target[1] : target[0]) : hz.axis === 'h' ? Y(hz.at) : X(hz.at);
      const width = hz.span ? hz.span * (hz.axis === 'h' ? h : w) : hz.width;
      const half = (width / 2) * k;
      return hz.axis === 'h'
        ? [{ type: 'rect', x: ax + w / 2, y: at, hw: big, hh: half, rot: 0 }]
        : [{ type: 'rect', x: at, y: ay + h / 2, hw: half, hh: big, rot: 0 }];
    }
    case 'wall': {
      const p = wallProgress(hz, t);
      const span = hz.axis === 'v' ? w : h; // direction of travel
      const across = hz.axis === 'v' ? h : w;
      const o = hz.axis === 'v' ? ax : ay, oa = hz.axis === 'v' ? ay : ax;
      const from = o - hz.width, to = o + span + hz.width;
      const at = hz.from === 0 ? from + (to - from) * p : to - (to - from) * p;
      const g0 = oa + hz.gap * across - hz.gapSize / 2, g1 = oa + hz.gap * across + hz.gapSize / 2;
      const segs: [number, number][] = [[-big, g0], [g1, big]];
      return segs.map(([a, b]) => hz.axis === 'v'
        ? { type: 'rect' as const, x: at, y: (a + b) / 2, hw: hz.width / 2, hh: (b - a) / 2, rot: 0 }
        : { type: 'rect' as const, x: (a + b) / 2, y: at, hw: (b - a) / 2, hh: hz.width / 2, rot: 0 });
    }
    case 'beam': {
      const tail = Math.max(0, Math.min(1, (endOf(hz) - t) / 0.2));
      if (hz.path) {
        const { step, x, y, a } = hz.path;
        const f = Math.min(x.length - 1, Math.max(0, (t - hz.hit) / step));
        const i = Math.min(x.length - 2, Math.floor(f)), u = Math.max(0, f - i);
        const lerp = (v: number[]) => v[i] + (v[i + 1] - v[i]) * u;
        // A section-long spinner's pivot follows the arena as it changes
        const [px, py, pw, ph] = playArea(arena, songTime);
        return [{ type: 'line', x: px + lerp(x) * pw, y: py + lerp(y) * ph, angle: lerp(a), hw: (hz.width / 2) * tail }];
      }
      const p = Math.min(1, Math.max(0, (t - hz.hit) / (endOf(hz) - hz.hit)));
      return [{ type: 'line', x: X(hz.x), y: Y(hz.y), angle: hz.a0 + (hz.a1 - hz.a0) * p, hw: (hz.width / 2) * tail }];
    }
    case 'shot': {
      const d = Math.max(0, t - hz.hit) * hz.speed;
      return [{ type: 'circle', x: X(hz.x) + Math.cos(hz.angle) * d, y: Y(hz.y) + Math.sin(hz.angle) * d, r: hz.r }];
    }
    case 'grid': {
      const cols = Math.max(2, Math.round(w / hz.cell)), rows = Math.max(2, Math.round(h / hz.cell));
      const cw = w / cols, ch = h / rows;
      const geos: Geo[] = [];
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          if ((i + j) % 2 !== hz.parity) continue;
          geos.push({ type: 'rect', x: ax + (i + 0.5) * cw, y: ay + (j + 0.5) * ch, hw: (cw / 2) * hz.fill * Math.min(1, k), hh: (ch / 2) * hz.fill * Math.min(1, k), rot: 0 });
        }
      }
      return geos;
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
