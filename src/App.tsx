import { useState, useRef, useCallback, useEffect } from 'react';
import './styles/global.css';
import { LOREM } from './constants';
import { isAudioFile } from './format';
import { useAudioEngine } from './hooks/useAudioEngine';
import { useAnimationLoop } from './hooks/useAnimationLoop';
import { analyzeBuffer } from './audio/analyzeBuffer';
import type { TrackAnalysis } from './audio/analysis';
import { TypingDriver, type DriverFrame, type DriverParams } from './audio/driver';
import { Controls } from './components/Controls';
import { Visualizer, type VisualizerHandle } from './components/Visualizer';
import { Typewriter, type TypewriterHandle } from './components/Typewriter';
import { Game, type GameHandle } from './components/Game';
import type { Difficulty } from './game/common';
import type { GameStyle } from './game/types';
import { Settings, type SettingsState, type FeelPrefs, type AppMode } from './components/Settings';

const STORAGE_KEY = 'sound-typer-prefs';
const TEXT_SOURCE_KEY = 'sound-typer-text-source';
const SETTINGS_KEY = 'sound-typer-settings';

const DEFAULT_SETTINGS: SettingsState = { screenshake: true, screenshakeMultiplier: 1, glowIntensity: 1, cameraZoom: 1, partColors: true, showHealth: true, snapToWords: true, cursorPosition: 'bottom', textWidth: 'full', whitespaceMode: 'none', mode: 'play', difficulty: 'normal', gameStyle: 'bullets', respawnDelay: 1.5, invincible: false };

interface Prefs extends FeelPrefs {
  volume: number;
}

const DEFAULT_FEEL: FeelPrefs = { maxCps: 40, dynamics: 1.5, punch: 0.7, shakeThreshold: 0.6 };
const DEFAULT_PREFS: Prefs = { volume: 0.1, ...DEFAULT_FEEL };

const EMPTY_FRAME: DriverFrame = { flowChars: 0, burstChars: 0, hits: [], intensity: 0 };

function loadSettings(): SettingsState {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    // Older versions had an on/off glow toggle
    if (typeof parsed.hitGlow === 'boolean' && parsed.glowIntensity === undefined) {
      parsed.glowIntensity = parsed.hitGlow ? DEFAULT_SETTINGS.glowIntensity : 0;
    }
    delete parsed.hitGlow;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch { return DEFAULT_SETTINGS; }
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<Prefs>;
    const num = (v: unknown, fallback: number, max: number) =>
      typeof v === 'number' && isFinite(v) && v >= 0 && v <= max ? v : fallback;
    // Older versions stored a differently scaled shake threshold (0–300) and power/speed values;
    // anything out of the new ranges falls back to defaults.
    return {
      volume: num(p.volume, DEFAULT_PREFS.volume, 1),
      maxCps: num(p.maxCps, DEFAULT_PREFS.maxCps, 1000),
      dynamics: num(p.dynamics, DEFAULT_PREFS.dynamics, 10),
      punch: num(p.punch, DEFAULT_PREFS.punch, 10),
      shakeThreshold: num(p.shakeThreshold, DEFAULT_PREFS.shakeThreshold, 1),
    };
  } catch { return DEFAULT_PREFS; }
}

function loadTextSource() {
  try {
    const raw = localStorage.getItem(TEXT_SOURCE_KEY);
    return raw || null;
  } catch { return null; }
}

function saveTextSource(text: string | null) {
  if (text) {
    localStorage.setItem(TEXT_SOURCE_KEY, text);
  } else {
    localStorage.removeItem(TEXT_SOURCE_KEY);
  }
}

export default function App() {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [savedTextSource] = useState(loadTextSource);

  const [isPlaying, setIsPlaying] = useState(false);
  const [trackName, setTrackName] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [analysis, setAnalysis] = useState<TrackAnalysis | null>(null);
  const [playbackPos, setPlaybackPos] = useState(0);
  const [textSource, setTextSourceState] = useState<string | null>(savedTextSource);
  const [textSourceName, setTextSourceName] = useState<string | null>(savedTextSource ? 'Custom' : null);
  // The arena wants the room, so the visualizer is remembered per mode
  const [visualizerModes, setVisualizerModes] = useState<Record<AppMode, boolean>>({ type: true, play: false });
  const [settings, setSettings] = useState<SettingsState>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [fileDragging, setFileDragging] = useState(false);

  const handleSettingsChange = useCallback((s: SettingsState) => {
    setSettings(s);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }, []);

  const typewriterRef = useRef<TypewriterHandle>(null);
  const gameRef = useRef<GameHandle>(null);
  const visualizerRef = useRef<VisualizerHandle>(null);
  const driverRef = useRef<TypingDriver | null>(null);
  const loadIdRef = useRef(0);
  const lastUiUpdateRef = useRef(0);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  }, [prefs]);

  const handleEnded = useCallback(() => {
    gameRef.current?.finish();
    setIsPlaying(false);
    setPlaybackPos(0);
  }, []);

  const engine = useAudioEngine(handleEnded, prefs.volume);

  const handleFile = useCallback(async (file: File) => {
    const loadId = ++loadIdRef.current;
    engine.pause();
    setIsPlaying(false);
    driverRef.current = null;
    setAnalysis(null);
    setTrackName(file.name);
    setStatus('Decoding…');
    setLoadFailed(false);
    try {
      const buffer = await engine.load(file);
      if (loadId !== loadIdRef.current) return;
      setDuration(buffer.duration);
      setPlaybackPos(0);
      setStatus('Analyzing…');
      const result = await analyzeBuffer(buffer);
      if (loadId !== loadIdRef.current) return;
      driverRef.current = new TypingDriver(result);
      setAnalysis(result);
      setStatus(null);
    } catch (err) {
      console.error(err);
      if (loadId === loadIdRef.current) {
        setStatus('Could not load file');
        setLoadFailed(true);
      }
    }
  }, [engine]);

  const handlePause = useCallback(() => {
    engine.pause();
    setIsPlaying(false);
    setPlaybackPos(engine.getPosition());
  }, [engine]);

  const handleTogglePlay = useCallback(() => {
    if (isPlaying) {
      handlePause();
    } else if (duration > 0) {
      gameRef.current?.start();
      engine.play();
      setIsPlaying(true);
    }
  }, [isPlaying, engine, duration, handlePause]);

  const handleSeek = useCallback((s: number) => {
    engine.seek(s);
    setPlaybackPos(s);
  }, [engine]);

  const setPref = useCallback(<K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    setPrefs((p) => ({ ...p, [key]: value }));
  }, []);

  const handleFeelChange = useCallback((feel: FeelPrefs) => {
    setPrefs((p) => ({ ...p, ...feel }));
  }, []);

  // Volume and what's picked in the game's menu are left alone: they're not part of the "feel"
  const handleReset = useCallback(() => {
    setPrefs((p) => ({ ...p, ...DEFAULT_FEEL }));
    handleSettingsChange({ ...DEFAULT_SETTINGS, mode: settings.mode, gameStyle: settings.gameStyle, difficulty: settings.difficulty });
  }, [handleSettingsChange, settings.mode, settings.gameStyle, settings.difficulty]);

  const handleModeChange = useCallback((mode: AppMode) => {
    // Into the game means into its menu first
    if (mode === 'play') handlePause();
    handleSettingsChange({ ...settings, mode });
  }, [handleSettingsChange, handlePause, settings]);

  const handleGameStyle = useCallback((gameStyle: GameStyle) => {
    handleSettingsChange({ ...settings, gameStyle });
  }, [handleSettingsChange, settings]);

  const handleDifficulty = useCallback((difficulty: Difficulty) => {
    handleSettingsChange({ ...settings, difficulty });
  }, [handleSettingsChange, settings]);

  const showVisualizer = visualizerModes[settings.mode];

  const handleCloseSettings = useCallback(() => setShowSettings(false), []);

  const handleVolume = useCallback((v: number) => {
    setPref('volume', v);
    engine.setVolume(v);
  }, [engine, setPref]);

  const handleTextFile = useCallback(async (file: File) => {
    const text = await file.text();
    if (!text) return;
    setTextSourceState(text);
    setTextSourceName(file.name);
    saveTextSource(text);
  }, []);

  const handleRemoveTextSource = useCallback(() => {
    setTextSourceState(null);
    setTextSourceName(null);
    saveTextSource(null);
  }, []);

  const handleToggleVisualizer = useCallback(() => {
    setVisualizerModes((v) => ({ ...v, [settings.mode]: !v[settings.mode] }));
  }, [settings.mode]);

  // Files can be dropped anywhere: a song, or for the typewriter a text
  useEffect(() => {
    const onOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      setFileDragging(true);
    };
    const onLeave = (e: DragEvent) => { if (!e.relatedTarget) setFileDragging(false); };
    const onDrop = (e: DragEvent) => {
      setFileDragging(false);
      // A chip in the toolbar took it
      if (e.defaultPrevented || !e.dataTransfer?.files.length) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files);
      const song = files.find(isAudioFile);
      if (song) handleFile(song);
      else if (settings.mode === 'type') handleTextFile(files[0]);
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [handleFile, handleTextFile, settings.mode]);

  const drawVisualizer = useCallback((position: number) => {
    const driver = driverRef.current;
    visualizerRef.current?.draw({
      position,
      analyser: engine.analyser.current,
      analysis,
      intensityAt: driver ? (t) => driver.intensityAt(t, prefs.dynamics) : null,
      shakeThreshold: settings.screenshake ? prefs.shakeThreshold : 1,
    });
  }, [engine, analysis, prefs.dynamics, prefs.shakeThreshold, settings.screenshake]);

  const onFrame = useCallback((dt: number) => {
    const pos = engine.getPosition();
    const params: DriverParams = { maxCps: prefs.maxCps, dynamics: prefs.dynamics, punch: prefs.punch };
    if (settings.mode === 'play') {
      gameRef.current?.frame(pos, dt);
    } else {
      const frame = driverRef.current?.step(pos, dt, params) ?? EMPTY_FRAME;
      typewriterRef.current?.feed(frame, dt);
    }
    drawVisualizer(pos);

    const now = performance.now();
    if (now - lastUiUpdateRef.current >= 250) {
      // Read again: a checkpoint rewind during the frame may have moved it
      setPlaybackPos(engine.getPosition());
      lastUiUpdateRef.current = now;
    }
  }, [engine, prefs.maxCps, prefs.dynamics, prefs.punch, drawVisualizer, settings.mode]);

  useAnimationLoop(isPlaying, onFrame);

  // Keep the visualizer in sync while paused (seeking, loading, tweaking sliders)
  useEffect(() => {
    if (!isPlaying) drawVisualizer(playbackPos);
  }, [isPlaying, playbackPos, drawVisualizer, showVisualizer]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {settings.mode === 'type' && <Controls
        isPlaying={isPlaying}
        trackName={trackName}
        status={status}
        playbackPos={playbackPos}
        duration={duration}
        volume={prefs.volume}
        textSourceName={textSourceName}
        showVisualizer={showVisualizer}
        mode={settings.mode}
        onModeChange={handleModeChange}
        onTogglePlay={handleTogglePlay}
        onSeek={handleSeek}
        onLoad={handleFile}
        onVolume={handleVolume}
        onLoadText={handleTextFile}
        onRemoveText={handleRemoveTextSource}
        onToggleVisualizer={handleToggleVisualizer}
        onOpenSettings={() => setShowSettings(true)}
      />}
      {showVisualizer && <Visualizer ref={visualizerRef} />}
      {settings.mode === 'play' ? (
        <Game
          ref={gameRef}
          analysis={analysis}
          status={status}
          failed={loadFailed}
          trackName={trackName}
          isPlaying={isPlaying}
          playbackPos={playbackPos}
          style={settings.gameStyle}
          difficulty={settings.difficulty}
          respawnDelay={settings.respawnDelay}
          invincible={settings.invincible}
          screenshake={settings.screenshake}
          screenshakeMultiplier={settings.screenshakeMultiplier}
          shakeThreshold={prefs.shakeThreshold}
          glowIntensity={settings.glowIntensity}
          cameraZoom={settings.cameraZoom}
          partColors={settings.partColors}
          showHealth={settings.showHealth}
          volume={prefs.volume}
          showVisualizer={showVisualizer}
          getPosition={engine.getPosition}
          onStyleChange={handleGameStyle}
          onDifficultyChange={handleDifficulty}
          onVolume={handleVolume}
          onToggleVisualizer={handleToggleVisualizer}
          onOpenSettings={() => setShowSettings(true)}
          onLeave={() => handleModeChange('type')}
          onTogglePlay={handleTogglePlay}
          onPause={handlePause}
          onSeek={handleSeek}
          onLoadFile={handleFile}
        />
      ) : (
      <Typewriter
        ref={typewriterRef}
        textSource={textSource || LOREM}
        screenshake={settings.screenshake}
        screenshakeMultiplier={settings.screenshakeMultiplier}
        shakeThreshold={prefs.shakeThreshold}
        glowIntensity={settings.glowIntensity}
        snapToWords={settings.snapToWords}
        cursorPosition={settings.cursorPosition}
        textWidth={settings.textWidth}
        whitespaceMode={settings.whitespaceMode}
      />
      )}
      {fileDragging && <div className="drop-hint">Drop to load</div>}
      {showSettings && (
        <Settings
          settings={settings}
          feel={prefs}
          onChange={handleSettingsChange}
          onFeelChange={handleFeelChange}
          onReset={handleReset}
          onClose={handleCloseSettings}
        />
      )}
    </div>
  );
}
