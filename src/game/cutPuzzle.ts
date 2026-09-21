import * as THREE from 'three';
import { bevelInset, PUZZLE, woodSize } from './design';
import { circleProfileAt, type Poly2 } from './woodProfile';
import { createChamferedSolid, createWoodSolid } from './woodChamfer';
import type { SlashPhysics } from './slashPhysics';

export type PuzzlePhase = 'show' | 'cut' | 'install' | 'inspect' | 'score';

export type CutPuzzle = {
  phase: () => PuzzlePhase;
  canCut: () => boolean;
  cuts: () => number;
  onCut: (keep: THREE.Mesh, drop: THREE.Mesh) => 'ok' | 'submit';
  requestInstall: () => void;
  step: (dt: number) => void;
  dispose: () => void;
};

function sectorPoly(r: number, segs = 14): Poly2[] {
  const pts: Poly2[] = [{ x: 0, y: 0 }];
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * (Math.PI / 2);
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return pts;
}

function rasterIou(keep: Poly2[], target: Poly2[]): number {
  const n = 48;
  const pad = PUZZLE.patternR * 1.15;
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

function rightAngleIndex(poly: Poly2[]): number {
  let bestI = 0;
  let best = 1e9;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const a = poly[(i - 1 + n) % n];
    const b = poly[(i + 1) % n];
    const x1 = a.x - p.x;
    const y1 = a.y - p.y;
    const x2 = b.x - p.x;
    const y2 = b.y - p.y;
    const l1 = Math.hypot(x1, y1) || 1;
    const l2 = Math.hypot(x2, y2) || 1;
    const ang = Math.acos(
      Math.min(1, Math.max(-1, (x1 * x2 + y1 * y2) / (l1 * l2))),
    );
    const d = Math.abs(ang - Math.PI / 2);
    if (d < best) {
      best = d;
      bestI = i;
    }
  }
  return bestI;
}

/** 直角顶对准圆心，两条边贴缺口的 +X / +Y。不搜任意转角。 */
function seatAsQuarter(mesh: THREE.Mesh): {
  to: THREE.Vector3;
  q: THREE.Quaternion;
  seated: Poly2[];
  iou: number;
} {
  mesh.updateMatrixWorld(true);
  const poly = worldPoly(mesh);
  const n = poly.length;
  const i = rightAngleIndex(poly);
  const v = poly[i];
  const a = poly[(i - 1 + n) % n];
  const b = poly[(i + 1) % n];
  const e0 = { x: a.x - v.x, y: a.y - v.y };
  const e1 = { x: b.x - v.x, y: b.y - v.y };
  const cross = e0.x * e1.y - e0.y * e1.x;
  const first = cross >= 0 ? e0 : e1;
  const second = cross >= 0 ? e1 : e0;
  let rot = -Math.atan2(first.y, first.x);
  let c = Math.cos(rot);
  let s = Math.sin(rot);
  const oy = s * second.x + c * second.y;
  if (oy < 0) rot = -Math.atan2(second.y, second.x);
  c = Math.cos(rot);
  s = Math.sin(rot);
  const seated = poly.map((p) => {
    const x = p.x - v.x;
    const y = p.y - v.y;
    return { x: c * x - s * y, y: s * x + c * y };
  });
  const iou = rasterIou(seated, sectorPoly(PUZZLE.patternR));
  const qx = mesh.position.x - v.x;
  const qy = mesh.position.y - v.y;
  const to = new THREE.Vector3(c * qx - s * qy, s * qx + c * qy, 0);
  const q = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 0, 1), rot)
    .multiply(mesh.quaternion);
  return { to, q, seated, iou };
}

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

function missingQuarterProfile(r: number, segs = 32): Poly2[] {
  const pts: Poly2[] = [{ x: 0, y: 0 }];
  for (let i = 0; i <= segs; i++) {
    const a = Math.PI / 2 + (i / segs) * Math.PI * 1.5;
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return pts;
}

function makePatternMesh(
  face: THREE.MeshLambertMaterial,
  edge: THREE.MeshLambertMaterial,
): THREE.Mesh {
  const depth = woodSize().depth;
  const geom =
    createChamferedSolid(
      missingQuarterProfile(PUZZLE.patternR),
      depth,
      bevelInset(depth),
    ) ?? new THREE.BoxGeometry(1, 1, depth);
  const mesh = new THREE.Mesh(geom, [face, edge]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.z = 0;
  return mesh;
}

function makeTrayMesh(
  face: THREE.MeshLambertMaterial,
  edge: THREE.MeshLambertMaterial,
): THREE.Mesh {
  const depth = woodSize().depth;
  const trayD = depth * PUZZLE.trayDepthK;
  const geom =
    createWoodSolid(
      circleProfileAt(0, 0, PUZZLE.patternR * PUZZLE.trayScale, 36),
      trayD,
      bevelInset(trayD),
    ) ?? new THREE.CylinderGeometry(PUZZLE.patternR, PUZZLE.patternR, trayD, 36);
  if (geom instanceof THREE.CylinderGeometry) geom.rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh(geom, [face, edge]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.z = -depth * 0.5 - trayD * 0.5;
  return mesh;
}

function starRank(iou: number, cuts: number): number {
  let n = 1;
  if (iou >= 0.28) n = 2;
  if (iou >= 0.48) n = 3;
  if (cuts > PUZZLE.cleanCuts) n = Math.max(1, n - 1);
  if (cuts > PUZZLE.maxCuts) n = 1;
  return n;
}

export function createCutPuzzle(opts: {
  scene: THREE.Scene;
  uiRoot: HTMLElement | null;
  physics: SlashPhysics;
  spawnBoard: () => void;
  clearBoard: () => void;
  beginEnter: () => void;
  haltFly: () => void;
  faceMat: THREE.MeshLambertMaterial;
  edgeMat: THREE.MeshLambertMaterial;
}): CutPuzzle {
  const trayFace = opts.faceMat.clone();
  trayFace.color.multiplyScalar(0.62);
  const trayEdge = opts.edgeMat.clone();
  trayEdge.color.multiplyScalar(0.7);
  const pattern = makePatternMesh(opts.faceMat, opts.edgeMat);
  const tray = makeTrayMesh(trayFace, trayEdge);
  const board = new THREE.Group();
  board.add(tray);
  board.add(pattern);
  opts.scene.add(board);
  board.position.set(0, 0, 0);
  board.scale.set(1, 1, 1);

  const hit = document.createElement('button');
  hit.type = 'button';
  hit.className = 'puzzle-thumb-hit';
  hit.setAttribute('aria-label', 'install');
  hit.tabIndex = -1;

  const starsEl = document.createElement('div');
  starsEl.className = 'puzzle-stars';
  starsEl.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) {
    const d = document.createElement('span');
    d.className = 'puzzle-star';
    starsEl.appendChild(d);
  }

  const stepsEl = document.createElement('div');
  stepsEl.className = 'puzzle-steps';
  stepsEl.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < PUZZLE.maxCuts; i++) {
    const d = document.createElement('span');
    d.className = 'puzzle-step';
    stepsEl.appendChild(d);
  }

  if (opts.uiRoot) {
    opts.uiRoot.appendChild(hit);
    opts.uiRoot.appendChild(stepsEl);
    opts.uiRoot.appendChild(starsEl);
  }

  const setSteps = (used: number) => {
    stepsEl.dataset.used = String(Math.max(0, Math.min(PUZZLE.maxCuts, used)));
  };
  setSteps(0);

  let phase: PuzzlePhase = 'show';
  let t = 0;
  let cuts = 0;
  let stars = 0;
  let lastKeep: THREE.Mesh | null = null;
  let lastDrop: THREE.Mesh | null = null;
  let install: {
    mesh: THREE.Mesh;
    from: THREE.Vector3;
    to: THREE.Vector3;
    fromQ: THREE.Quaternion;
    toQ: THREE.Quaternion;
    u: number;
  } | null = null;

  const setThumbHit = (on: boolean) => {
    hit.classList.toggle('is-on', on);
  };

  const placePattern = (thumb: boolean) => {
    if (thumb) {
      board.position.set(PUZZLE.thumbX, PUZZLE.thumbY, 0);
      board.scale.setScalar(PUZZLE.thumbScale);
    } else {
      board.position.set(0, 0, 0);
      board.scale.set(1, 1, 1);
    }
  };

  const beginCut = () => {
    phase = 'cut';
    t = 0;
    cuts = 0;
    lastKeep = null;
    lastDrop = null;
    setSteps(0);
    placePattern(true);
    setThumbHit(false);
    opts.spawnBoard();
    opts.beginEnter();
  };

  const beginInstall = () => {
    if (phase !== 'cut') return;
    const drop = lastDrop;
    const keep = lastKeep;
    const candidates = [drop, keep].filter(
      (m): m is THREE.Mesh => !!m && !!m.parent,
    );
    if (candidates.length === 0 || cuts < 1) return;
    let mesh = candidates[0];
    let scored = seatAsQuarter(mesh);
    for (let i = 1; i < candidates.length; i++) {
      const s = seatAsQuarter(candidates[i]);
      if (s.iou > scored.iou) {
        mesh = candidates[i];
        scored = s;
      }
    }
    phase = 'install';
    t = 0;
    setThumbHit(false);
    placePattern(false);
    opts.haltFly();
    for (const m of candidates) {
      opts.physics.removeMesh(m);
      if (m !== mesh) m.visible = false;
    }
    stars = starRank(scored.iou, cuts);
    install = {
      mesh,
      from: mesh.position.clone(),
      to: scored.to,
      fromQ: mesh.quaternion.clone(),
      toQ: scored.q,
      u: 0,
    };
  };

  hit.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (phase === 'cut' && cuts >= 1) beginInstall();
  });

  return {
    phase: () => phase,
    canCut: () => phase === 'cut',
    cuts: () => cuts,
    onCut: (keep, drop) => {
      if (phase !== 'cut') return 'ok';
      lastKeep = keep;
      lastDrop = drop;
      cuts += 1;
      setSteps(cuts);
      setThumbHit(cuts >= 1);
      if (cuts >= PUZZLE.maxCuts) return 'submit';
      return 'ok';
    },
    requestInstall: () => beginInstall(),
    step: (dt) => {
      t += dt;
      if (phase === 'show') {
        placePattern(false);
        if (t >= PUZZLE.showDur) beginCut();
        return;
      }
      if (phase === 'install' && install) {
        install.u = Math.min(1, install.u + dt / PUZZLE.installDur);
        const u = 1 - (1 - install.u) ** 2;
        install.mesh.position.lerpVectors(install.from, install.to, u);
        install.mesh.quaternion.slerpQuaternions(install.fromQ, install.toQ, u);
        if (install.u >= 1) {
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
          install = null;
          t = 0;
          opts.clearBoard();
          setSteps(0);
          phase = 'show';
          placePattern(false);
        }
      }
    },
    dispose: () => {
      hit.remove();
      stepsEl.remove();
      starsEl.remove();
      opts.scene.remove(board);
      pattern.geometry.dispose();
      tray.geometry.dispose();
      trayFace.dispose();
      trayEdge.dispose();
    },
  };
}
