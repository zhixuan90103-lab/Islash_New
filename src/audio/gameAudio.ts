import { Capacitor, registerPlugin } from '@capacitor/core';
import { SFX } from '../game/design';
import { createWebAudioBackend } from './webBackend';

type NativeAudioPlugin = {
  preload(): Promise<{ swooshDur?: number }>;
  play(opts: { id: string; volume: number; rate: number }): Promise<void>;
};

const NativeAudio = registerPlugin<NativeAudioPlugin>('NativeAudio');

const isNativeIos = () =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';

const pluginReady = () =>
  isNativeIos() && Capacitor.isPluginAvailable('NativeAudio');

const web = createWebAudioBackend();
let lastCrack = 0;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function play(id: 'swoosh' | 'crack', volume: number, rate: number): void {
  if (pluginReady()) {
    void NativeAudio.play({ id, volume, rate });
    return;
  }
  web.play(id, volume, rate);
}

export const gameAudio = {
  async preload(): Promise<void> {
    if (pluginReady()) {
      try {
        await NativeAudio.preload();
        return;
      } catch (err) {
        console.warn('[audio] native preload', err);
      }
    }
    await web.preload();
  },

  unlock(): void {
    web.unlock();
  },

  /** 滑动不出声。切开仍走 crack。 */
  slideOnBoard(_speedPx: number): void {},

  resetSlide(): void {},

  crack(opts: { speedPx: number; sizeK: number; finish: boolean }): void {
    const now = performance.now();
    if (now - lastCrack < 40) return;
    lastCrack = now;
    const speedK = clamp01(opts.speedPx / Math.max(1, SFX.speedRef));
    const sizeK = clamp01(opts.sizeK);
    const vol =
      SFX.crackVol *
      (0.55 + 0.45 * sizeK) *
      (0.72 + 0.28 * speedK) *
      (opts.finish ? SFX.finishCrackMul : 1);
    const rate =
      (SFX.crackRateSmall + (SFX.crackRateBig - SFX.crackRateSmall) * sizeK) *
      (0.92 + 0.2 * speedK);
    play('crack', clamp01(vol), Math.max(0.5, Math.min(2, rate)));
  },

  dispose(): void {
    web.dispose();
  },
};
