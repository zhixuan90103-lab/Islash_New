import type * as THREE from 'three';
import { INTENT, START } from './design';
import {
  chordLength,
  clipBackToEnter,
  clipChordToHull,
  clipInfiniteLineToHull,
  closestHullEdge,
  rankedHullEdges,
  pointInConvexHull,
  projectMeshHull,
  designToLocalXY,
  localXYToDesign,
} from './slashHit';
import { followBlocks, stepFollow } from './slashFollow';
import {
  emptyIntent,
  segmentSpeedPxPerSec,
  type DesignPoint,
  type SlashStroke,
} from './slashInput';

export type CutTarget = {
  mesh: THREE.Mesh;
  c0: DesignPoint;
  c1: DesignPoint;
  chord: number;
  enterEdge?: number;
};

export type IntentPhase = 'idle' | 'arming' | 'track' | 'aimed' | 'hold';

export type IntentFrame = {
  phase: IntentPhase;
  enter: DesignPoint | null;
  enterEdge: number;
  meshId: number | null;
  cyan: { c0: DesignPoint; c1: DesignPoint } | null;
  crack: { c0: DesignPoint; c1: DesignPoint } | null;
  locked: boolean;
  travelRatio: number;
  speed: number;
  commit: CutTarget | null;
  commitFlash: boolean;
  /** 刀尖已出纸，当前角度切不成。 */
  scribble: boolean;
  /** 本段未提交原因（调试）。提交成功为 commit。 */
  why: string;
};

let debugWhy = '';

function note(msg: string): null {
  debugWhy = msg;
  return null;
}

function hypot(dx: number, dy: number): number {
  return Math.hypot(dx, dy);
}

export function headingAngleDeg(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const al = hypot(ax, ay) || 1;
  const bl = hypot(bx, by) || 1;
  const d = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (al * bl)));
  return (Math.acos(d) * 180) / Math.PI;
}

function unitDir(from: DesignPoint, to: DesignPoint): { dx: number; dy: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = hypot(dx, dy) || 1;
  return { dx: dx / len, dy: dy / len };
}

export function resetLock(stroke: SlashStroke): void {
  const speeds = stroke.intent.speedSamples;
  stroke.intent.locked = false;
  stroke.intent.stable = 0;
  stroke.intent.c0 = null;
  stroke.intent.c1 = null;
  stroke.intent.speedSamples = speeds;
}

export function resetSlashIntent(stroke: SlashStroke): void {
  stroke.intent = emptyIntent();
  stroke.enterLock = null;
}

export function twoEdges(
  enterEdge: number,
  exitEdge: number,
  c0: DesignPoint,
  c1: DesignPoint,
  hull: DesignPoint[],
): boolean {
  const e = enterEdge >= 0 ? enterEdge : closestHullEdge(c0, hull);
  const x = exitEdge >= 0 ? exitEdge : closestHullEdge(c1, hull);
  return e !== x;
}

function speedBlend(speed: number): number {
  const cap = Math.max(1, START.fastSpeed);
  return Math.max(0, Math.min(1, speed / cap));
}

export function endTravelNeed(speed: number): number {
  const t = speedBlend(speed);
  return 1 - (1 - START.endTravelFast) * t;
}

function startRadius(speed: number): number {
  const t = speedBlend(speed);
  return START.slowDist + (START.fastDist - START.slowDist) * t;
}

/** 从刀尖往回走，最近一次出板点；太远的旧点不用（避免对边当入边）。 */
function recentOutside(
  points: DesignPoint[],
  hull: DesignPoint[],
  maxPath: number,
): DesignPoint | null {
  if (points.length === 0) return null;
  let path = 0;
  const tip = points[points.length - 1];
  if (!pointInConvexHull(tip, hull)) return tip;
  for (let i = points.length - 2; i >= 0; i--) {
    const p = points[i];
    const n = points[i + 1];
    path += hypot(n.x - p.x, n.y - p.y);
    if (path > maxPath) return null;
    if (!pointInConvexHull(p, hull)) return p;
  }
  return null;
}

function syncLockedA(
  stroke: SlashStroke,
  mesh: THREE.Mesh,
  camera: THREE.Camera,
  _hull?: DesignPoint[],
): DesignPoint | null {
  const L = stroke.enterLock;
  if (!L || L.meshId !== mesh.id) return null;
  const p = localXYToDesign(mesh, camera, L.localX, L.localY);
  if (!p) return L.c0;
  L.c0 = p;
  return p;
}

function addInBoardPath(
  stroke: SlashStroke,
  from: DesignPoint,
  to: DesignPoint,
  hull: DesignPoint[],
): void {
  const L = stroke.enterLock;
  if (!L) return;
  const clip = clipChordToHull(from, to, hull);
  if (clip) L.path += chordLength(clip.c0, clip.c1);
  else if (pointInConvexHull(from, hull) && pointInConvexHull(to, hull)) {
    L.path += chordLength(from, to);
  }
}

function endUncutAttempt(stroke: SlashStroke, meshId: number): void {
  stroke.progress.delete(meshId);
  if (stroke.enterLock?.meshId === meshId) stroke.enterLock = null;
  resetLock(stroke);
}

/** 入点已经靠近尖角时，收到这个角的中心。圆弧上的点不收。 */
function snapEnterCorner(c0: DesignPoint, hull: DesignPoint[]): DesignPoint {
  const n = hull.length;
  if (n < 3) return c0;
  const corners: DesignPoint[] = [];
  for (let i = 0; i < n; i++) {
    const prev = hull[(i - 1 + n) % n];
    const p = hull[i];
    const next = hull[(i + 1) % n];
    const ax = p.x - prev.x;
    const ay = p.y - prev.y;
    const bx = next.x - p.x;
    const by = next.y - p.y;
    const la = Math.hypot(ax, ay) || 1;
    const lb = Math.hypot(bx, by) || 1;
    const dot = (ax * bx + ay * by) / (la * lb);
    if (dot < 0.84) corners.push(p);
  }
  if (!corners.length) return c0;
  const ranked = corners
    .map((p) => ({ p, d: Math.hypot(p.x - c0.x, p.y - c0.y) }))
    .sort((a, b) => a.d - b.d);
  const nearest = ranked[0];
  const cluster = ranked.filter((c) => Math.hypot(c.p.x - nearest.p.x, c.p.y - nearest.p.y) <= 16);
  let x = 0;
  let y = 0;
  for (const c of cluster) {
    x += c.p.x;
    y += c.p.y;
  }
  const center = { x: x / cluster.length, y: y / cluster.length };
  const dist = Math.hypot(center.x - c0.x, center.y - c0.y);
  const next = ranked.find((c) => Math.hypot(c.p.x - nearest.p.x, c.p.y - nearest.p.y) > 16);
  const limit = Math.min(10, Math.max(6, (next?.d ?? 40) * 0.16));
  if (dist > limit) return c0;
  return center;
}

function lockEnter(
  stroke: SlashStroke,
  mesh: THREE.Mesh,
  camera: THREE.Camera,
  c0: DesignPoint,
  tip: DesignPoint,
  enterEdge: number,
  skipSlop = false,
): boolean {
  const meshId = mesh.id;
  if (stroke.enterLock) {
    const L = stroke.enterLock;
    if (L.meshId !== meshId) return false;
    const a = syncLockedA(stroke, mesh, camera) ?? L.c0;
    stroke.progress.set(meshId, {
      c0: { x: a.x, y: a.y },
      c1: tip,
      chord: chordLength(a, tip),
      inside: true,
      enterEdge: L.enterEdge,
      dirx: L.dirx,
      diry: L.diry,
    });
    return true;
  }
  if (!skipSlop && chordLength(c0, tip) < START.lockSlop) return false;
  const local = designToLocalXY(c0, camera, mesh);
  if (!local) return false;
  const d = unitDir(c0, tip);
  stroke.enterLock = {
    meshId,
    c0: { x: c0.x, y: c0.y },
    localX: local.x,
    localY: local.y,
    enterEdge,
    dirx: d.dx,
    diry: d.dy,
    path: chordLength(c0, tip),
    dead: false,
  };
  stroke.progress.set(meshId, {
    c0: { x: c0.x, y: c0.y },
    c1: tip,
    chord: chordLength(c0, tip),
    inside: true,
    enterEdge,
    dirx: d.dx,
    diry: d.dy,
  });
  return true;
}

function travelAlongCyan(
  c0: DesignPoint,
  c1: DesignPoint,
  tip: DesignPoint,
): number {
  const ax = c1.x - c0.x;
  const ay = c1.y - c0.y;
  const full = hypot(ax, ay) || 1;
  const traveled = ((tip.x - c0.x) * ax + (tip.y - c0.y) * ay) / full;
  return traveled / full;
}

function pushSpeed(stroke: SlashStroke, speed: number): number {
  const w = Math.max(1, START.speedWindow);
  const s = stroke.intent.speedSamples;
  s.push(speed);
  if (s.length > w) s.splice(0, s.length - w);
  const sorted = s.slice().sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)] ?? speed;
}

export function previewCutChord(
  meshes: THREE.Mesh[],
  camera: THREE.Camera,
  stroke: SlashStroke,
  tip: DesignPoint,
  from?: DesignPoint,
): CutTarget | null {
  if (from && followBlocks(stroke, from, tip, meshes, camera)) return null;
  const trackedId = stroke.progress.size ? [...stroke.progress.keys()][0] : null;
  if (trackedId == null) return null;
  const st = stroke.progress.get(trackedId);
  const mesh = meshes.find((m) => m.id === trackedId);
  if (!st || !mesh) return null;
  if (stroke.enterLock?.dead) return null;
  const proj = projectMeshHull(mesh, camera);
  if (!proj) return null;
  const dx = tip.x - st.c0.x;
  const dy = tip.y - st.c0.y;
  if (dx * dx + dy * dy < 4) return null;
  const line = clipInfiniteLineToHull(st.c0, tip, proj.hull);
  if (!line) return null;
  const [c0, c1] = line;
  if (!twoEdges(st.enterEdge, closestHullEdge(c1, proj.hull), c0, c1, proj.hull)) {
    return null;
  }
  return { mesh, c0, c1, chord: chordLength(c0, c1) };
}

function medianSpeed(stroke: SlashStroke, fallback: number): number {
  const s = stroke.intent.speedSamples;
  if (s.length === 0) return fallback;
  const sorted = s.slice().sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)] ?? fallback;
}

export function crackAlongStroke(
  meshes: THREE.Mesh[],
  camera: THREE.Camera,
  stroke: SlashStroke,
  tip: DesignPoint,
  _from?: DesignPoint,
  _speed = 0,
): { c0: DesignPoint; c1: DesignPoint } | null {
  const locked = stroke.enterLock;
  const trackedId = stroke.progress.size ? [...stroke.progress.keys()][0] : null;
  const st = trackedId != null ? stroke.progress.get(trackedId) : undefined;
  const mesh =
    (trackedId != null ? meshes.find((m) => m.id === trackedId) : undefined) ??
    meshes.find((m) => !stroke.slicedIds.has(m.id));
  if (!mesh) return null;
  const proj = projectMeshHull(mesh, camera);
  if (!proj) return null;
  const a =
    syncLockedA(stroke, mesh, camera, proj.hull) ?? locked?.c0 ?? st?.c0;
  if (!a) return null;
  if (stroke.enterLock?.dead) return null;
  if (!pointInConvexHull(tip, proj.hull)) {
    const line = clipInfiniteLineToHull(a, tip, proj.hull);
    if (!line) return null;
    const exit = line[1];
    if (!twoEdges(stroke.enterLock?.enterEdge ?? st?.enterEdge ?? -1, closestHullEdge(exit, proj.hull), a, exit, proj.hull)) {
      return null;
    }
    if (chordLength(a, exit) < 1) return null;
    return { c0: a, c1: exit };
  }

  const hit =
    clipChordToHull(a, tip, proj.hull) ?? clipBackToEnter(a, tip, proj.hull);
  if (hit && chordLength(a, hit.c1) >= 1) {
    return { c0: a, c1: hit.c1 };
  }
  return null;
}

/** 抬手时的那一刀。纸外才成立：出点是 A 穿过刀尖打到对面边上的交点。 */
export function cutOnRelease(
  meshes: THREE.Mesh[],
  camera: THREE.Camera,
  stroke: SlashStroke,
  tip: DesignPoint,
): CutTarget | null {
  const line = crackAlongStroke(meshes, camera, stroke, tip);
  if (!line) return null;
  const trackedId = stroke.progress.size ? [...stroke.progress.keys()][0] : null;
  const mesh =
    (trackedId != null ? meshes.find((m) => m.id === trackedId) : undefined) ??
    meshes.find((m) => !stroke.slicedIds.has(m.id));
  if (!mesh) return null;
  const proj = projectMeshHull(mesh, camera);
  if (!proj || pointInConvexHull(tip, proj.hull)) return null;
  return {
    mesh,
    c0: line.c0,
    c1: line.c1,
    chord: chordLength(line.c0, line.c1),
    enterEdge: stroke.enterLock?.enterEdge ?? -1,
  };
}

export function resolveCutBySegment(
  meshes: THREE.Mesh[],
  camera: THREE.Camera,
  stroke: SlashStroke,
  seg: [DesignPoint, DesignPoint],
  skipIds: Set<number>,
  dtSec: number,
): CutTarget | null {
  const [a, b] = seg;
  debugWhy = '';
  if (chordLength(a, b) < 1e-4) return note('微段太短');

  if (stepFollow(stroke, a, b, meshes, camera, dtSec)) {
    return note('走廊余势（贴着上一刀）');
  }

  const live = meshes.filter(
    (m) => !stroke.slicedIds.has(m.id) && !skipIds.has(m.id),
  );

  const trackedId = stroke.progress.size ? [...stroke.progress.keys()][0] : null;

  if (trackedId != null) {
    const mesh = live.find((m) => m.id === trackedId);
    const st = stroke.progress.get(trackedId);
    if (!mesh || !st) {
      stroke.progress.clear();
      if (stroke.enterLock?.meshId === trackedId) stroke.enterLock = null;
      return note('跟踪的板没了');
    }
    const proj = projectMeshHull(mesh, camera);
    if (!proj) {
      stroke.progress.clear();
      if (stroke.enterLock?.meshId === trackedId) stroke.enterLock = null;
      return note('凸包投影失败');
    }
    const lockedA = syncLockedA(stroke, mesh, camera, proj.hull);
    if (lockedA) {
      st.c0 = lockedA;
      st.enterEdge = stroke.enterLock?.enterEdge ?? st.enterEdge;
    }
    addInBoardPath(stroke, a, b, proj.hull);
    const clipped = clipChordToHull(a, b, proj.hull);
    if (clipped) {
      st.c1 = clipped.c1;
      st.chord += chordLength(clipped.c0, clipped.c1);
    }
    const nowInside = pointInConvexHull(b, proj.hull);
    st.inside = nowInside;
    if (nowInside) return note('纸内，抬手不切');

    /**
     * 真出边：微段可能跳过凸包（插值稀）。微段裁不到时用 A→刀尖无限直线出点。
     * 同边蹭丢掉跟踪（出板清 A）。
     */
    let c0 = st.c0;
    let c1 = clipped?.c1 ?? st.c1;
    let exitEdge = clipped
      ? clipped.exitEdge
      : closestHullEdge(c1, proj.hull);
    const microOk =
      !!clipped && twoEdges(st.enterEdge, exitEdge, c0, c1, proj.hull);
    if (!microOk) {
      const line = clipInfiniteLineToHull(st.c0, b, proj.hull);
      if (line) {
        c0 = st.c0;
        c1 = line[1];
        exitEdge = closestHullEdge(c1, proj.hull);
      }
    }
    if (!twoEdges(st.enterEdge, exitEdge, c0, c1, proj.hull)) {
      endUncutAttempt(stroke, trackedId);
      return note(`取消 出纸后切不成 e${st.enterEdge}→e${exitEdge}`);
    }
    return note('出点跟手，抬手才切');
  }

  for (const mesh of live) {
    const proj = projectMeshHull(mesh, camera);
    if (!proj) continue;
    const insideB = pointInConvexHull(b, proj.hull);
    const outside = recentOutside(stroke.points, proj.hull, START.fastDist * 3);
    const fromOutside = !pointInConvexHull(a, proj.hull);
    const micro = clipChordToHull(a, b, proj.hull);
    const strokeClip =
      outside && insideB
        ? clipChordToHull(outside, b, proj.hull) ??
          clipBackToEnter(outside, b, proj.hull)
        : null;
    const clipped = strokeClip ?? micro;

    if (fromOutside && micro && !insideB) {
      const c0 = snapEnterCorner(micro.c0, proj.hull);
      const c1 = micro.c1;
      const enterEdge = micro.enterEdge;
      const exitEdge = micro.exitEdge;
      lockEnter(stroke, mesh, camera, c0, b, enterEdge, true);
      if (!stroke.enterLock) continue;
      if (!twoEdges(enterEdge, exitEdge, c0, c1, proj.hull)) {
        endUncutAttempt(stroke, mesh.id);
        return note(`取消 出纸后切不成 e${enterEdge}→e${exitEdge}`);
      }
      return note('出点跟手，抬手才切');
    }

    if (insideB && (fromOutside || outside) && clipped) {
      lockEnter(stroke, mesh, camera, snapEnterCorner(clipped.c0, proj.hull), b, clipped.enterEdge, true);
      return note('已锁 A，等出边');
    }

    /**
     * 贴边锁 A：下手已在边附近（第一刀发糊），
     * 或本按已切过且刀尖贴边（尖角后的第二刀）。
     */
    if (insideB && !fromOutside && !outside && stroke.points.length > 0) {
      const speed = medianSpeed(stroke, segmentSpeedPxPerSec(a, b, dtSec));
      const radius = startRadius(speed);
      const near = rankedHullEdges(b, proj.hull)[0];
      if (!near || near.dist > radius) continue;
      const second = stroke.slicedIds.size > 0;
      const down = rankedHullEdges(stroke.points[0], proj.hull)[0];
      const downOk = !!down && down.dist <= radius;
      if (second || downOk) {
        lockEnter(stroke, mesh, camera, snapEnterCorner(near.point, proj.hull), b, near.edge, true);
        return note('已锁 A，等出边');
      }
    }
  }
  if (!debugWhy) note(stroke.armed ? '未入板' : '未出刃');
  return null;
}

export function updateSlashIntent(
  stroke: SlashStroke,
  preview: CutTarget | null,
  seg: [DesignPoint, DesignPoint],
  dtSec: number,
): { c0: DesignPoint; c1: DesignPoint } | null {
  const it = stroke.intent;
  if (!preview) {
    resetLock(stroke);
    return null;
  }

  const segLen = hypot(seg[1].x - seg[0].x, seg[1].y - seg[0].y);
  if (segLen < 0.5) {
    return it.locked && it.c0 && it.c1 ? { c0: it.c0, c1: it.c1 } : null;
  }

  const ang = headingAngleDeg(
    seg[1].x - seg[0].x,
    seg[1].y - seg[0].y,
    preview.c1.x - preview.c0.x,
    preview.c1.y - preview.c0.y,
  );
  const fromEnter = hypot(seg[1].x - preview.c0.x, seg[1].y - preview.c0.y);
  const speed = segmentSpeedPxPerSec(seg[0], seg[1], dtSec);

  if (it.locked) {
    if (ang > INTENT.unlockAngle) {
      resetLock(stroke);
      return null;
    }
    it.c0 = preview.c0;
    it.c1 = preview.c1;
    return { c0: it.c0, c1: it.c1 };
  }

  const aligned =
    ang <= INTENT.lockAngle &&
    fromEnter >= INTENT.minFromEnter &&
    speed >= INTENT.minSpeed;

  if (!aligned) {
    it.stable = 0;
    return null;
  }

  it.stable += 1;
  if (it.stable < INTENT.lockSegs) return null;

  it.locked = true;
  it.c0 = preview.c0;
  it.c1 = preview.c1;
  return { c0: it.c0, c1: it.c1 };
}

export function stepSlashIntent(
  meshes: THREE.Mesh[],
  camera: THREE.Camera,
  stroke: SlashStroke,
  seg: [DesignPoint, DesignPoint],
  skipIds: Set<number>,
  dtSec: number,
): IntentFrame {
  const tip = seg[1];
  const speed = pushSpeed(
    stroke,
    segmentSpeedPxPerSec(seg[0], tip, dtSec),
  );
  const it = stroke.intent;

  const crack = crackAlongStroke(meshes, camera, stroke, tip, seg[0], speed);
  const commit = resolveCutBySegment(
    meshes,
    camera,
    stroke,
    seg,
    skipIds,
    dtSec,
  );

  const cyan = previewCutChord(meshes, camera, stroke, tip, seg[0]);
  const travelRatio = cyan ? travelAlongCyan(cyan.c0, cyan.c1, tip) : 0;
  const scribble = debugWhy.startsWith('取消');

  const trackedId = stroke.progress.size
    ? [...stroke.progress.keys()][0]
    : null;
  const st = trackedId != null ? stroke.progress.get(trackedId) : undefined;

  let phase: IntentPhase = 'idle';
  if (followBlocks(stroke, seg[0], tip, meshes, camera)) phase = 'hold';
  else if (it.locked) phase = 'aimed';
  else if (trackedId != null) phase = 'track';
  else if (stroke.armed) phase = 'arming';

  return {
    phase,
    enter: st?.c0 ?? commit?.c0 ?? null,
    enterEdge: st?.enterEdge ?? -1,
    meshId: trackedId ?? commit?.mesh.id ?? null,
    cyan,
    crack,
    locked: it.locked,
    travelRatio,
    speed,
    commit,
    commitFlash: false,
    scribble,
    why:
      debugWhy ||
      (followBlocks(stroke, seg[0], tip, meshes, camera)
        ? '走廊余势（贴着上一刀）'
        : ''),
  };
}
