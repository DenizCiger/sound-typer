import { FFT } from './fft';

/**
 * Offline analysis of a whole track. Because we have the decoded audio before playback starts,
 * we can use centered windows (i.e. look-ahead), normalize against the track's own loudness
 * distribution and timestamp every hit precisely, instead of reacting late to a smoothed
 * realtime analyser.
 */
export interface TrackAnalysis {
  /** Feature frames per second. Frame i describes time i / fps. */
  fps: number;
  duration: number;
  /** Track-relative loudness, 0 (quiet for this track / silence) to 1 (loudest parts). */
  level: Float32Array;
  /** Short-term rhythmic activity (smoothed onset novelty), roughly 0..1. */
  activity: Float32Array;
  /** Onset novelty curve, roughly 0..1. Mostly useful for visualisation. */
  novelty: Float32Array;
  /** Detected hits, sorted by time (seconds). */
  onsetTimes: Float32Array;
  /** Perceived strength of each hit, 0..1 (combines spectral flux rank and loudness surprise). */
  onsetStrength: Float32Array;
  /** Share of the hit's energy that sits in the bass band (kick drums ≈ 1, hi-hats ≈ 0). */
  onsetLowness: Float32Array;
  /** Share of the hit's energy above 2.5 kHz (hi-hats and cymbals ≈ 1, kicks ≈ 0). */
  onsetBrightness: Float32Array;
  /** How bright the sound is (spectral centroid), 0 (darkest for this track) to 1 (brightest). Per frame. */
  brightness: Float32Array;
  /**
   * Share of the energy in sustained sound (held notes, pads, vocals) rather than transients
   * (drums), 0..1. Per frame.
   */
  tonal: Float32Array;
  /** Estimated tempo in beats per minute (one per track). */
  tempo: number;
  /** Beat times in seconds, following the tempo with small drift. */
  beatTimes: Float32Array;
  /** Position of each beat in its bar (4/4 assumed): 0 is the downbeat. */
  beatInBar: Uint8Array;
}

export const ANALYSIS_FPS = 100;

const SILENCE_DB = -60;
const MIN_RANGE_DB = 15;
const MAX_RANGE_DB = 40;
const LEVEL_FLOOR = 0.06;

// Band edges in Hz for the spectral flux
const LOW_BAND: [number, number] = [30, 160];
const MID_BAND: [number, number] = [160, 2500];
const FB_MIN_HZ = 30;
const FB_MAX_HZ = 11000;

function percentile(values: ArrayLike<number>, p: number): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

/** Sliding-window median, evaluated every `stride` frames and linearly interpolated. */
function slidingMedian(x: Float32Array, before: number, after: number, stride = 4): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  const buf = new Float64Array(before + after + 1);
  const points: number[] = [];
  const values: number[] = [];
  for (let i = 0; i < n; i += stride) {
    const a = Math.max(0, i - before);
    const b = Math.min(n - 1, i + after);
    const len = b - a + 1;
    for (let j = 0; j < len; j++) buf[j] = x[a + j];
    const view = buf.subarray(0, len).sort();
    points.push(i);
    values.push(view[len >> 1]);
  }
  if (points[points.length - 1] !== n - 1) {
    points.push(n - 1);
    values.push(values[values.length - 1]);
  }
  for (let p = 0; p < points.length - 1; p++) {
    const i0 = points[p], i1 = points[p + 1];
    for (let i = i0; i <= i1; i++) {
      const t = i1 === i0 ? 0 : (i - i0) / (i1 - i0);
      out[i] = values[p] + (values[p + 1] - values[p]) * t;
    }
  }
  return out;
}

/** Approximate K-weighting (ITU-R BS.1770): bass roll-off plus a ~+4 dB presence shelf. */
function kWeight(f: number): number {
  const hp = Math.pow(f / 60, 4);
  const highpass = hp / (1 + hp);
  const shelf = 1 + 1.5 / (1 + Math.exp(-(f - 1700) / 400));
  return highpass * shelf;
}

export function analyzeTrack(samples: Float32Array, sampleRate: number): TrackAnalysis {
  const fps = ANALYSIS_FPS;
  const hop = sampleRate / fps;
  const N = sampleRate <= 24000 ? 1024 : 2048;
  const bins = N / 2 + 1;
  const frames = Math.max(1, Math.ceil(samples.length / hop));
  const fft = new FFT(N);

  const window = new Float64Array(N);
  let winSum = 0, winSq = 0;
  for (let i = 0; i < N; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    winSum += window[i];
    winSq += window[i] * window[i];
  }
  const magNorm = 2 / winSum; // full-scale sine -> magnitude ≈ 1

  const binHz = sampleRate / N;
  const weights = new Float64Array(bins);
  for (let k = 0; k < bins; k++) weights[k] = kWeight(k * binHz);

  // Semitone-spaced filterbank (bands narrower than a bin collapse into one). A ±1 band
  // max filter then tolerates vibrato on any harmonic, unlike a fixed-width bin filter.
  const fbStart: number[] = [];
  for (let j = 0; ; j++) {
    const f = FB_MIN_HZ * Math.pow(2, j / 12);
    if (f > FB_MAX_HZ) break;
    const k = Math.max(1, Math.round(f / binHz));
    if (fbStart.length === 0 || k > fbStart[fbStart.length - 1]) fbStart.push(k);
  }
  const fbBands = fbStart.length - 1;
  const fbCenterHz = Array.from({ length: fbBands }, (_, j) => ((fbStart[j] + fbStart[j + 1] - 1) / 2) * binHz);
  const regionOf = (f: number) => (f < LOW_BAND[1] ? 0 : f < MID_BAND[1] ? 1 : 2);
  const fbRegion = fbCenterHz.map(regionOf);
  const regionCount = [0, 0, 0];
  for (const r of fbRegion) regionCount[r]++;

  const dB = new Float32Array(frames);
  // Per-frame band magnitudes (for the tonal curve and harmony changes) and spectral centroid
  const bandMag = new Float32Array(frames * fbBands);
  const fbOct = fbCenterHz.map((f) => Math.log2(f / FB_MIN_HZ));
  const centroid = new Float32Array(frames);
  const flux = [new Float32Array(frames), new Float32Array(frames), new Float32Array(frames)];

  // Ring of log spectra for the lag-2 SuperFlux-style difference
  const LAG = 2;
  const logSpec = Array.from({ length: LAG + 1 }, () => new Float32Array(fbBands));
  const mag = new Float64Array(bins);
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  for (let t = 0; t < frames; t++) {
    const center = Math.round(t * hop);
    const start = center - N / 2;
    for (let i = 0; i < N; i++) {
      const s = start + i;
      re[i] = s >= 0 && s < samples.length ? samples[s] * window[i] : 0;
      im[i] = 0;
    }
    fft.transform(re, im);

    const cur = logSpec[t % (LAG + 1)];
    let weighted = 0;
    for (let k = 0; k < bins; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      weighted += p * weights[k];
      mag[k] = Math.sqrt(p) * magNorm;
    }
    let cw = 0, cs = 0;
    for (let j = 0; j < fbBands; j++) {
      let m = 0;
      for (let k = fbStart[j]; k < fbStart[j + 1]; k++) m += mag[k];
      m /= fbStart[j + 1] - fbStart[j];
      cur[j] = Math.log10(1 + 1000 * m);
      bandMag[t * fbBands + j] = m;
      // Weighted by the compressed spectrum, so the bass's sheer energy doesn't pin it low
      cw += cur[j] * fbOct[j];
      cs += cur[j];
    }
    centroid[t] = cs > 0 ? cw / cs : 0;
    // Parseval: mean square of the windowed signal, one-sided spectrum
    const ms = (2 * weighted) / (N * winSq);
    dB[t] = 10 * Math.log10(ms + 1e-12);

    if (t >= LAG) {
      const prev = logSpec[(t - LAG) % (LAG + 1)];
      for (let j = 0; j < fbBands; j++) {
        // Max filter over neighbouring bands suppresses vibrato / pitch glides (SuperFlux)
        const ref = Math.max(prev[Math.max(0, j - 1)], prev[j], prev[Math.min(fbBands - 1, j + 1)]);
        const d = cur[j] - ref;
        if (d > 0) flux[fbRegion[j]][t] += d;
      }
      for (let b = 0; b < 3; b++) flux[b][t] /= Math.max(1, regionCount[b]);
    }
  }

  // ---- Loudness, normalized to the track ----
  const audible: number[] = [];
  for (let t = 0; t < frames; t++) if (dB[t] > SILENCE_DB) audible.push(dB[t]);
  const hi = audible.length ? percentile(audible, 0.995) : 0;
  let lo = audible.length ? percentile(audible, 0.03) : -60;
  lo = Math.max(hi - MAX_RANGE_DB, Math.min(lo, hi - MIN_RANGE_DB));

  const level = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    const v = (dB[t] - lo) / (hi - lo);
    // Fade towards zero as we approach digital silence, regardless of track range
    const gate = Math.min(1, Math.max(0, (dB[t] - SILENCE_DB) / 10));
    // Audible-but-quiet passages keep a small floor so they still type, just slowly
    level[t] = (LEVEL_FLOOR + (1 - LEVEL_FLOOR) * Math.min(1, Math.max(0, v))) * gate;
  }

  // ---- Onset novelty: per-band normalized flux ----
  const bandScale = flux.map((f) => {
    const active: number[] = [];
    for (let t = 0; t < frames; t++) if (dB[t] > SILENCE_DB) active.push(f[t]);
    return percentile(active, 0.99);
  });
  const maxScale = Math.max(...bandScale, 1e-9);
  // Don't blow up bands that are basically empty in this track
  const scales = bandScale.map((s) => Math.max(s, maxScale * 0.25));
  const BAND_WEIGHTS = [0.4, 0.4, 0.2];

  const novelty = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    let v = 0;
    for (let b = 0; b < 3; b++) v += BAND_WEIGHTS[b] * (flux[b][t] / scales[b]);
    novelty[t] = v;
  }

  // ---- Peak picking with a centered adaptive threshold (offline => look-ahead is free) ----
  const med = slidingMedian(novelty, 50, 50);
  const PEAK_RADIUS = 3;
  const MIN_GAP = 5; // 50 ms
  const DELTA = 0.07;
  const MASK_FRAMES = 12;
  const MASK_RATIO = 0.75;
  const candidates: { t: number; raw: number }[] = [];
  let last = -Infinity;
  for (let t = 1; t < frames - 1; t++) {
    const v = novelty[t];
    if (dB[t] < SILENCE_DB + 3 && dB[Math.min(frames - 1, t + 3)] < SILENCE_DB + 3) continue;
    let isMax = true;
    for (let j = Math.max(0, t - PEAK_RADIUS); j <= Math.min(frames - 1, t + PEAK_RADIUS); j++) {
      if (novelty[j] > v || (novelty[j] === v && j < t)) { isMax = false; break; }
    }
    if (!isMax) continue;
    let mean = 0, cnt = 0;
    for (let j = Math.max(0, t - 10); j <= Math.min(frames - 1, t + 5); j++) { mean += novelty[j]; cnt++; }
    mean /= cnt;
    const raw = v - med[t];
    if (raw < DELTA || v < mean + DELTA * 0.5) continue;
    const prev = candidates[candidates.length - 1];
    // Post-hit masking: the tail of a big attack (or a vocal swelling in) isn't a new hit
    if (prev && t - prev.t < MASK_FRAMES && raw < prev.raw * MASK_RATIO) continue;
    if (t - last < MIN_GAP) {
      // Keep the stronger of two hits that are too close together
      if (prev && raw > prev.raw) { prev.t = t; prev.raw = raw; last = t; }
      continue;
    }
    candidates.push({ t, raw });
    last = t;
  }

  // ---- Strength: flux rank within the track OR'd with loudness surprise ----
  const raws = Float64Array.from(candidates, (c) => c.raw).sort();
  const rankOf = (raw: number) => {
    let a = 0, b = raws.length;
    while (a < b) { const m = (a + b) >> 1; if (raws[m] < raw) a = m + 1; else b = m; }
    return raws.length > 1 ? a / (raws.length - 1) : 1;
  };
  // Absolute flux floor so a quiet, near-flat track doesn't get "max strength" hits
  const rawRef = Math.max(percentile(raws, 0.9), 1e-9);

  const onsetTimes = new Float32Array(candidates.length);
  const onsetStrength = new Float32Array(candidates.length);
  const onsetLowness = new Float32Array(candidates.length);
  const onsetBrightness = new Float32Array(candidates.length);
  candidates.forEach(({ t, raw }, i) => {
    // Loudness before the hit (avg over 30..300 ms prior) vs. peak right after it
    let before = 0, n = 0;
    for (let j = Math.max(0, t - 30); j <= t - 3; j++) { before += Math.max(dB[j], SILENCE_DB - 20); n++; }
    before = n ? before / n : SILENCE_DB - 20;
    let after = -Infinity;
    for (let j = t; j <= Math.min(frames - 1, t + 6); j++) after = Math.max(after, dB[j]);
    const surpriseDb = Math.max(0, after - before);

    const rank = rankOf(raw);
    const magnitude = Math.min(1, raw / rawRef);
    const fluxPart = 0.85 * Math.pow(rank, 2) * (0.4 + 0.6 * magnitude);
    const surprisePart = Math.min(1, surpriseDb / 20);
    // Probabilistic OR: either a top-ranked hit or a big jump in loudness makes a strong hit
    let strength = 1 - (1 - fluxPart) * (1 - surprisePart);
    // Quiet hits can't be huge, even if they're the most "fluxy" thing around
    let levelAfter = 0;
    for (let j = t; j <= Math.min(frames - 1, t + 6); j++) levelAfter = Math.max(levelAfter, level[j]);
    strength *= 0.35 + 0.65 * Math.min(1, levelAfter * 1.4);

    let lowE = 0, highE = 0, total = 0;
    for (let j = t; j <= Math.min(frames - 1, t + 2); j++) {
      lowE += flux[0][j] / scales[0];
      highE += flux[2][j] / scales[2];
      for (let b = 0; b < 3; b++) total += flux[b][j] / scales[b];
    }

    // Report the hit slightly early: the flux peak lags the true attack by ~half the lag
    onsetTimes[i] = Math.max(0, (t - 1) / fps);
    onsetStrength[i] = Math.min(1, Math.max(0, strength));
    onsetLowness[i] = total > 0 ? lowE / total : 0;
    onsetBrightness[i] = total > 0 ? highE / total : 0;
  });

  // ---- Activity: how busy the rhythm is right now (centered ~250 ms smoothing) ----
  const activity = new Float32Array(frames);
  const ACT_RADIUS = 12;
  let acc = 0;
  for (let t = 0; t < Math.min(frames, ACT_RADIUS); t++) acc += novelty[t];
  for (let t = 0; t < frames; t++) {
    if (t + ACT_RADIUS < frames) acc += novelty[t + ACT_RADIUS];
    if (t - ACT_RADIUS - 1 >= 0) acc -= novelty[t - ACT_RADIUS - 1];
    const span = Math.min(frames - 1, t + ACT_RADIUS) - Math.max(0, t - ACT_RADIUS) + 1;
    activity[t] = Math.min(1, (acc / span) * 2.5);
  }

  const noveltyOut = new Float32Array(frames);
  for (let t = 0; t < frames; t++) noveltyOut[t] = Math.min(1.5, Math.max(0, novelty[t] - med[t]));

  // ---- Brightness: the centroid normalized to the track, held through silence, smoothed ----
  const lit: number[] = [];
  for (let t = 0; t < frames; t++) if (dB[t] > SILENCE_DB + 10) lit.push(centroid[t]);
  const c0 = percentile(lit, 0.05), c1 = Math.max(c0 + 0.5, percentile(lit, 0.95));
  const rawBright = new Float32Array(frames);
  let held = 0.5;
  for (let t = 0; t < frames; t++) {
    if (dB[t] > SILENCE_DB + 10) held = Math.min(1, Math.max(0, (centroid[t] - c0) / (c1 - c0)));
    rawBright[t] = held;
  }
  const brightness = smooth(rawBright, 10);

  const tonal = tonalCurve(bandMag, frames, fbBands, dB);

  // ---- Beats and bars ----
  const { period, beats } = trackBeats(noveltyOut, onsetTimes, fps);
  const lowNorm = new Float32Array(frames);
  for (let t = 0; t < frames; t++) lowNorm[t] = flux[0][t] / scales[0];
  const beatInBar = barPhases(beats, lowNorm, noveltyOut, bandMag, fbBands);

  return {
    fps,
    duration: samples.length / sampleRate,
    level,
    activity,
    novelty: noveltyOut,
    onsetTimes,
    onsetStrength,
    onsetLowness,
    onsetBrightness,
    brightness,
    tonal,
    tempo: (60 * fps) / period,
    beatTimes: Float32Array.from(beats, (b) => b / fps),
    beatInBar,
  };
}

/** Centered moving average over ±radius frames. */
function smooth(x: Float32Array, radius: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  let acc = 0;
  for (let t = 0; t < Math.min(n, radius); t++) acc += x[t];
  for (let t = 0; t < n; t++) {
    if (t + radius < n) acc += x[t + radius];
    if (t - radius - 1 >= 0) acc -= x[t - radius - 1];
    out[t] = acc / (Math.min(n - 1, t + radius) - Math.max(0, t - radius) + 1);
  }
  return out;
}

/**
 * Harmonic/percussive split, cheaply: sustained sound is smooth along time (median over
 * ±TONAL_TIME frames), transients are smooth across frequency (median over ±TONAL_BANDS bands).
 * The tonal share is the harmonic energy against both, smoothed, then normalized to the track
 * (with a minimum range, so a track that never changes stays in the middle).
 */
const TONAL_TIME = 10;
const TONAL_BANDS = 4;
const TONAL_MIN_RANGE = 0.25;
function tonalCurve(bandMag: Float32Array, frames: number, bands: number, dB: Float32Array): Float32Array {
  const raw = new Float32Array(frames);
  const buf = new Float64Array(2 * Math.max(TONAL_TIME, TONAL_BANDS) + 1);
  const median = (len: number) => buf.subarray(0, len).sort()[len >> 1];
  const STRIDE = 2;
  for (let t = 0; t < frames; t += STRIDE) {
    if (dB[t] < SILENCE_DB + 10) continue;
    let h2 = 0, p2 = 0;
    const t0 = Math.max(0, t - TONAL_TIME), t1 = Math.min(frames - 1, t + TONAL_TIME);
    for (let j = 0; j < bands; j++) {
      let len = 0;
      for (let u = t0; u <= t1; u++) buf[len++] = bandMag[u * bands + j];
      const h = median(len);
      len = 0;
      for (let k = Math.max(0, j - TONAL_BANDS); k <= Math.min(bands - 1, j + TONAL_BANDS); k++) buf[len++] = bandMag[t * bands + k];
      const p = median(len);
      h2 += h * h;
      p2 += p * p;
    }
    raw[t] = h2 + p2 > 0 ? h2 / (h2 + p2) : 0;
  }
  for (let t = 1; t < frames; t++) if (t % STRIDE) raw[t] = raw[t - 1];
  const out = smooth(raw, 15);
  const lit: number[] = [];
  for (let t = 0; t < frames; t++) if (dB[t] > SILENCE_DB + 10) lit.push(out[t]);
  const lo = percentile(lit, 0.05), hi = percentile(lit, 0.95);
  const range = Math.max(TONAL_MIN_RANGE, hi - lo), mid = (lo + hi) / 2;
  for (let t = 0; t < frames; t++) out[t] = dB[t] > SILENCE_DB + 10 ? Math.min(1, Math.max(0, 0.5 + (out[t] - mid) / range)) : 0;
  return out;
}

/** Tempo search range, BPM, and the tempo the search leans toward. */
const BPM_MIN = 60;
const BPM_MAX = 200;
const BPM_PRIOR = 120;
/** Width of the tempo prior in octaves. */
const BPM_SPREAD = 1;
/** How strictly beats keep to the tempo (dynamic programming beat tracking). */
const BEAT_TIGHTNESS = 100;

/**
 * Global tempo from the onset curve's autocorrelation (with a prior toward ~120 BPM, and the
 * double period's correlation counted in so a strong half-time doesn't lose to a weak
 * subdivision), then beats by dynamic programming (Ellis 2007): each beat is placed where the
 * onsets are strong and about a period after the one before. Returns beat frames.
 */
function trackBeats(onset: Float32Array, onsetTimes: Float32Array, fps: number): { period: number; beats: number[] } {
  const n = onset.length;
  const minLag = Math.floor((60 * fps) / BPM_MAX), maxLag = Math.ceil((60 * fps) / BPM_MIN);
  if (n < maxLag * 4 || onsetTimes.length < 8) return { period: (60 * fps) / BPM_PRIOR, beats: [] };
  const acf = new Float64Array(2 * maxLag + 2);
  for (let lag = minLag; lag < acf.length && lag < n; lag++) {
    let s = 0;
    for (let t = 0; t + lag < n; t++) s += onset[t] * onset[t + lag];
    acf[lag] = s / (n - lag);
  }
  const prior = (lag: number) => Math.exp(-0.5 * (Math.log2((60 * fps) / lag / BPM_PRIOR) / BPM_SPREAD) ** 2);
  const score = (lag: number) => prior(lag) * (acf[lag] + 0.5 * acf[Math.min(acf.length - 1, 2 * lag)]);
  let best = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) if (score(lag) > score(best)) best = lag;
  // Parabolic interpolation for a fractional period
  const y0 = score(best - 1), y1 = score(best), y2 = score(best + 1);
  const den = y0 - 2 * y1 + y2;
  const period = best + (den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0);

  // Local score: the onset curve, normalized and lightly smoothed
  let mean = 0, sq = 0;
  for (let t = 0; t < n; t++) { mean += onset[t]; sq += onset[t] * onset[t]; }
  mean /= n;
  const std = Math.sqrt(Math.max(1e-12, sq / n - mean * mean));
  const sigma = Math.max(1, period / 32);
  const radius = Math.ceil(sigma * 3);
  const local = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) {
      const u = t + k;
      if (u >= 0 && u < n) s += onset[u] * Math.exp(-0.5 * (k / sigma) ** 2);
    }
    local[t] = s / std;
  }

  const total = new Float64Array(n), from = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2), hi = Math.round(period * 2);
  const penalty = new Float64Array(hi + 1);
  for (let d = lo; d <= hi; d++) penalty[d] = -BEAT_TIGHTNESS * Math.log(d / period) ** 2;
  for (let t = 0; t < n; t++) {
    let bestPrev = -1, bestScore = 0;
    for (let d = lo; d <= hi && t - d >= 0; d++) {
      const sc = total[t - d] + penalty[d];
      if (bestPrev < 0 || sc > bestScore) { bestScore = sc; bestPrev = t - d; }
    }
    total[t] = local[t] + (bestPrev >= 0 ? bestScore : 0);
    from[t] = bestPrev;
  }
  let end = n - 1;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) if (total[t] > total[end]) end = t;
  const beats: number[] = [];
  for (let t = end; t >= 0; t = from[t]) beats.unshift(t);
  // Only where there's music: from half a beat before the first hit to half a beat after the last
  const first = onsetTimes[0] * fps - period / 2, last = onsetTimes[onsetTimes.length - 1] * fps + period / 2;
  return { period, beats: beats.filter((b) => b >= first && b <= last) };
}

/**
 * Evidence needed to switch the downbeat phase (the analysis assumes 4/4); a beat brings ~2.5 on
 * average, so it takes a couple of bars that clearly start elsewhere.
 */
const PHASE_SWITCH = 16;

/**
 * Which beats are downbeats: they tend to have a kick and a change in harmony (chords change
 * on the bar). Every beat votes for the phase that would make it a downbeat; a Viterbi pass
 * over the four phases keeps the phase unless the evidence clearly moves (a bar of 2 or 6).
 */
function barPhases(beats: number[], low: Float32Array, onset: Float32Array, bandMag: Float32Array, bands: number): Uint8Array {
  const m = beats.length;
  const out = new Uint8Array(m);
  if (m < 8) return out;
  const n = low.length;
  const near = (arr: Float32Array, b: number) => {
    let v = 0;
    for (let t = Math.max(0, b - 3); t <= Math.min(n - 1, b + 3); t++) v = Math.max(v, arr[t]);
    return v;
  };
  // Mean log spectrum of each beat's span, and how much it differs from the beat before
  const spans = beats.map((b, k) => {
    const e = k + 1 < m ? beats[k + 1] : Math.min(n, b + (b - beats[k - 1]));
    const v = new Float64Array(bands);
    for (let t = b; t < e; t++) for (let j = 0; j < bands; j++) v[j] += Math.log1p(100 * bandMag[t * bands + j]);
    let norm = 0;
    for (let j = 0; j < bands; j++) norm += v[j] * v[j];
    norm = Math.sqrt(norm) || 1;
    return v.map((x) => x / norm);
  });
  const harm = spans.map((v, k) => {
    if (k === 0) return 0;
    let dot = 0;
    for (let j = 0; j < bands; j++) dot += v[j] * spans[k - 1][j];
    return 1 - dot;
  });
  const lows = beats.map((b) => near(low, b)), hits = beats.map((b) => near(onset, b));
  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length || 1;
  const la = avg(lows), ha = avg(harm), oa = avg(hits);
  const ev = beats.map((_, k) => lows[k] / la + harm[k] / ha + 0.5 * (hits[k] / oa));

  // Viterbi: state p means beat k is at position (k - p) mod 4 in its bar
  const cost = Array.from({ length: m }, () => new Float64Array(4));
  const back = Array.from({ length: m }, () => new Uint8Array(4));
  for (let k = 0; k < m; k++) {
    for (let p = 0; p < 4; p++) {
      const gain = (k - p + 4 * m) % 4 === 0 ? ev[k] : 0;
      if (k === 0) { cost[k][p] = gain; continue; }
      let best = 0, bv = -Infinity;
      for (let q = 0; q < 4; q++) {
        const v = cost[k - 1][q] - (q === p ? 0 : PHASE_SWITCH);
        if (v > bv) { bv = v; best = q; }
      }
      cost[k][p] = bv + gain;
      back[k][p] = best;
    }
  }
  let p = 0;
  for (let q = 1; q < 4; q++) if (cost[m - 1][q] > cost[m - 1][p]) p = q;
  for (let k = m - 1; k >= 0; k--) {
    out[k] = (k - p + 4 * m) % 4;
    p = back[k][p];
  }
  return out;
}
