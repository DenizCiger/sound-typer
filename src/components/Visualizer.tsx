import { useRef, useEffect, useCallback } from 'react';
import styles from '../styles/Visualizer.module.css';

interface Props {
  dataArrayRef: React.RefObject<Uint8Array | null>;
  isPlaying: boolean;
}

export function Visualizer({ dataArrayRef, isPlaying }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const data = dataArrayRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d')!;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    // Sync canvas pixel resolution
    if (canvas.width !== w * devicePixelRatio || canvas.height !== h * devicePixelRatio) {
      canvas.width = w * devicePixelRatio;
      canvas.height = h * devicePixelRatio;
      ctx.scale(devicePixelRatio, devicePixelRatio);
    }

    ctx.clearRect(0, 0, w, h);
    if (!data) return;

    const barCount = 64;
    const step = Math.floor(data.length / barCount);
    const barWidth = (w / barCount) * 0.8;
    const gap = (w / barCount) * 0.2;

    ctx.shadowBlur = 6;
    for (let i = 0; i < barCount; i++) {
      const value = data[i * step] / 255;
      const barHeight = value * h * 0.9;
      const opacity = 0.15 + value * 0.85;
      const color = `rgba(255, 255, 255, ${opacity})`;
      ctx.fillStyle = color;
      ctx.shadowColor = `rgba(255, 255, 255, ${value * 0.3})`;
      const x = i * (barWidth + gap) + gap / 2;
      ctx.fillRect(x, h - barHeight, barWidth, barHeight);
    }
    ctx.shadowBlur = 0;
  }, [dataArrayRef]);

  // Expose draw so App can call it each frame
  useEffect(() => {
    (canvasRef.current as any).__draw = draw;
  }, [draw]);

  // Clear when stopped
  useEffect(() => {
    if (!isPlaying) draw();
  }, [isPlaying, draw]);

  return <canvas ref={canvasRef} className={styles.canvas} />;
}

export type { Props as VisualizerProps };
