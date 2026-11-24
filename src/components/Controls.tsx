import { useRef, useState, type ReactNode } from "react";
import type { AppMode } from "./Settings";
import { formatTime, isAudioFile } from "../format";
import {
  IconBars,
  IconGamepad,
  IconGear,
  IconKeyboard,
  IconMusic,
  IconPause,
  IconPlay,
  IconTextFile,
  IconTrash,
  IconUpload,
  IconVolume,
} from "./icons";
import styles from "../styles/Controls.module.css";

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
  mode: AppMode;
  onModeChange: (mode: AppMode) => void;
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
  mode,
  onModeChange,
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
      isAudioFile(file)
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

      <div className={styles.modeToggle} role="group" aria-label="Mode">
        <button
          className={`${styles.modeBtn} ${mode === "play" ? styles.modeBtnActive : ""}`}
          onClick={() => onModeChange("play")}
          aria-pressed={mode === "play"}
          title="Rhythm game played to the music"
        >
          <IconGamepad />
          <span>Game</span>
        </button>
        <button
          className={`${styles.modeBtn} ${mode === "type" ? styles.modeBtnActive : ""}`}
          onClick={() => onModeChange("type")}
          aria-pressed={mode === "type"}
          title="Typewriter"
        >
          <IconKeyboard />
          <span>Type</span>
        </button>
      </div>

      {mode === "type" && (
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
      )}

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
