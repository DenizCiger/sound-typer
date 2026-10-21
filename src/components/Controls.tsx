import { useRef, useState, type ReactNode } from "react";
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

const IconGear = () => (
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
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
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

interface SliderProps {
  icon: ReactNode;
  title: string;
  min: number;
  max: number;
  step: number;
  value: number;
  /** Display value for the label and the edit box. */
  format: (v: number) => string;
  /** Parses typed input; return null to reject it. */
  parse: (s: string) => number | null;
  onChange: (v: number) => void;
  className?: string;
}

function Slider({ icon, title, min, max, step, value, format, parse, onChange, className }: SliderProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");

  const commit = () => {
    const v = parse(text.trim());
    if (v !== null && !isNaN(v)) onChange(v);
    setEditing(false);
  };

  return (
    <div className={`${styles.sliderLabel} ${className ?? ""}`} title={title}>
      {icon}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      {editing ? (
        <input
          type="text"
          className={styles.editInput}
          style={{ fontSize: 10, width: `${text.length || 1}ch` }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          autoFocus
        />
      ) : (
        <span
          className={styles.sliderVal}
          onClick={() => {
            setText(format(value));
            setEditing(true);
          }}
          title="Click to edit"
        >
          {format(value)}
        </span>
      )}
    </div>
  );
}

const parsePercent = (s: string) => {
  const v = parseFloat(s.replace(/%$/, ""));
  return v >= 0 ? v / 100 : null;
};
const formatPercent = (v: number) => `${Math.round(v * 100)}%`;

interface Props {
  isPlaying: boolean;
  trackName: string;
  status: string | null;
  playbackPos: number;
  duration: number;
  volume: number;
  textSourceName: string | null;
  showVisualizer: boolean;
  onTogglePlay: () => void;
  onSeek: (s: number) => void;
  onLoad: (file: File) => void;
  onVolume: (v: number) => void;
  onLoadText: (file: File) => void;
  onRemoveText: () => void;
  onToggleVisualizer: () => void;
  onOpenSettings: () => void;
}

export function Controls({
  isPlaying,
  trackName,
  status,
  playbackPos,
  duration,
  volume,
  textSourceName,
  showVisualizer,
  onTogglePlay,
  onSeek,
  onLoad,
  onVolume,
  onLoadText,
  onRemoveText,
  onToggleVisualizer,
  onOpenSettings,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const [audioChipDragging, setAudioChipDragging] = useState(false);
  const [textChipDragging, setTextChipDragging] = useState(false);
  const [editingTime, setEditingTime] = useState(false);
  const [timeValue, setTimeValue] = useState(formatTime(playbackPos));

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

  return (
    <div className={styles.bar}>
      {/* Audio file pill */}
      <div
        className={`${styles.chip} ${styles.trackChip} ${audioChipDragging ? styles.chipDragging : ""}`}
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
          <span className={styles.chipName}>{status ?? trackName}</span>
          <IconUpload />
        </button>
      </div>

      <div className={styles.transport}>
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
      </div>

      <div className={styles.divider} />

      <Slider
        icon={<IconVolume />}
        title="Volume"
        min={0}
        max={1}
        step={0.01}
        value={volume}
        format={formatPercent}
        parse={parsePercent}
        onChange={onVolume}
        className={styles.volume}
      />
      <div className={styles.spacer} />

      <div
        className={`${styles.chip} ${styles.textChip} ${textSourceName ? styles.chipActive : ""} ${textChipDragging ? styles.chipDragging : ""}`}
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

      <button
        onClick={onOpenSettings}
        className={styles.iconBtn}
        title="Settings"
      >
        <IconGear />
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
