import { useEffect, useRef } from 'react';

function computeIntensity(dataArray: Uint8Array, powerExponent: number): number {
  const usableBins = Math.floor(dataArray.length * 0.75);
  let sum = 0;
  for (let i = 0; i < usableBins; i++) {
    const v = dataArray[i] / 255;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / usableBins);
  return Math.pow(rms, powerExponent);
}

interface AnimationLoopOptions {
  isPlaying: boolean;
  analyser: React.RefObject<AnalyserNode | null>;
  dataArray: React.RefObject<Uint8Array | null>;
  powerExponent: number;
  onFrame: (dataArray: Uint8Array<ArrayBuffer>, intensity: number) => void;
}

export function useAnimationLoop({
  isPlaying,
  analyser,
  dataArray,
  powerExponent,
  onFrame,
}: AnimationLoopOptions) {
  const rafRef = useRef<number>(0);
  const powerRef = useRef(powerExponent);
  powerRef.current = powerExponent;

  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  useEffect(() => {
    if (!isPlaying) {
      cancelAnimationFrame(rafRef.current);
      return;
    }

    const tick = () => {
      const a = analyser.current;
      const d = dataArray.current;
      if (a && d) {
        const buf = d as Uint8Array<ArrayBuffer>;
        a.getByteFrequencyData(buf);
        const intensity = computeIntensity(buf, powerRef.current);
        onFrameRef.current(buf, intensity);
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying, analyser, dataArray]);
}
