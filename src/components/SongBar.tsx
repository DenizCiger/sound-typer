import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { TrackAnalysis } from '../audio/analysis';
import { intensityAt } from '../game/common';
import { formatTime } from '../format';
import { IconPause, IconPlay } from './icons';
import styles from '../styles/SongBar.module.css';

export interface SongBarHandle {
  /** Moves the playhead. Called every frame, so it doesn't go through React. */
  update: (pos: number) => void;
}

interface SongBarProps {
  analysis: TrackAnalysis;
  /** Song positions a death rewinds to, starting with 0; none in Bullet hell. */
  checkpoints: readonly number[];
  isPlaying: boolean;
  /** Shown in full: not only while the cursor is on it. */
  open: boolean;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  /** The playhead is being dragged. */
  onScrub: (scrubbing: boolean) => void;
}

const WAVE_POINTS = 240;
const WAVE_SAMPLES = 12;
/** Pixels around a checkpoint in which a click lands exactly on it. */
const SNAP_PX = 7;

/**
 * Outline of how intense the song is over time, in a WAVE_POINTS x 100 box. Stretched over the
 * song's own range, so its parts stand out even where it's mastered loud throughout.
 */
function waveOutline(a: TrackAnalysis) {
  const v: number[] = [];
  for (let i = 0; i < WAVE_POINTS; i++) {
    // Several moments each: a single one could fall on a beat or between two
    let sum = 0;
    for (let k = 0; k < WAVE_SAMPLES; k++) sum += intensityAt(a, ((i + k / WAVE_SAMPLES) / WAVE_POINTS) * a.duration);
    v.push(sum / WAVE_SAMPLES);
  }
  const sorted = [...v].sort((x, y) => x - y);
  const lo = sorted[Math.floor(0.03 * WAVE_POINTS)], hi = sorted[Math.floor(0.98 * WAVE_POINTS)];
  const points = v.map((x, i) => {
    const k = Math.min(1, Math.max(0, (x - lo) / Math.max(1e-3, hi - lo)));
    const y = (96 - 88 * k).toFixed(1);
    return `${i},${y} ${i + 1},${y}`;
  });
  return `0,100 ${points.join(' ')} ${WAVE_POINTS},100`;
}

/** Playback bar of game mode: a thin progress line that opens into the song's outline to jump around in. */
export const SongBar = forwardRef<SongBarHandle, SongBarProps>(({
  analysis, checkpoints, isPlaying, open, onTogglePlay, onSeek, onScrub,
}, ref) => {
  const barRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const posRef = useRef(0);
  const [hover, setHover] = useState<{ t: number; snapped: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const { duration } = analysis;
  const outline = useMemo(() => waveOutline(analysis), [analysis]);
  const share = (t: number) => `${(100 * t) / Math.max(1e-3, duration)}%`;

  useImperativeHandle(ref, () => ({
    update(position: number) {
      const bar = barRef.current;
      if (!bar) return;
      const pos = Math.min(position, duration);
      posRef.current = pos;
      // The stretch from the checkpoint you'd rewind to up to the next one (or the end)
      let from = 0, to = checkpoints.length > 0 ? duration : 0;
      for (const c of checkpoints) {
        if (c <= pos) from = c;
        else { to = c; break; }
      }
      bar.style.setProperty('--progress', share(pos));
      bar.style.setProperty('--segment-from', share(from));
      bar.style.setProperty('--segment-to', share(to));
      bar.setAttribute('aria-valuenow', String(Math.round(pos)));
      bar.setAttribute('aria-valuetext', formatTime(pos));
      for (const el of bar.querySelectorAll<HTMLElement>('[data-at]')) {
        el.toggleAttribute('data-reached', Number(el.dataset.at) <= pos);
      }
      if (timeRef.current) timeRef.current.textContent = formatTime(pos);
    },
  }));

  const at = (clientX: number) => {
    const rect = barRef.current!.getBoundingClientRect();
    const x = Math.min(rect.width, Math.max(0, clientX - rect.left));
    const perPx = duration / Math.max(1, rect.width);
    // The very end would finish the song right away
    let t = Math.min(x * perPx, Math.max(0, duration - 0.5)), best = SNAP_PX * perPx, snapped = false;
    for (const c of checkpoints) {
      const d = Math.abs(c - x * perPx);
      if (d < best) { best = d; t = c; snapped = true; }
    }
    return { t, snapped };
  };

  const drag = (on: boolean) => {
    draggingRef.current = on;
    setDragging(on);
    onScrub(on);
  };

  const endDrag = (e: React.PointerEvent, seek: boolean) => {
    if (!draggingRef.current) return;
    drag(false);
    if (seek) onSeek(at(e.clientX).t);
    if (e.pointerType !== 'mouse') setHover(null);
  };

  return (
    <div className={`${styles.row} ${open || dragging ? styles.open : ''}`}>
      <button
        className={styles.playBtn}
        // Keeps the focus off it, so Space doesn't click it again
        onMouseDown={(e) => e.preventDefault()}
        onClick={onTogglePlay}
        title={isPlaying ? 'Pause (Esc)' : 'Play (Esc)'}
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? <IconPause /> : <IconPlay />}
      </button>
      <span ref={timeRef} className={styles.time}>0:00</span>
      <div
        ref={barRef}
        className={styles.bar}
        role="slider"
        tabIndex={0}
        aria-label="Song position"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={0}
        onKeyDown={(e) => {
          // Only when reached by tabbing: a click never focuses it, and while playing the arrows play
          if (isPlaying) return;
          const step = e.key === 'ArrowRight' ? 5 : e.key === 'ArrowLeft' ? -5 : 0;
          if (!step) return;
          e.preventDefault();
          e.stopPropagation();
          onSeek(Math.min(duration - 0.5, Math.max(0, posRef.current + step)));
        }}
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag(true);
          const h = at(e.clientX);
          setHover(h);
          // Paused, dragging shows every place on the way; playing, it would only stutter
          if (!isPlaying) onSeek(h.t);
        }}
        onPointerMove={(e) => {
          const h = at(e.clientX);
          if (e.pointerType === 'mouse' || draggingRef.current) setHover(h);
          if (draggingRef.current && !isPlaying) onSeek(h.t);
        }}
        onPointerUp={(e) => endDrag(e, true)}
        onPointerCancel={(e) => endDrag(e, false)}
        // However it ends, the menu mustn't stay hidden
        onLostPointerCapture={(e) => endDrag(e, false)}
        onPointerLeave={() => { if (!draggingRef.current) setHover(null); }}
      >
        <div className={styles.track}>
          <svg className={styles.wave} viewBox={`0 0 ${WAVE_POINTS} 100`} preserveAspectRatio="none" aria-hidden="true">
            <polygon points={outline} />
          </svg>
          <svg className={`${styles.wave} ${styles.wavePlayed}`} viewBox={`0 0 ${WAVE_POINTS} 100`} preserveAspectRatio="none" aria-hidden="true">
            <polygon points={outline} />
          </svg>
          <div className={styles.segment} />
          <div className={styles.fill} />
          {checkpoints.filter((c) => c > 0).map((c) => (
            <span key={c} data-at={c} className={styles.checkpoint} style={{ left: share(c) }} />
          ))}
          <div className={styles.head} />
        </div>
        {hover && (
          <>
            <div className={styles.cursor} style={{ left: share(hover.t) }} />
            <div className={styles.tip} style={{ left: share(hover.t) }}>
              {hover.snapped && (hover.t === 0 ? 'Start ' : 'Checkpoint ')}{formatTime(hover.t)}
            </div>
          </>
        )}
      </div>
      <span className={styles.time}>{formatTime(duration)}</span>
    </div>
  );
});
