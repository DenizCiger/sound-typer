import { useState, useRef, useCallback, useEffect } from 'react';
import './styles/global.css';
import { useAudioEngine } from './hooks/useAudioEngine';
import { useAnimationLoop } from './hooks/useAnimationLoop';
import { UploadZone } from './components/UploadZone';
import { Controls } from './components/Controls';
import { Visualizer } from './components/Visualizer';
import { Typewriter, type TypewriterHandle } from './components/Typewriter';

const STORAGE_KEY = 'sound-typer-prefs';

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as { volume: number; powerExponent: number; speedMultiplier: number };
  } catch { return null; }
}

function savePrefs(prefs: { volume: number; powerExponent: number; speedMultiplier: number }) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

export default function App() {
  const prefs = loadPrefs();

  const [hasFile, setHasFile] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [trackName, setTrackName] = useState('');
  const [volume, setVolumeState] = useState(prefs?.volume ?? 0.1);
  const [powerExponent, setPowerExponentState] = useState(prefs?.powerExponent ?? 4.5);
  const [speedMultiplier, setSpeedMultiplierState] = useState(prefs?.speedMultiplier ?? 2.5);
  const [cps, setCps] = useState(0);
  const [intensity, setIntensity] = useState(0);
  const [playbackPos, setPlaybackPos] = useState(0);

  const typewriterRef = useRef<TypewriterHandle>(null);
  const charsThisSecondRef = useRef(0);
  const lastCpsUpdateRef = useRef(0);
  const lastIntensityRef = useRef(0);

  useEffect(() => {
    savePrefs({ volume, powerExponent, speedMultiplier });
  }, [volume, powerExponent, speedMultiplier]);

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
    setHasFile(true);
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

  const onFrame = useCallback((_data: Uint8Array, frameIntensity: number) => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    if (canvas && (canvas as any).__draw) (canvas as any).__draw();

    const typed = typewriterRef.current?.feed(frameIntensity, speedMultiplier) ?? 0;
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

  useAnimationLoop({ isPlaying, analyser: engine.analyser, dataArray: engine.dataArray, powerExponent, onFrame });

  if (!hasFile) {
    return <UploadZone onFile={handleFile} />;
  }

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
        onTogglePlay={handleTogglePlay}
        onSeek={handleSeek}
        onLoad={handleFile}
        onVolume={handleVolume}
        onPower={handlePower}
        onSpeed={handleSpeed}
      />
      <Visualizer dataArrayRef={engine.dataArray} isPlaying={isPlaying} />
      <Typewriter ref={typewriterRef} />
    </div>
  );
}
