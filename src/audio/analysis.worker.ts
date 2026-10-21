import { analyzeTrack } from './analysis';

self.onmessage = (e: MessageEvent<{ id: number; samples: Float32Array; sampleRate: number }>) => {
  const { id, samples, sampleRate } = e.data;
  const result = analyzeTrack(samples, sampleRate);
  const transfer = [
    result.level.buffer,
    result.activity.buffer,
    result.novelty.buffer,
    result.onsetTimes.buffer,
    result.onsetStrength.buffer,
    result.onsetLowness.buffer,
  ];
  (self as unknown as Worker).postMessage({ id, result }, transfer);
};
