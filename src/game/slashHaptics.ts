import { gameAudio } from '../audio/gameAudio';
import { haptics } from '../utils/haptics';
import { HAPTIC, bladeSpeedScale } from './design';
import type { IntentFrame } from './slashIntent';

/** 按钮这次按下真的做了事。 */
export function tapButton(): void {
  gameAudio.tap();
  void haptics.stackImpact(HAPTIC.tapI, HAPTIC.tapS);
}

/** 拼放第一次拿起一块。第二指、拖动、松手不打。瞬态立刻打，随后一段衰减的持续余韵。 */
export function grabPiece(): void {
  gameAudio.lift();
  const gap = Math.max(0, HAPTIC.grabTailGap);
  const dur = Math.max(0, HAPTIC.grabTailDur);
  const tailI = HAPTIC.grabTailI;
  if (dur < 0.02 || tailI <= 0.001) {
    void haptics.stackImpact(HAPTIC.grabI, HAPTIC.grabS);
    return;
  }
  void haptics.playPattern(
    [
      {
        type: 'transient',
        relativeTime: 0,
        intensity: HAPTIC.grabI,
        sharpness: HAPTIC.grabS,
      },
      {
        type: 'continuous',
        relativeTime: gap,
        duration: dur,
        intensity: tailI,
        sharpness: HAPTIC.grabTailS,
      },
    ],
    [
      {
        parameterID: 'hapticIntensity',
        relativeTime: gap,
        controlPoints: [
          { relativeTime: 0, parameterValue: 1 },
          { relativeTime: dur, parameterValue: 0 },
        ],
      },
    ],
  );
}

/**
 * 一刀触觉：锁 A 轻击 + 弱持续（渐起）→ 切开重击。
 * 走廊余势 / 失败 / 抬手只停持续。
 */
export function createSlashHaptics() {
  let rumbling = false;

  const stopRumble = () => {
    if (!rumbling) return;
    rumbling = false;
    void haptics.stopContinuous();
  };

  const startRumble = () => {
    if (rumbling) return;
    rumbling = true;
    void haptics.stackImpact(HAPTIC.enterI, HAPTIC.enterS);
    void haptics.startContinuous({
      intensity: HAPTIC.holdI,
      sharpness: HAPTIC.holdS,
      duration: HAPTIC.maxHold,
      attack: HAPTIC.attack,
    });
  };

  return {
    onFrame(frame: IntentFrame) {
      if (frame.phase === 'hold' || frame.scribble) {
        stopRumble();
        return;
      }
      if (
        frame.enter &&
        (frame.phase === 'track' || frame.phase === 'aimed')
      ) {
        startRumble();
        return;
      }
      stopRumble();
    },
    onCut(speedPx: number, finish: boolean) {
      rumbling = false;
      void haptics.stopContinuous();
      const t = bladeSpeedScale(speedPx);
      const i = HAPTIC.cutI0 + (HAPTIC.cutI1 - HAPTIC.cutI0) * t;
      const s = HAPTIC.cutS0 + (HAPTIC.cutS1 - HAPTIC.cutS0) * t;
      const mul = finish ? HAPTIC.finishMul : 1;
      void haptics.stackImpact(Math.min(1, i * mul), Math.min(1, s));
    },
    cancel() {
      stopRumble();
    },
  };
}
