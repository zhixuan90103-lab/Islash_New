import * as THREE from 'three';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from '../adapt/design';
import { PAPER, PUZZLE, viewHalfH } from './design';
import { type Poly2 } from './woodProfile';
import { createChamferedSolid } from './woodChamfer';
import {
  TURTLE,
  localIsDark,
  turtleEyeCenter,
  turtleHeadPoly,
  turtleParts,
  type TurtlePart,
} from './turtleLevel';
import { BUTTERFLY, butterflyEyes, butterflyParts, type ButterflyPart } from './butterflyLevel';
import type { SlashPhysics } from './slashPhysics';

export type PuzzlePhase = 'show' | 'fly' | 'cut' | 'place' | 'install' | 'inspect' | 'score';

export type PieceRole = 'stock';

export type CutPuzzle = {
  phase: () => PuzzlePhase;
  canCut: () => boolean;
  cuts: () => number;
  level: () => 'turtle' | 'butterfly';
  /** 记下这一刀的两块，并扣一步。步数用完后不再能切。 */
  onCut: (a: THREE.Mesh, b: THREE.Mesh) => 'ok' | 'submit';
  forget: (mesh: THREE.Mesh) => void;
  requestInstall: () => void;
  step: (dt: number) => void;
  dispose: () => void;
};

function polyArea(poly: Poly2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  }
  return Math.abs(a) * 0.5;
}

function centeredIou(poly: Poly2[], slot: Poly2[]): number {
  const cK = polyCentroid(poly);
  const cT = polyCentroid(slot);
  const dx = cT.x - cK.x;
  const dy = cT.y - cK.y;
  const moved = poly.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  return rasterIou(moved, slot);
}

function polyCentroid(poly: Poly2[]): Poly2 {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  const n = Math.max(1, poly.length);
  return { x: x / n, y: y / n };
}

function rasterIou(keep: Poly2[], target: Poly2[]): number {
  const n = 48;
  const pad = TURTLE.r * 1.35;
  const cell = (2 * pad) / n;
  let both = 0;
  let either = 0;
  for (let iy = 0; iy < n; iy++) {
    const y = -pad + (iy + 0.5) * cell;
    for (let ix = 0; ix < n; ix++) {
      const x = -pad + (ix + 0.5) * cell;
      const inT = pointInPoly(x, y, target);
      const inK = pointInPoly(x, y, keep);
      if (inT || inK) either++;
      if (inT && inK) both++;
    }
  }
  return either <= 0 ? 0 : both / either;
}

function turnPoly(poly: Poly2[], a: number, c: Poly2): Poly2[] {
  const co = Math.cos(a);
  const si = Math.sin(a);
  return poly.map((p) => {
    const x = p.x - c.x;
    const y = p.y - c.y;
    return { x: c.x + x * co - y * si, y: c.y + x * si + y * co };
  });
}

/** 在 24 个朝向里挑和零件最贴的一个。形状仍是切出来的那块。 */
function bestTurn(poly: Poly2[], slot: Poly2[]): { a: number; iou: number } {
  const c = polyCentroid(poly);
  let bestA = 0;
  let best = -1;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const iou = centeredIou(turnPoly(poly, a, c), slot);
    if (iou > best) {
      best = iou;
      bestA = a;
    }
  }
  return { a: bestA, iou: best };
}

function colorHit(mesh: THREE.Mesh, wantDark: boolean): number {
  const raw = (mesh.userData.profile as Poly2[] | undefined) ?? [];
  if (raw.length < 3) return 0;
  let hit = 0;
  let n = 0;
  const step = Math.max(1, Math.floor(raw.length / 12));
  for (let i = 0; i < raw.length; i += step) {
    n += 1;
    if (localIsDark(raw[i].y) === wantDark) hit += 1;
  }
  return n === 0 ? 0 : hit / n;
}

const _ray = new THREE.Raycaster();
const _plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const _hit = new THREE.Vector3();

function pointInPoly(x: number, y: number, poly: Poly2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const hit =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function worldPoly(mesh: THREE.Mesh): Poly2[] {
  const raw = (mesh.userData.profile as Poly2[] | undefined) ?? [];
  const e = mesh.matrixWorld.elements;
  return raw.map((p) => ({
    x: e[0] * p.x + e[4] * p.y + e[12],
    y: e[1] * p.x + e[5] * p.y + e[13],
  }));
}

function makePartMesh(
  profile: Poly2[],
  face: THREE.Material,
  edge: THREE.Material,
): THREE.Mesh {
  const depth = PAPER.depth;
  const geom =
    createChamferedSolid(profile, depth, PAPER.edgeInset) ??
    new THREE.CircleGeometry(TURTLE.r, 20);
  const mesh = new THREE.Mesh(geom, [face, edge]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.profile = profile;
  mesh.position.z = 0;
  return mesh;
}

/** 外形和颜色都进分。公式以后再调，低分也过关。 */
function starRank(shape: number, color: number): number {
  const q = shape * 0.65 + color * 0.35;
  if (q >= 0.62) return 3;
  if (q >= 0.38) return 2;
  return 1;
}

export function createCutPuzzle(opts: {
  scene: THREE.Scene;
  uiRoot: HTMLElement | null;
  physics: SlashPhysics;
  spawnBoard: () => void;
  clearBoard: () => void;
  beginEnter: () => void;
  haltFly: () => void;
  camera: THREE.Camera;
  faceMat: THREE.MeshLambertMaterial;
  edgeMat: THREE.MeshLambertMaterial;
}): CutPuzzle {
  const shadowFace = new THREE.MeshLambertMaterial({ color: TURTLE.shadow });
  const shadowEdge = new THREE.MeshLambertMaterial({ color: 0xaeb6b0 });
  const headFace = new THREE.MeshLambertMaterial({ color: TURTLE.dark });
  const headEdge = new THREE.MeshLambertMaterial({ color: 0x166b2c });
  const eyeMat = new THREE.MeshBasicMaterial({ color: TURTLE.eye });
  let level: 'turtle' | 'butterfly' = 'butterfly';
  let parts: Array<TurtlePart | ButterflyPart> = [];
  const slots = new Map<string, THREE.Mesh>();
  const extras: THREE.Mesh[] = [];
  const cardW = 2.05;
  const cardH = 3.05;
  const cardR = 0.22;
  const cardShape = new THREE.Shape();
  const hw = cardW / 2;
  const hh = cardH / 2;
  cardShape.moveTo(-hw + cardR, -hh);
  cardShape.lineTo(hw - cardR, -hh);
  cardShape.absarc(hw - cardR, -hh + cardR, cardR, -Math.PI / 2, 0, false);
  cardShape.lineTo(hw, hh - cardR);
  cardShape.absarc(hw - cardR, hh - cardR, cardR, 0, Math.PI / 2, false);
  cardShape.lineTo(-hw + cardR, hh);
  cardShape.absarc(-hw + cardR, hh - cardR, cardR, Math.PI / 2, Math.PI, false);
  cardShape.lineTo(-hw, -hh + cardR);
  cardShape.absarc(-hw + cardR, -hh + cardR, cardR, Math.PI, Math.PI * 1.5, false);
  const card = new THREE.Mesh(
    new THREE.ShapeGeometry(cardShape),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  card.position.z = -0.05;
  const board = new THREE.Group();
  board.add(card);
  opts.scene.add(board);

  const dropMesh = (mesh: THREE.Mesh) => {
    board.remove(mesh);
    mesh.geometry.dispose();
  };

  const mountLevel = () => {
    for (const mesh of slots.values()) dropMesh(mesh);
    slots.clear();
    for (const mesh of extras) dropMesh(mesh);
    extras.length = 0;
    parts = level === 'turtle' ? turtleParts() : butterflyParts();
    for (const part of parts) {
      const mesh = makePartMesh(part.poly, shadowFace, shadowEdge);
      mesh.name = part.id;
      slots.set(part.id, mesh);
      board.add(mesh);
    }
    const z = PAPER.depth * 0.7;
    if (level === 'turtle') {
      const head = makePartMesh(turtleHeadPoly(), headFace, headEdge);
      extras.push(head);
      board.add(head);
      const eyeAt = turtleEyeCenter();
      const eye = new THREE.Mesh(new THREE.CircleGeometry(TURTLE.r * 0.07, 16), eyeMat);
      eye.position.set(eyeAt.x, eyeAt.y, z);
      extras.push(eye);
      board.add(eye);
      return;
    }
    for (const at of butterflyEyes()) {
      const eye = new THREE.Mesh(new THREE.CircleGeometry(BUTTERFLY.r * 0.055, 16), eyeMat);
      eye.position.set(at.x, at.y, z);
      extras.push(eye);
      board.add(eye);
    }
  };
  mountLevel();
  board.position.set(0, 0, 0);
  board.scale.set(1, 1, 1);
  board.visible = false;

  const hit = document.createElement('button');
  hit.type = 'button';
  hit.className = 'puzzle-submit-hit';
  hit.textContent = '装上';
  hit.setAttribute('aria-label', '装上');
  hit.tabIndex = -1;

  const starsEl = document.createElement('div');
  starsEl.className = 'puzzle-stars';
  starsEl.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) {
    const d = document.createElement('span');
    d.className = 'puzzle-star';
    starsEl.appendChild(d);
  }

  const hud = document.createElement('div');
  hud.className = 'puzzle-hud';
  hud.setAttribute('aria-hidden', 'true');
  const chip = document.createElement('div');
  chip.className = 'puzzle-art-chip';
  const chipInner = document.createElement('div');
  chipInner.className = 'puzzle-art-chip-inner';
  chip.appendChild(chipInner);
  const stepsEl = document.createElement('div');
  stepsEl.className = 'puzzle-move';
  const stepsLabel = document.createElement('div');
  stepsLabel.className = 'puzzle-move-label';
  stepsLabel.textContent = '步';
  const stepsNum = document.createElement('div');
  stepsNum.className = 'puzzle-move-n';
  stepsEl.append(stepsLabel, stepsNum);
  hud.append(chip, stepsEl);
  hud.classList.add('is-on');

  const preview = document.createElement('div');
  preview.className = 'puzzle-preview-card';
  preview.setAttribute('aria-hidden', 'true');

  const sparkles = document.createElement('div');
  sparkles.className = 'puzzle-sparkles';
  sparkles.setAttribute('aria-hidden', 'true');
  const sparkleLayout: Array<[string, string, string, boolean]> = [
    ['12%', '22%', '8px', false],
    ['86%', '18%', '10px', false],
    ['8%', '48%', '7px', false],
    ['92%', '52%', '9px', false],
    ['18%', '78%', '11px', false],
    ['78%', '82%', '8px', false],
    ['10%', '36%', '18px', true],
    ['84%', '72%', '16px', true],
  ];
  for (const [left, top, size, star] of sparkleLayout) {
    const d = document.createElement('span');
    d.className = star ? 'puzzle-sparkle is-star' : 'puzzle-sparkle';
    d.style.left = left;
    d.style.top = top;
    d.style.width = size;
    d.style.height = size;
    sparkles.appendChild(d);
  }

  if (opts.uiRoot) {
    opts.uiRoot.appendChild(sparkles);
    opts.uiRoot.appendChild(hud);
    opts.uiRoot.appendChild(preview);
    opts.uiRoot.appendChild(hit);
    opts.uiRoot.appendChild(starsEl);
  }

  let phase: PuzzlePhase = 'show';
  let t = 0;
  let cuts = 0;
  let stepsLeft = 0;
  let stars = 0;
  let buttonLatched = false;
  const frags: THREE.Mesh[] = [];
  let installs: {
    mesh: THREE.Mesh;
    from: THREE.Vector3;
    to: THREE.Vector3;
    fromQ: THREE.Quaternion;
    toQ: THREE.Quaternion;
    u: number;
  }[] = [];

  const setThumbHit = (on: boolean) => {
    hit.classList.toggle('is-on', on);
  };

  const stepBudget = () =>
    level === 'butterfly' ? PUZZLE.stepsButterfly : PUZZLE.stepsTurtle;

  const paintSteps = () => {
    stepsNum.textContent = String(Math.max(0, stepsLeft));
    stepsEl.classList.toggle('is-on', phase === 'cut');
  };

  const hudPose = () => {
    const stage = document.getElementById('stage');
    const halfH = viewHalfH();
    const halfW = halfH * (DESIGN_WIDTH / DESIGN_HEIGHT);
    const hexPx = (2 * TURTLE.r * DESIGN_HEIGHT) / (2 * halfH);
    let x = 0;
    let y = halfH * 0.72;
    let targetPx = 62;
    if (stage) {
      const sr = stage.getBoundingClientRect();
      const cr = chipInner.getBoundingClientRect();
      if (sr.width > 1 && cr.width > 1) {
        const cx = ((cr.left + cr.width / 2 - sr.left) / sr.width) * DESIGN_WIDTH;
        const cy = ((cr.top + cr.height / 2 - sr.top) / sr.height) * DESIGN_HEIGHT;
        x = (cx / DESIGN_WIDTH - 0.5) * 2 * halfW;
        y = (0.5 - cy / DESIGN_HEIGHT) * 2 * halfH;
        targetPx = (cr.height / sr.height) * DESIGN_HEIGHT * 0.62;
      }
    }
    return { x, y, s: Math.max(0.12, Math.min(0.45, targetPx / hexPx)) };
  };

  const placePattern = (mode: 'full' | 'cut') => {
    hud.classList.add('is-on');
    preview.classList.remove('is-on');
    board.visible = true;
    if (mode === 'cut') {
      const p = hudPose();
      board.position.set(p.x, p.y, 0);
      board.scale.setScalar(p.s);
    } else if (phase !== 'fly') {
      board.position.set(0, 0, 0);
      board.scale.set(1, 1, 1);
    }
  };

  let fly: {
    u: number;
    from: THREE.Vector3;
    to: THREE.Vector3;
    fromS: number;
    toS: number;
  } | null = null;

  const startFly = () => {
    phase = 'fly';
    t = 0;
    const p = hudPose();
    fly = {
      u: 0,
      from: board.position.clone(),
      to: new THREE.Vector3(p.x, p.y, 0),
      fromS: board.scale.x,
      toS: p.s,
    };
  };

  const resetPieces = () => {
    frags.length = 0;
    installs = [];
    buttonLatched = false;
  };

  const beginCut = () => {
    phase = 'cut';
    t = 0;
    cuts = 0;
    stepsLeft = stepBudget();
    resetPieces();
    for (const mesh of slots.values()) mesh.visible = true;
    placePattern('cut');
    paintSteps();
    setThumbHit(false);
    opts.spawnBoard();
    opts.beginEnter();
  };

  const scoreOf = (mesh: THREE.Mesh, part: { poly: Poly2[] }) => {
    mesh.updateMatrixWorld(true);
    const poly = worldPoly(mesh);
    const ratio = polyArea(poly) / Math.max(1e-6, polyArea(part.poly));
    return { iou: bestTurn(poly, part.poly).iou, ratio };
  };

  const bestAssignment = () => {
    const live = frags.filter((m) => ((m.userData.profile as Poly2[] | undefined)?.length ?? 0) >= 3);
    const cands: { mesh: THREE.Mesh; id: string; iou: number; ratio: number }[] = [];
    for (const mesh of live) {
      for (const part of parts) {
        const s = scoreOf(mesh, part);
        cands.push({ mesh, id: part.id, iou: s.iou, ratio: s.ratio });
      }
    }
    cands.sort((a, b) => b.iou - a.iou);
    const usedM = new Set<THREE.Mesh>();
    const usedP = new Set<string>();
    const won: { mesh: THREE.Mesh; id: string; iou: number; ratio: number }[] = [];
    for (const c of cands) {
      if (usedM.has(c.mesh) || usedP.has(c.id)) continue;
      usedM.add(c.mesh);
      usedP.add(c.id);
      won.push(c);
      if (won.length === parts.length) break;
    }
    return won;
  };

  const refreshButton = () => {
    if (!buttonLatched) {
      const won = bestAssignment();
      buttonLatched =
        won.length === parts.length &&
        won.every(
          (w) =>
            w.iou >= TURTLE.showIou &&
            w.ratio >= TURTLE.showRatioMin &&
            w.ratio <= TURTLE.showRatioMax,
        );
    }
    if (phase === 'cut' && stepsLeft <= 0) buttonLatched = true;
    setThumbHit(phase === 'cut' && buttonLatched);
    paintSteps();
  };

  const forget = (mesh: THREE.Mesh) => {
    const i = frags.indexOf(mesh);
    if (i >= 0) frags.splice(i, 1);
  };

  const beginInstall = () => {
    if (phase !== 'cut' || !buttonLatched) return;
    phase = 'place';
    t = 0;
    paintSteps();
    placePattern('full');
    opts.haltFly();
    const lift = PAPER.depth * 2;
    for (const mesh of frags) {
      opts.physics.removeMesh(mesh);
      mesh.position.z = lift;
    }
    hit.textContent = '完成';
    setThumbHit(true);
  };

  const finishPlace = () => {
    if (phase !== 'place') return;
    const live = frags.filter(
      (m) => ((m.userData.profile as Poly2[] | undefined)?.length ?? 0) >= 3,
    );
    const cands: { mesh: THREE.Mesh; id: string; iou: number }[] = [];
    for (const mesh of live) {
      mesh.updateMatrixWorld(true);
      const poly = worldPoly(mesh);
      for (const part of parts) {
        cands.push({ mesh, id: part.id, iou: rasterIou(poly, part.poly) });
      }
    }
    cands.sort((a, b) => b.iou - a.iou);
    const usedM = new Set<THREE.Mesh>();
    const usedP = new Set<string>();
    const won = new Map<string, { mesh: THREE.Mesh; iou: number }>();
    for (const c of cands) {
      if (usedM.has(c.mesh) || usedP.has(c.id)) continue;
      usedM.add(c.mesh);
      usedP.add(c.id);
      won.set(c.id, { mesh: c.mesh, iou: c.iou });
    }
    const ious: number[] = [];
    const colors: number[] = [];
    for (const part of parts) {
      const got = won.get(part.id);
      ious.push(got?.iou ?? 0);
      if (!got) colors.push(0);
      else colors.push(part.dark == null ? 1 : colorHit(got.mesh, part.dark));
      const slot = slots.get(part.id);
      if (slot && (got?.iou ?? 0) > 0.2) slot.visible = false;
    }
    const shape = ious.reduce((s, n) => s + n, 0) / Math.max(1, ious.length);
    const color = colors.reduce((s, n) => s + n, 0) / Math.max(1, colors.length);
    stars = starRank(shape, color);
    phase = 'inspect';
    t = 0;
    fingers.clear();
    spin = null;
    if (held) held.position.z = PAPER.depth * 2;
    held = null;
    hit.textContent = '装上';
    setThumbHit(false);
  };

  hit.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (phase === 'cut' && buttonLatched) beginInstall();
    else if (phase === 'place') finishPlace();
  });

  const stage = document.getElementById('stage');
  const fingers = new Map<number, { x: number; y: number }>();
  let held: THREE.Mesh | null = null;
  let spin: { ang: number } | null = null;

  const pairAngle = () => {
    const pts = [...fingers.values()];
    if (pts.length < 2) return null;
    const a = pts[0];
    const b = pts[1];
    return {
      ang: Math.atan2(b.y - a.y, b.x - a.x),
      x: (a.x + b.x) * 0.5,
      y: (a.y + b.y) * 0.5,
    };
  };

  const spinHeld = (dA: number, px: number, py: number) => {
    if (!held) return;
    const dx = held.position.x - px;
    const dy = held.position.y - py;
    const co = Math.cos(dA);
    const si = Math.sin(dA);
    held.position.x = px + dx * co - dy * si;
    held.position.y = py + dx * si + dy * co;
    held.rotateZ(dA);
  };

  const worldOnPlane = (e: PointerEvent): { x: number; y: number } | null => {
    if (!stage) return null;
    const r = stage.getBoundingClientRect();
    const w = r.width || 1;
    const h = r.height || 1;
    const ndcX = ((e.clientX - r.left) / w) * 2 - 1;
    const ndcY = -(((e.clientY - r.top) / h) * 2 - 1);
    _ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), opts.camera);
    if (!_ray.ray.intersectPlane(_plane, _hit)) return null;
    return { x: _hit.x, y: _hit.y };
  };

  const pickFrag = (x: number, y: number): THREE.Mesh | null => {
    let best: THREE.Mesh | null = null;
    let bestArea = Infinity;
    for (const mesh of frags) {
      mesh.updateMatrixWorld(true);
      const poly = worldPoly(mesh);
      if (poly.length < 3 || !pointInPoly(x, y, poly)) continue;
      const area = polyArea(poly);
      if (area < bestArea) {
        best = mesh;
        bestArea = area;
      }
    }
    return best;
  };

  const onPlaceDown = (e: PointerEvent) => {
    if (phase !== 'place' || e.button !== 0) return;
    const at = worldOnPlane(e);
    if (!at) return;
    fingers.set(e.pointerId, at);
    stage?.setPointerCapture(e.pointerId);
    if (!held) {
      const mesh = pickFrag(at.x, at.y);
      if (!mesh) {
        if (fingers.size < 2) fingers.delete(e.pointerId);
        return;
      }
      held = mesh;
      mesh.position.z = PAPER.depth * 3;
    }
    const pair = pairAngle();
    if (pair && held) spin = { ang: pair.ang };
  };

  const onPlaceMove = (e: PointerEvent) => {
    const prev = fingers.get(e.pointerId);
    if (!prev || !held) return;
    const at = worldOnPlane(e);
    if (!at) return;
    fingers.set(e.pointerId, at);
    const pair = pairAngle();
    if (pair && spin && fingers.size >= 2) {
      let dA = pair.ang - spin.ang;
      if (dA > Math.PI) dA -= Math.PI * 2;
      if (dA < -Math.PI) dA += Math.PI * 2;
      spinHeld(dA, pair.x, pair.y);
      spin.ang = pair.ang;
      return;
    }
    held.position.x += at.x - prev.x;
    held.position.y += at.y - prev.y;
  };

  const onPlaceUp = (e: PointerEvent) => {
    fingers.delete(e.pointerId);
    spin = null;
    if (fingers.size === 0) {
      if (held) held.position.z = PAPER.depth * 2;
      held = null;
      return;
    }
    const pair = pairAngle();
    if (pair && held) spin = { ang: pair.ang };
  };

  stage?.addEventListener('pointerdown', onPlaceDown);
  stage?.addEventListener('pointermove', onPlaceMove);
  stage?.addEventListener('pointerup', onPlaceUp);
  stage?.addEventListener('pointercancel', onPlaceUp);

  return {
    phase: () => phase,
    canCut: () => phase === 'cut' && stepsLeft > 0,
    cuts: () => cuts,
    level: () => level,
    forget,
    onCut: (a, b) => {
      if (phase !== 'cut') return 'ok';
      for (const mesh of [a, b]) {
        mesh.userData.puzzleRole = 'stock';
        frags.push(mesh);
      }
      cuts += 1;
      stepsLeft = Math.max(0, stepsLeft - 1);
      refreshButton();
      return 'ok';
    },
    requestInstall: () => beginInstall(),
    step: (dt) => {
      t += dt;
      if (phase === 'show') {
        placePattern('full');
        if (t >= PUZZLE.showDur) startFly();
        return;
      }
      if (phase === 'fly' && fly) {
        fly.u = Math.min(1, fly.u + dt / 0.48);
        const u = 1 - (1 - fly.u) ** 3;
        board.position.lerpVectors(fly.from, fly.to, u);
        const s = fly.fromS + (fly.toS - fly.fromS) * u;
        board.scale.setScalar(s);
        if (fly.u >= 1) {
          fly = null;
          beginCut();
        }
        return;
      }
      if (phase === 'install' && installs.length) {
        let done = true;
        for (const install of installs) {
          install.u = Math.min(1, install.u + dt / PUZZLE.installDur);
          const u = 1 - (1 - install.u) ** 2;
          install.mesh.position.lerpVectors(install.from, install.to, u);
          install.mesh.quaternion.slerpQuaternions(install.fromQ, install.toQ, u);
          if (install.u < 1) done = false;
        }
        if (done) {
          phase = 'inspect';
          t = 0;
        }
        return;
      }
      if (phase === 'inspect') {
        if (t >= PUZZLE.inspectDur) {
          phase = 'score';
          t = 0;
          starsEl.dataset.n = String(stars);
          starsEl.classList.add('is-on');
        }
        return;
      }
      if (phase === 'score') {
        if (t >= PUZZLE.scoreDur) {
          starsEl.classList.remove('is-on');
          starsEl.dataset.n = '0';
          installs = [];
          t = 0;
          opts.clearBoard();
          level = level === 'butterfly' ? 'turtle' : 'butterfly';
          mountLevel();
          phase = 'show';
          placePattern('full');
        }
      }
    },
    dispose: () => {
      hit.remove();
      hud.remove();
      stage?.removeEventListener('pointerdown', onPlaceDown);
      stage?.removeEventListener('pointermove', onPlaceMove);
      stage?.removeEventListener('pointerup', onPlaceUp);
      stage?.removeEventListener('pointercancel', onPlaceUp);
      preview.remove();
      sparkles.remove();
      starsEl.remove();
      opts.scene.remove(board);
      for (const mesh of slots.values()) mesh.geometry.dispose();
      for (const mesh of extras) mesh.geometry.dispose();
      card.geometry.dispose();
      (card.material as THREE.Material).dispose();
      eyeMat.dispose();
      shadowFace.dispose();
      shadowEdge.dispose();
      headFace.dispose();
      headEdge.dispose();
    },
  };
}
