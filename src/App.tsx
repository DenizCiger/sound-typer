import { useState, useRef, useCallback, useEffect } from 'react';
import './styles/global.css';
import { LOREM } from './constants';
import { useAudioEngine } from './hooks/useAudioEngine';
import { useAnimationLoop } from './hooks/useAnimationLoop';
import { Controls } from './components/Controls';
import { Visualizer } from './components/Visualizer';
import { Typewriter, type TypewriterHandle } from './components/Typewriter';
import { Settings, type SettingsState } from './components/Settings';

const STORAGE_KEY = 'sound-typer-prefs';
const TEXT_SOURCE_KEY = 'sound-typer-text-source';
const SETTINGS_KEY = 'sound-typer-settings';

const DEFAULT_SETTINGS: SettingsState = { screenshake: true, screenshakeMultiplier: 1, cursorPosition: 'bottom', textWidth: 'full' };

function loadSettings(): SettingsState {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { return DEFAULT_SETTINGS; }
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as { volume: number; powerExponent: number; speedMultiplier: number; shakeThreshold?: number };
  } catch { return null; }
}

function savePrefs(prefs: { volume: number; powerExponent: number; speedMultiplier: number; shakeThreshold: number }) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
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
  const prefs = loadPrefs();
  const savedTextSource = loadTextSource();

  const [isPlaying, setIsPlaying] = useState(false);
  const [trackName, setTrackName] = useState('');
  const [volume, setVolumeState] = useState(prefs?.volume ?? 0.1);
  const [powerExponent, setPowerExponentState] = useState(prefs?.powerExponent ?? 4.5);
  const [speedMultiplier, setSpeedMultiplierState] = useState(prefs?.speedMultiplier ?? 2.5);
  const [shakeThreshold, setShakeThresholdState] = useState(prefs?.shakeThreshold ?? 120);
  const [cps, setCps] = useState(0);
  const [intensity, setIntensity] = useState(0);
  const [playbackPos, setPlaybackPos] = useState(0);
  const [textSource, setTextSourceState] = useState<string | null>(savedTextSource);
  const [textSourceName, setTextSourceName] = useState<string | null>(savedTextSource ? 'Custom' : null);
  const [showVisualizer, setShowVisualizer] = useState(true);
  const [settings, setSettings] = useState<SettingsState>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);

  const handleSettingsChange = useCallback((s: SettingsState) => {
    setSettings(s);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }, []);

  const typewriterRef = useRef<TypewriterHandle>(null);
  const charsThisSecondRef = useRef(0);
  const lastCpsUpdateRef = useRef(0);
  const lastIntensityRef = useRef(0);

  useEffect(() => {
    savePrefs({ volume, powerExponent, speedMultiplier, shakeThreshold });
  }, [volume, powerExponent, speedMultiplier, shakeThreshold]);

  const handleEnded = useCallback(() => {
    setIsPlaying(false);
    setPlaybackPos(0);
  }, []);

  const engine = useAudioEngine(handleEnded);

  useEffect(() => {
    engine.setVolume(volume);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFile = useCallback(async (file: File) => {
    if (isPlaying) {
      engine.pause();
      setIsPlaying(false);
    }
    await engine.load(file);
    setTrackName(file.name);
    setPlaybackPos(0);
  }, [engine, isPlaying]);

  const handleTogglePlay = useCallback(() => {
    if (isPlaying) {
      engine.pause();
      setIsPlaying(false);
    } else {
      engine.play();
      setIsPlaying(true);
    }
  }, [isPlaying, engine]);

  const handleSeek = useCallback((s: number) => {
    engine.seek(s);
    setPlaybackPos(s);
  }, [engine]);

  const handleVolume = useCallback((v: number) => {
    setVolumeState(v);
    engine.setVolume(v);
  }, [engine]);

  const handlePower = useCallback((v: number) => setPowerExponentState(v), []);
  const handleSpeed = useCallback((v: number) => setSpeedMultiplierState(v), []);
  const handleShakeThreshold = useCallback((v: number) => setShakeThresholdState(v), []);

  const handleTextFile = useCallback(async (file: File) => {
    const text = await file.text();
    setTextSourceState(text);
    setTextSourceName(file.name);
    saveTextSource(text);
  }, []);

  const handleRemoveTextSource = useCallback(() => {
    setTextSourceState(null);
    setTextSourceName(null);
    saveTextSource(null);
  }, []);

  const onFrame = useCallback((_data: Uint8Array, frameIntensity: number, shakeData: Uint8Array | null) => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    if (canvas && (canvas as any).__draw) (canvas as any).__draw();

    const typed = typewriterRef.current?.feed(frameIntensity, speedMultiplier, shakeData) ?? 0;
    charsThisSecondRef.current += typed;

    const now = performance.now();
    if (now - lastCpsUpdateRef.current >= 1000) {
      setCps(charsThisSecondRef.current);
      setIntensity(lastIntensityRef.current);
      setPlaybackPos(engine.getPosition());
      charsThisSecondRef.current = 0;
      lastCpsUpdateRef.current = now;
    }
    lastIntensityRef.current = frameIntensity;
  }, [speedMultiplier, engine]);

  useAnimationLoop({ isPlaying, analyser: engine.analyser, dataArray: engine.dataArray, shakeAnalyser: engine.shakeAnalyser, shakeDataArray: engine.shakeDataArray, powerExponent, onFrame });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Controls
        isPlaying={isPlaying}
        trackName={trackName}
        playbackPos={playbackPos}
        duration={engine.duration.current}
        volume={volume}
        powerExponent={powerExponent}
        speedMultiplier={speedMultiplier}
        cps={cps}
        intensity={intensity}
        textSourceName={textSourceName}
        showVisualizer={showVisualizer}
        onTogglePlay={handleTogglePlay}
        onSeek={handleSeek}
        onLoad={handleFile}
        onVolume={handleVolume}
        onPower={handlePower}
        onSpeed={handleSpeed}
        onLoadText={handleTextFile}
        onRemoveText={handleRemoveTextSource}
        shakeThreshold={shakeThreshold}
        onShakeThreshold={handleShakeThreshold}
        onToggleVisualizer={() => setShowVisualizer(!showVisualizer)}
        onOpenSettings={() => setShowSettings(true)}
      />
      {showVisualizer && <Visualizer dataArrayRef={engine.dataArray} isPlaying={isPlaying} />}
      <Typewriter ref={typewriterRef} textSource={textSource || LOREM} screenshake={settings.screenshake} screenshakeMultiplier={settings.screenshakeMultiplier} shakeThreshold={shakeThreshold} cursorPosition={settings.cursorPosition} textWidth={settings.textWidth} />
      {showSettings && <Settings settings={settings} onChange={handleSettingsChange} onClose={() => setShowSettings(false)} />}
    </div>
  );
}
