import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import type { TrackAnalysis } from '../audio/analysis';
import type { Difficulty } from '../game/common';
import { STYLE_OPTIONS, type PlayStyle } from '../game/options';
import { Menu } from './Menu';
import { SongBar, type SongBarHandle } from './SongBar';
import styles from '../styles/Stage.module.css';

/** The song and everything around it that's the same whatever is being played. */
export interface Session {
  analysis: TrackAnalysis | null;
  /** What loading is doing, or why it failed. */
  status: string | null;
  failed: boolean;
  trackName: string;
  isPlaying: boolean;
  /** Where playback is, as the app last showed it. */
  playbackPos: number;
  volume: number;
  style: PlayStyle;
  difficulty: Difficulty;
  /** The typewriter's custom text, null for the default one. */
  textName: string | null;
  showVisualizer: boolean;
  /** The audible position right now. */
  getPosition: () => number;
  onTogglePlay: () => void;
  onPause: () => void;
  onSeek: (seconds: number) => void;
  onVolume: (v: number) => void;
  onStyleChange: (style: PlayStyle) => void;
  onDifficultyChange: (difficulty: Difficulty) => void;
  onLoadFile: (file: File) => void;
  onLoadText: (file: File) => void;
  onRemoveText: () => void;
  onToggleVisualizer: () => void;
  onOpenSettings: () => void;
}

export interface StageHandle {
  /** Moves the song bar's playhead; called every frame. */
  update: (pos: number) => void;
}

interface StageProps {
  session: Session;
  /** Running: no menu. */
  live: boolean;
  /** How the run went, once the song is over. */
  results: [label: string, value: number][] | null;
  /** Song positions to jump between; null without. */
  checkpoints: readonly number[] | null;
  /** Pause when the player can't be at the keys any more. */
  pauseAway: boolean;
  /** Top left corner. */
  hud: ReactNode;
  /** Top right corner, next to the song bar. */
  corner?: ReactNode;
  /** What else can be done with a run that's under way. */
  actions: { label: string; onClick: () => void }[];
  onToggle: () => void;
  onPause: () => void;
  onSeek: (seconds: number) => void;
  /** Keys the stage has no use for; true if it was one of the mode's. */
  onKey?: (e: KeyboardEvent) => boolean;
  children: ReactNode;
}

/** The cursor hides this long after it was last moved while playing. */
const CURSOR_IDLE_MS = 1500;
const TOAST_MS = 1000;
/** Stepping back goes to the checkpoint before if the last one is closer than this, seconds. */
const STEP_BACK_SLACK = 2;
/** How far , and . jump without checkpoints, seconds. */
const STEP_PLAIN = 10;
const NO_CHECKPOINTS: readonly number[] = [];

/**
 * What every mode is played on: the full screen with the song bar on top, the menu whenever it
 * isn't running, and the keys that are about the song (pause, jumping, volume, fullscreen).
 */
export const Stage = forwardRef<StageHandle, StageProps>((props, ref) => {
  const { session, live, results, checkpoints, hud, corner, actions, onToggle, onSeek, children } = props;
  const { analysis, status, isPlaying, volume } = session;
  const outerRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<SongBarHandle>(null);
  const posRef = useRef(0);
  const cursorTimerRef = useRef(0);
  const toastTimerRef = useRef(0);
  const unmutedRef = useRef(0.1);
  const leavingFullscreenRef = useRef(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const underway = !!analysis && !results && session.playbackPos > 0.05;

  useImperativeHandle(ref, () => ({
    update(pos: number) {
      posRef.current = pos;
      barRef.current?.update(pos);
    },
  }), []);

  /** To the previous (-1) or next (1) checkpoint, or a few seconds where there are none. */
  const seekStep = (dir: -1 | 1) => {
    if (!analysis) return;
    const pos = posRef.current;
    if (!checkpoints) {
      onSeek(Math.min(Math.max(0, analysis.duration - 0.5), Math.max(0, pos + dir * STEP_PLAIN)));
      return;
    }
    const next = dir < 0
      ? checkpoints.findLast((c) => c <= pos - STEP_BACK_SLACK) ?? 0
      : checkpoints.find((c) => c > pos + 0.05);
    if (next !== undefined) onSeek(next);
  };

  const setVolume = (v: number) => {
    const clamped = Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
    session.onVolume(clamped);
    setToast(clamped > 0 ? `Volume ${Math.round(clamped * 100)}%` : 'Muted');
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), TOAST_MS);
  };
  // Finer steps where it's quiet: a few percent there are as much as a lot further up
  const stepVolume = (dir: number) => setVolume(volume + dir * (volume + dir * 0.005 < 0.2 ? 0.01 : 0.05));
  const toggleMute = () => {
    if (volume > 0) unmutedRef.current = volume;
    setVolume(volume > 0 ? 0 : unmutedRef.current);
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      leavingFullscreenRef.current = true;
      document.exitFullscreen().catch(() => {});
      return;
    }
    document.documentElement.requestFullscreen().then(() => {
      // Where supported, Esc keeps pausing in fullscreen (hold it to leave)
      const keyboard = (navigator as { keyboard?: { lock?: (keys: string[]) => Promise<void> } }).keyboard;
      keyboard?.lock?.(['Escape']).catch(() => {});
    }).catch(() => {});
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // The settings have the keyboard while they're open
    if (document.querySelector('[aria-modal="true"]') || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.target instanceof HTMLInputElement ? e.target : null;
    if (e.target instanceof HTMLTextAreaElement || (el && el.type !== 'range')) return;
    // Arrows move a focused slider in the menu
    if (el && !live && e.code.startsWith('Arrow')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      // Otherwise a focused button would also get "clicked" by the space key
      (document.activeElement as HTMLElement | null)?.blur();
    }
    if (e.code === 'KeyP' || e.code === 'Escape') {
      if (!e.repeat && (live || underway)) onToggle();
      return;
    }
    if (e.key === ',' || e.key === '.') { seekStep(e.key === ',' ? -1 : 1); return; }
    if (e.key === '+' || e.key === '=' || e.key === '-') { stepVolume(e.key === '-' ? -1 : 1); return; }
    if (e.code === 'KeyM') { if (!e.repeat) toggleMute(); return; }
    if (e.code === 'KeyF') { if (!e.repeat) toggleFullscreen(); return; }
    if (!live) {
      const pick = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
      const option = pick && STYLE_OPTIONS[Number(pick[1]) - 1];
      if (option) { session.onStyleChange(option.value); return; }
    }
    if (props.onKey?.(e)) return;
    if (e.code === 'Space' && !e.repeat) session.onTogglePlay();
  };

  // Always the latest, for the listeners below that are added once
  const latestRef = useRef({ onKeyDown, onPause: props.onPause, pauseAway: props.pauseAway });
  useEffect(() => {
    latestRef.current = { onKeyDown, onPause: props.onPause, pauseAway: props.pauseAway };
  });

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => latestRef.current.onKeyDown(e);
    // Looking elsewhere: the keys don't arrive here any more, so wait
    const pause = () => { if (latestRef.current.pauseAway) latestRef.current.onPause(); };
    const onVisibility = () => { if (document.hidden) pause(); };
    // Where Esc can't be kept from leaving fullscreen, it pauses all the same
    const onFullscreen = () => {
      if (document.fullscreenElement) return;
      if (!leavingFullscreenRef.current) pause();
      leavingFullscreenRef.current = false;
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('blur', pause);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('blur', pause);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('fullscreenchange', onFullscreen);
      clearTimeout(cursorTimerRef.current);
      clearTimeout(toastTimerRef.current);
    };
  }, []);

  // Nothing in the menu keeps the focus once the song runs
  useEffect(() => {
    if (isPlaying) (document.activeElement as HTMLElement | null)?.blur();
  }, [isPlaying]);

  // The cursor is only there while it's being moved
  const showCursor = (e: React.PointerEvent) => {
    const outer = outerRef.current;
    if (e.pointerType !== 'mouse' || !outer) return;
    outer.setAttribute('data-cursor', '');
    clearTimeout(cursorTimerRef.current);
    cursorTimerRef.current = window.setTimeout(() => outer.removeAttribute('data-cursor'), CURSOR_IDLE_MS);
  };

  return (
    <div ref={outerRef} className={`${styles.outer} ${live ? styles.playing : ''}`} onPointerMove={showCursor}>
      <div className={styles.content} onWheel={(e) => { if (e.deltaY) stepVolume(e.deltaY < 0 ? 1 : -1); }}>
        {children}
      </div>

      {analysis && <div className={styles.hud}>{hud}</div>}
      {analysis && corner && <div className={styles.corner}>{corner}</div>}

      {analysis && (
        <SongBar
          ref={barRef}
          analysis={analysis}
          checkpoints={checkpoints ?? NO_CHECKPOINTS}
          isPlaying={isPlaying}
          open={!live}
          onTogglePlay={onToggle}
          onSeek={onSeek}
          onScrub={setScrubbing}
        />
      )}

      {/* Out of the way while the playhead is dragged, to see where it goes */}
      {!live && !scrubbing && (
        <Menu
          session={session}
          title={!analysis ? status ?? 'Load a song to play' : results ? 'Song complete' : underway ? 'Paused' : 'Ready'}
          primary={results ? 'Play again' : underway ? 'Resume' : 'Start'}
          results={results}
          actions={underway ? actions : []}
          hasCheckpoints={session.style !== 'bullets' && session.style !== 'type'}
          onVolume={session.onVolume}
          onToggleMute={toggleMute}
          onFullscreen={toggleFullscreen}
        />
      )}

      {toast && <div className={styles.toast} role="status">{toast}</div>}
    </div>
  );
});
