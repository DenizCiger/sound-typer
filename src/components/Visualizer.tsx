import { useRef, useImperativeHandle, forwardRef, useEffect } from 'react';
import type { TrackAnalysis } from '../audio/analysis';
import styles from '../styles/Visualizer.module.css';

export interface VisualizerFrame {
  position: number;
  analyser: AnalyserNode | null;
  analysis: TrackAnalysis | null;
  intensityAt: ((pos: number) => number) | null;
  shakeThreshold: number;
}

export interface VisualizerHandle {
  draw: (frame: VisualizerFrame) => void;
}

const BAR_COUNT = 72;
const MIN_HZ = 30;
const MAX_HZ = 16000;
const PAST_SECONDS = 3;
const FUTURE_SECONDS = 1.5;
const TIMELINE_SHARE = 0.42;

let freqBuf: Uint8Array<ArrayBuffer> | null = null;

function drawSpectrum(ctx: CanvasRenderingContext2D, analyser: AnalyserNode | null, w: number, h: number) {
  if (!analyser) return;
  if (!freqBuf || freqBuf.length !== analyser.frequencyBinCount) freqBuf = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(freqBuf);
  const binHz = analyser.context.sampleRate / analyser.fftSize;
  const slot = w / BAR_COUNT;
  for (let i = 0; i < BAR_COUNT; i++) {
    // Log-spaced bars, so bass isn't squeezed into the first two columns
    const f0 = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, i / BAR_COUNT);
    const f1 = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, (i + 1) / BAR_COUNT);
    const k0 = Math.floor(f0 / binHz);
    const k1 = Math.max(k0, Math.min(freqBuf.length - 1, Math.ceil(f1 / binHz) - 1));
    let v = 0;
    for (let k = k0; k <= k1; k++) v = Math.max(v, freqBuf[k]);
    const value = v / 255;
    const barHeight = value * value * h * 0.92;
    ctx.fillStyle = `rgba(255, 255, 255, ${0.1 + value * 0.75})`;
    ctx.fillRect(i * slot + slot * 0.1, h - barHeight, slot * 0.8, barHeight);
  }
}

function drawTimeline(ctx: CanvasRenderingContext2D, f: VisualizerFrame, top: number, w: number, h: number) {
  const { analysis, intensityAt, position, shakeThreshold } = f;
  const span = PAST_SECONDS + FUTURE_SECONDS;
  const xOf = (t: number) => ((t - position + PAST_SECONDS) / span) * w;
  const bottom = top + h;

  ctx.fillStyle = 'rgba(255, 255, 255, 0.025)';
  ctx.fillRect(0, top, w, h);
  if (!analysis || !intensityAt) return;

  // Intensity curve (what the typing speed follows)
  ctx.beginPath();
  ctx.moveTo(0, bottom);
  const step = 2;
  for (let x = 0; x <= w; x += step) {
    const t = position - PAST_SECONDS + (x / w) * span;
    const v = t < 0 || t > analysis.duration ? 0 : intensityAt(t);
    ctx.lineTo(x, bottom - v * h * 0.9);
  }
  ctx.lineTo(w, bottom);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Shake threshold
  const thrY = bottom - shakeThreshold * h * 0.9;
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.beginPath();
  ctx.moveTo(0, thrY);
  ctx.lineTo(w, thrY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Hits: height = strength, bright if they'll trigger a shake
  const { onsetTimes, onsetStrength } = analysis;
  const from = position - PAST_SECONDS, to = position + FUTURE_SECONDS;
  let a = 0, b = onsetTimes.length;
  while (a < b) { const m = (a + b) >> 1; if (onsetTimes[m] < from) a = m + 1; else b = m; }
  for (let i = a; i < onsetTimes.length && onsetTimes[i] <= to; i++) {
    const s = onsetStrength[i];
    if (s < 0.03) continue;
    const x = xOf(onsetTimes[i]);
    const past = onsetTimes[i] <= position;
    const age = position - onsetTimes[i];
    const fresh = past && age < 0.15 ? 1 - age / 0.15 : 0;
    const strong = s >= shakeThreshold;
    ctx.fillStyle = strong
      ? `rgba(255, 255, 255, ${(past ? 0.75 : 0.4) + fresh * 0.25})`
      : `rgba(161, 161, 170, ${past ? 0.5 : 0.25})`;
    const barW = strong ? 3 + fresh * 3 : 2;
    ctx.fillRect(x - barW / 2, bottom - s * h * 0.9, barW, s * h * 0.9);
  }

  // Playhead
  const px = xOf(position);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.fillRect(px - 0.5, top, 1, h);
}

export const Visualizer = forwardRef<VisualizerHandle>((_props, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const draw = (frame: VisualizerFrame) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const dpr = devicePixelRatio;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const timelineH = Math.round(h * TIMELINE_SHARE);
    const gap = 10;
    drawSpectrum(ctx, frame.analyser, w, h - timelineH - gap);
    drawTimeline(ctx, frame, h - timelineH, w, timelineH);
  };

  useImperativeHandle(ref, () => ({ draw }));

  // Draw an empty frame once so the timeline background shows before playback
  useEffect(() => {
    draw({ position: 0, analyser: null, analysis: null, intensityAt: null, shakeThreshold: 1 });
  }, []);

  return <canvas ref={canvasRef} className={styles.canvas} />;
});
