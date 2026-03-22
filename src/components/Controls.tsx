import { useRef, useState } from "react";
import styles from "../styles/Controls.module.css";

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

const IconMusic = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </svg>
);

const IconUpload = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

const IconVolume = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
  </svg>
);

const IconCurve = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
  >
    <path d="M3 20 C6 20 6 4 12 4 C18 4 18 14 21 14" />
  </svg>
);

const IconSpeed = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 2a10 10 0 0 1 7.38 16.75" />
    <path d="M12 2a10 10 0 0 0-7.38 16.75" />
    <line x1="12" y1="12" x2="16" y2="8" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
  </svg>
);

const IconTrash = () => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M9 6V4h6v2" />
  </svg>
);

const IconTextFile = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="8" y1="13" x2="16" y2="13" />
    <line x1="8" y1="17" x2="12" y2="17" />
  </svg>
);

const IconBars = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <line x1="12" y1="20" x2="12" y2="10" />
    <line x1="18" y1="20" x2="18" y2="4" />
    <line x1="6" y1="20" x2="6" y2="16" />
  </svg>
);

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
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
  textSourceName: string | null;
  showVisualizer: boolean;
  onTogglePlay: () => void;
  onSeek: (s: number) => void;
  onLoad: (file: File) => void;
  onVolume: (v: number) => void;
  onPower: (v: number) => void;
  onSpeed: (v: number) => void;
  onLoadText: (file: File) => void;
  onRemoveText: () => void;
  onToggleVisualizer: () => void;
}

export function Controls({
  isPlaying,
  trackName,
  playbackPos,
  duration,
  volume,
  powerExponent,
  speedMultiplier,
  cps,
  intensity,
  textSourceName,
  showVisualizer,
  onTogglePlay,
  onSeek,
  onLoad,
  onVolume,
  onPower,
  onSpeed,
  onLoadText,
  onRemoveText,
  onToggleVisualizer,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const [audioChipDragging, setAudioChipDragging] = useState(false);
  const [textChipDragging, setTextChipDragging] = useState(false);
  const [editingTime, setEditingTime] = useState(false);
  const [editingPower, setEditingPower] = useState(false);
  const [editingSpeed, setEditingSpeed] = useState(false);
  const [editingVolume, setEditingVolume] = useState(false);
  const [timeValue, setTimeValue] = useState(formatTime(playbackPos));
  const [powerValue, setPowerValue] = useState(powerExponent.toString());
  const [speedValue, setSpeedValue] = useState(speedMultiplier.toString());
  const [volumeValue, setVolumeValue] = useState(Math.round(volume * 100).toString());

  const handleAudioDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setAudioChipDragging(false);
    const f = Array.from(e.dataTransfer.files).find((file) =>
      file.type.startsWith("audio/")
    );
    if (f) onLoad(f);
  };

  const handleTextDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setTextChipDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) onLoadText(f);
  };

  const handleTimeChange = (newTime: string) => {
    const s = newTime.trim();
    let secs: number | null = null;
    // "m:ss" or "m:ss.s"
    const colonMatch = s.match(/^(\d+):(\d+(?:\.\d+)?)$/);
    if (colonMatch) {
      secs = parseInt(colonMatch[1]) * 60 + parseFloat(colonMatch[2]);
    }
    // "1m23s" or "1m 23s"
    if (secs === null) {
      const minsSecsMatch = s.match(/^(\d+)\s*m\s*(\d+(?:\.\d+)?)\s*s?$/i);
      if (minsSecsMatch) secs = parseInt(minsSecsMatch[1]) * 60 + parseFloat(minsSecsMatch[2]);
    }
    // plain seconds "83" or "83.5"
    if (secs === null) {
      const plain = parseFloat(s);
      if (!isNaN(plain)) secs = plain;
    }
    if (secs !== null && secs >= 0) onSeek(Math.min(secs, duration));
    setEditingTime(false);
  };

  const handlePowerChange = (newPower: string) => {
    const val = parseFloat(newPower.trim());
    if (!isNaN(val) && val > 0) onPower(val);
    setEditingPower(false);
  };

  const handleSpeedChange = (newSpeed: string) => {
    const s = newSpeed.trim().replace(/x$/i, ""); // strip trailing "x" e.g. "2x"
    const val = parseFloat(s);
    if (!isNaN(val) && val > 0) onSpeed(val);
    setEditingSpeed(false);
  };

  const handleVolumeChange = (newVolume: string) => {
    const s = newVolume.trim().replace(/%$/, ""); // strip trailing "%"
    const val = parseFloat(s);
    if (!isNaN(val) && val >= 0) onVolume(val / 100);
    setEditingVolume(false);
  };

  return (
    <div className={styles.bar}>
      {/* Audio file pill */}
      <div
        className={`${styles.chip} ${audioChipDragging ? styles.chipDragging : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setAudioChipDragging(true);
        }}
        onDragLeave={() => setAudioChipDragging(false)}
        onDrop={handleAudioDrop}
      >
        <button
          onClick={() => fileInputRef.current?.click()}
          className={styles.chipButton}
          title="Load song"
        >
          <IconMusic />
          <span className={styles.chipName}>{trackName}</span>
          <IconUpload />
        </button>
      </div>

      {/* Play/pause */}
      <button
        onClick={onTogglePlay}
        className={styles.playIcon}
        aria-label={isPlaying ? "Pause" : "Play"}
      >
        {isPlaying ? <IconPause /> : <IconPlay />}
      </button>

      {/* Seek */}
      {editingTime ? (
        <input
          type="text"
          className={styles.editInput}
          style={{ fontSize: 11, width: `${timeValue.length || 1}ch` }}
          value={timeValue}
          onChange={(e) => setTimeValue(e.target.value)}
          onBlur={() => handleTimeChange(timeValue)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleTimeChange(timeValue);
            if (e.key === "Escape") setEditingTime(false);
          }}
          autoFocus
        />
      ) : (
        <span
          className={styles.time}
          onClick={() => {
            setTimeValue(formatTime(playbackPos));
            setEditingTime(true);
          }}
          title="Click to edit"
        >
          {formatTime(playbackPos)}
        </span>
      )}
      <input
        type="range"
        className={styles.seekSlider}
        min={0}
        max={duration || 1}
        step={0.1}
        value={playbackPos}
        onChange={(e) => onSeek(parseFloat(e.target.value))}
      />
      <span className={styles.timeStatic}>{formatTime(duration)}</span>

      <div className={styles.divider} />

      {/* Settings sliders */}
      <div className={styles.sliderLabel}>
        <IconVolume />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => onVolume(parseFloat(e.target.value))}
        />
        {editingVolume ? (
          <input
            type="text"
            className={styles.editInput}
            style={{ fontSize: 10, width: `${volumeValue.length || 1}ch` }}
            value={volumeValue}
            onChange={(e) => setVolumeValue(e.target.value)}
            onBlur={() => handleVolumeChange(volumeValue)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleVolumeChange(volumeValue);
              if (e.key === "Escape") setEditingVolume(false);
            }}
            autoFocus
          />
        ) : (
          <span
            className={styles.sliderVal}
            onClick={() => {
              setVolumeValue(Math.round(volume * 100).toString());
              setEditingVolume(true);
            }}
            title="Click to edit"
          >
            {Math.round(volume * 100)}%
          </span>
        )}
      </div>

      <div className={styles.sliderLabel}>
        <IconCurve />
        <input
          type="range"
          min={3.5}
          max={4}
          step={0.1}
          value={powerExponent}
          onChange={(e) => onPower(parseFloat(e.target.value))}
        />
        {editingPower ? (
          <input
            type="text"
            className={styles.editInput}
            style={{ fontSize: 10, width: `${powerValue.length || 1}ch` }}
            value={powerValue}
            onChange={(e) => setPowerValue(e.target.value)}
            onBlur={() => handlePowerChange(powerValue)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handlePowerChange(powerValue);
              if (e.key === "Escape") setEditingPower(false);
            }}
            autoFocus
          />
        ) : (
          <span
            className={styles.sliderVal}
            onClick={() => {
              setPowerValue(powerExponent.toString());
              setEditingPower(true);
            }}
            title="Click to edit"
          >
            {powerExponent}
          </span>
        )}
      </div>

      <div className={styles.sliderLabel}>
        <IconSpeed />
        <input
          type="range"
          min={0.5}
          max={12}
          step={0.5}
          value={speedMultiplier}
          onChange={(e) => onSpeed(parseFloat(e.target.value))}
        />
        {editingSpeed ? (
          <input
            type="text"
            className={styles.editInput}
            style={{ fontSize: 10, width: `${speedValue.length || 1}ch` }}
            value={speedValue}
            onChange={(e) => setSpeedValue(e.target.value)}
            onBlur={() => handleSpeedChange(speedValue)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSpeedChange(speedValue);
              if (e.key === "Escape") setEditingSpeed(false);
            }}
            autoFocus
          />
        ) : (
          <span
            className={styles.sliderVal}
            onClick={() => {
              setSpeedValue(speedMultiplier.toString());
              setEditingSpeed(true);
            }}
            title="Click to edit"
          >
            {speedMultiplier}
          </span>
        )}
      </div>

      <div className={styles.divider} />

      <span className={styles.stat}>
        {cps} cps &nbsp; {intensity.toFixed(3)} intensity
      </span>

      <div className={styles.spacer} />

      <div
        className={`${styles.chip} ${textSourceName ? styles.chipActive : ""} ${textChipDragging ? styles.chipDragging : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setTextChipDragging(true);
        }}
        onDragLeave={() => setTextChipDragging(false)}
        onDrop={handleTextDrop}
      >
        <button
          onClick={() => textInputRef.current?.click()}
          className={styles.chipButton}
          title={
            textSourceName
              ? `Text source: ${textSourceName}`
              : "Load text source"
          }
        >
          <IconTextFile />
          <span className={styles.chipName}>
            {textSourceName ?? "Lorem ipsum"}
          </span>
          {!textSourceName && <IconUpload />}
        </button>
        {textSourceName && (
          <button
            onClick={onRemoveText}
            className={styles.chipTrashBtn}
            title="Remove custom text source"
          >
            <IconTrash />
          </button>
        )}
      </div>

      <button
        onClick={onToggleVisualizer}
        className={styles.iconBtn}
        title={showVisualizer ? "Hide visualizer" : "Show visualizer"}
      >
        <IconBars />
      </button>

      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            onLoad(f);
            e.target.value = "";
          }
        }}
      />
      <input
        ref={textInputRef}
        type="file"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            onLoadText(f);
            e.target.value = "";
          }
        }}
      />
    </div>
  );
}
