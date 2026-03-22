import { useState, useRef, useCallback } from 'react';
import './styles/global.css';
import { useAudioEngine } from './hooks/useAudioEngine';
import { useAnimationLoop } from './hooks/useAnimationLoop';
import { UploadZone } from './components/UploadZone';
import { Controls } from './components/Controls';
import { Visualizer } from './components/Visualizer';
import { Typewriter, type TypewriterHandle } from './components/Typewriter';

export default function App() {
  const [hasFile, setHasFile] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [trackName, setTrackName] = useState('');
  const [volume, setVolumeState] = useState(0.1);
  const [powerExponent, setPowerExponent] = useState(4.5);
  const [speedMultiplier, setSpeedMultiplier] = useState(2.5);
  const [cps, setCps] = useState(0);
  const [intensity, setIntensity] = useState(0);

  const typewriterRef = useRef<TypewriterHandle>(null);
  // CPS tracking refs
  const charsThisSecondRef = useRef(0);
  const lastCpsUpdateRef = useRef(0);
  const lastIntensityRef = useRef(0);

  const handleEnded = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const engine = useAudioEngine(handleEnded);

  const handleFile = useCallback(async (file: File) => {
    await engine.load(file);
    setTrackName(file.name);
    setHasFile(true);
  }, [engine]);

  const handleTogglePlay = useCallback(() => {
    if (isPlaying) {
      engine.pause();
      setIsPlaying(false);
    } else {
      engine.play();
      setIsPlaying(true);
    }
  }, [isPlaying, engine]);

  const handleReset = useCallback(() => {
    typewriterRef.current?.reset();
    charsThisSecondRef.current = 0;
    setCps(0);
    setIntensity(0);
  }, []);

  const handleVolume = useCallback((v: number) => {
    setVolumeState(v);
    engine.setVolume(v);
  }, [engine]);

  // Frame callback — runs at 60fps, must NOT set state frequently
  const onFrame = useCallback((_data: Uint8Array, frameIntensity: number) => {
    // Draw visualizer imperatively
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    if (canvas && (canvas as any).__draw) {
      (canvas as any).__draw();
    }

    // Feed typewriter
    typewriterRef.current?.feed(frameIntensity, speedMultiplier);
    charsThisSecondRef.current += Math.floor(frameIntensity * speedMultiplier);

    // Update CPS stat once per second
    const now = performance.now();
    if (now - lastCpsUpdateRef.current >= 1000) {
      setCps(charsThisSecondRef.current);
      setIntensity(lastIntensityRef.current);
      charsThisSecondRef.current = 0;
      lastCpsUpdateRef.current = now;
    }
    lastIntensityRef.current = frameIntensity;
  }, [speedMultiplier]);

  useAnimationLoop({
    isPlaying,
    analyser: engine.analyser,
    dataArray: engine.dataArray,
    powerExponent,
    onFrame,
  });

  if (!hasFile) {
    return <UploadZone onFile={handleFile} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Controls
        isPlaying={isPlaying}
        trackName={trackName}
        volume={volume}
        powerExponent={powerExponent}
        speedMultiplier={speedMultiplier}
        cps={cps}
        intensity={intensity}
        onTogglePlay={handleTogglePlay}
        onReset={handleReset}
        onVolume={handleVolume}
        onPower={setPowerExponent}
        onSpeed={setSpeedMultiplier}
      />
      <Visualizer dataArrayRef={engine.dataArray} isPlaying={isPlaying} />
      <Typewriter ref={typewriterRef} />
    </div>
  );
}
