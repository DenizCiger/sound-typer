import styles from '../styles/Controls.module.css';

const IconPlay = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
    <polygon points="2,1 11,6 2,11" />
  </svg>
);

const IconPause = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
    <rect x="2" y="1" width="3" height="10" rx="1" />
    <rect x="7" y="1" width="3" height="10" rx="1" />
  </svg>
);

const IconReset = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 6.5a4.5 4.5 0 1 1 1.2 3" />
    <polyline points="2,3.5 2,6.5 5,6.5" />
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

interface Props {
  isPlaying: boolean;
  trackName: string;
  volume: number;
  powerExponent: number;
  speedMultiplier: number;
  cps: number;
  intensity: number;
  onTogglePlay: () => void;
  onReset: () => void;
  onVolume: (v: number) => void;
  onPower: (v: number) => void;
  onSpeed: (v: number) => void;
}

export function Controls({
  isPlaying, trackName, volume, powerExponent, speedMultiplier,
  cps, intensity, onTogglePlay, onReset, onVolume, onPower, onSpeed,
}: Props) {
  return (
    <div className={styles.controls}>
      <button onClick={onTogglePlay} className={styles.iconBtn}>
        {isPlaying ? <IconPause /> : <IconPlay />}
        {isPlaying ? 'Pause' : 'Play'}
      </button>
      <button onClick={onReset} className={styles.iconBtn}>
        <IconReset />
        Reset
      </button>

      <div className={styles.divider} />

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

      <span className={styles.stat}>{cps} chars/s &nbsp; {intensity.toFixed(3)}</span>
      <span className={styles.trackName}>{trackName}</span>
    </div>
  );
}
