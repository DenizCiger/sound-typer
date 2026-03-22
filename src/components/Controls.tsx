import { useRef } from 'react';
import styles from '../styles/Controls.module.css';

const IconPlay = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
    <polygon points="2,1 11,6 2,11" />
  </svg>
);

const IconPause = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
    <rect x="2" y="1" width="3" height="10" rx="1" />
    <rect x="7" y="1" width="3" height="10" rx="1" />
  </svg>
);

const IconLoad = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

const IconVolume = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
  </svg>
);

const IconCurve = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
    <path d="M3 20 C6 20 6 4 12 4 C18 4 18 14 21 14" />
  </svg>
);

const IconSpeed = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a10 10 0 0 1 7.38 16.75" />
    <path d="M12 2a10 10 0 0 0-7.38 16.75" />
    <line x1="12" y1="12" x2="16" y2="8" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
  </svg>
);

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

interface Props {
  isPlaying: boolean;
  trackName: string;
  playbackPos: number;
  duration: number;
  volume: number;
  powerExponent: number;
  speedMultiplier: number;
  cps: number;
  intensity: number;
  onTogglePlay: () => void;
  onSeek: (s: number) => void;
  onLoad: (file: File) => void;
  onVolume: (v: number) => void;
  onPower: (v: number) => void;
  onSpeed: (v: number) => void;
}

export function Controls({
  isPlaying, trackName, playbackPos, duration,
  volume, powerExponent, speedMultiplier,
  cps, intensity, onTogglePlay, onSeek, onLoad, onVolume, onPower, onSpeed,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className={styles.bar}>
      {/* Play/pause */}
      <button onClick={onTogglePlay} className={styles.playIcon} aria-label={isPlaying ? 'Pause' : 'Play'}>
        {isPlaying ? <IconPause /> : <IconPlay />}
      </button>

      {/* Seek */}
      <span className={styles.time}>{formatTime(playbackPos)}</span>
      <input
        type="range"
        className={styles.seekSlider}
        min={0}
        max={duration || 1}
        step={0.1}
        value={playbackPos}
        onChange={(e) => onSeek(parseFloat(e.target.value))}
      />
      <span className={styles.time}>{formatTime(duration)}</span>

      <div className={styles.divider} />

      {/* Settings sliders */}
      <label className={styles.sliderLabel}>
        <IconVolume />
        <input type="range" min={0} max={1} step={0.01} value={volume}
          onChange={(e) => onVolume(parseFloat(e.target.value))} />
      </label>

      <label className={styles.sliderLabel}>
        <IconCurve />
        <input type="range" min={3.5} max={4} step={0.1} value={powerExponent}
          onChange={(e) => onPower(parseFloat(e.target.value))} />
        <span className={styles.sliderVal}>{powerExponent}</span>
      </label>

      <label className={styles.sliderLabel}>
        <IconSpeed />
        <input type="range" min={0.5} max={12} step={0.5} value={speedMultiplier}
          onChange={(e) => onSpeed(parseFloat(e.target.value))} />
        <span className={styles.sliderVal}>{speedMultiplier}</span>
      </label>

      <div className={styles.divider} />

      <span className={styles.stat}>{cps} cps &nbsp; {intensity.toFixed(3)}</span>
      <span className={styles.trackName}>{trackName}</span>

      <button onClick={() => fileInputRef.current?.click()} className={styles.iconBtn} title="Load song">
        <IconLoad />
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) { onLoad(f); e.target.value = ''; } }}
      />
    </div>
  );
}
