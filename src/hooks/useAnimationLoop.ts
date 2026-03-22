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
  shakeAnalyser: React.RefObject<AnalyserNode | null>;
  shakeDataArray: React.RefObject<Uint8Array | null>;
  powerExponent: number;
  onFrame: (dataArray: Uint8Array<ArrayBuffer>, intensity: number, shakeData: Uint8Array<ArrayBuffer> | null) => void;
}

export function useAnimationLoop({
  isPlaying,
  analyser,
  dataArray,
  shakeAnalyser,
  shakeDataArray,
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

        const sa = shakeAnalyser.current;
        const sd = shakeDataArray.current;
        let shakeBuf: Uint8Array<ArrayBuffer> | null = null;
        if (sa && sd) {
          const sbuf = sd as Uint8Array<ArrayBuffer>;
          sa.getByteFrequencyData(sbuf);
          shakeBuf = sbuf;
        }

        onFrameRef.current(buf, intensity, shakeBuf);
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying, analyser, dataArray, shakeAnalyser, shakeDataArray]);
}
