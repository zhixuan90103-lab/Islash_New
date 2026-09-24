import * as THREE from 'three';
import { NOTEBOOK, PAPER, PUZZLE, puzzleCutX, TRAIL, VIEW } from './design';
import { type Poly2 } from './woodProfile';
import { createChamferedSolid } from './woodChamfer';
import {
  TURTLE,
  localIsDark,
  turtleEyeCenter,
  turtleHeadPoly,
  turtleParts,
  turtleShadeCaps,
  paperFaceTexture,
  type TurtlePart,
} from './turtleLevel';
import { BUTTERFLY, butterflyBody, butterflyEyes, butterflyParts, type ButterflyPart } from './butterflyLevel';
import type { SlashPhysics } from './slashPhysics';

export type PuzzlePhase = 'show' | 'pan' | 'cut' | 'carry' | 'place' | 'inspect' | 'score';

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
  attachSheet: (mesh: THREE.Mesh) => void;
  /** 裁切圆纸的缩放，和笔记本上的阴影一样大。 */
  sheetScale: () => number;
  rememberCut: (parent: THREE.Mesh, a: THREE.Mesh, b: THREE.Mesh) => void;
  step: (dt: number) => void;
  dispose: () => void;
  /** 按当前摆放计分并弹出星。怎么算拼完还没定，画面上先不接按钮。 */
  scorePlacement: () => void;
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

/** 多边形面积中心。顶点平均会偏到采样更密的那一侧。 */
function areaCentroid(poly: Poly2[]): Poly2 {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const cross = poly[j].x * poly[i].y - poly[i].x * poly[j].y;
    a += cross;
    cx += (poly[j].x + poly[i].x) * cross;
    cy += (poly[j].y + poly[i].y) * cross;
  }
  if (Math.abs(a) < 1e-8) return polyCentroid(poly);
  return { x: cx / (3 * a), y: cy / (3 * a) };
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
  mesh.renderOrder = 2;
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

function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
  const radius = Math.min(r, w * 0.5, h * 0.5);
  const x = -w / 2;
  const y = -h / 2;
  const shape = new THREE.Shape();
  shape.moveTo(x + radius, y);
  shape.lineTo(x + w - radius, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + radius);
  shape.lineTo(x + w, y + h - radius);
  shape.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  shape.lineTo(x + radius, y + h);
  shape.quadraticCurveTo(x, y + h, x, y + h - radius);
  shape.lineTo(x, y + radius);
  shape.quadraticCurveTo(x, y, x + radius, y);
  return shape;
}

/** 正面在本地 z=0，厚度往 -Z。组 0 是正面，组 1 是侧面。 */
function slabGeometry(w: number, h: number, r: number, depth: number): THREE.ExtrudeGeometry {
  const bevel = 0.016;
  const geom = new THREE.ExtrudeGeometry(roundedRectShape(w, h, r), {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 10,
  });
  geom.translate(0, 0, -(depth + bevel));
  return geom;
}

export function createCutPuzzle(opts: {
  scene: THREE.Scene;
  uiRoot: HTMLElement | null;
  physics: SlashPhysics;
  spawnBoard: () => void;
  clearBoard: () => void;
  haltFly: () => void;
  camera: THREE.Camera;
  setLook: (x: number, z?: number) => void;
  setGrid?: (light: number, dark: number) => void;
  mountPiece: (mesh: THREE.Mesh) => void;
  unmountPiece: (mesh: THREE.Mesh) => void;
  faceMat: THREE.MeshLambertMaterial;
  edgeMat: THREE.MeshLambertMaterial;
}): CutPuzzle {
  const shadowFace = new THREE.MeshLambertMaterial({ color: TURTLE.shadow });
  const shadowEdge = new THREE.MeshLambertMaterial({ color: 0xaeb6b0 });
  const butterflyShadow = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  });
  const paperShade = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
  });
  const headFace = new THREE.MeshLambertMaterial({ color: 0xffffff, map: paperFaceTexture(TURTLE.light) });
  const headEdge = new THREE.MeshLambertMaterial({ color: 0xffffff, map: paperFaceTexture(0xb5d090) });
  const paintPaper = (mat: THREE.Material, hex: number) => {
    const textured = mat as THREE.MeshBasicMaterial;
    textured.map?.dispose();
    textured.map = paperFaceTexture(hex);
    textured.color.set(0xffffff);
    textured.needsUpdate = true;
  };
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, map: paperFaceTexture(TURTLE.eye) });
  const butterflyEyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, map: paperFaceTexture(0xc7c77f) });
  const butterflyEyeShadowMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });
  const turtleHeadRimMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: paperFaceTexture(0x5f7828),
    depthWrite: false,
  });
  const pieceShadowMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: PAPER.shadowOpacity,
    depthWrite: false,
  });
  const turtleOuterDropMat = new THREE.MeshBasicMaterial({
    color: 0x4d6224,
    transparent: true,
    opacity: PAPER.shadowOpacity,
    depthWrite: false,
  });
  const butterflyOuterDropMat = new THREE.MeshBasicMaterial({
    color: 0x8f5c70,
    transparent: true,
    opacity: PAPER.shadowOpacity,
    depthWrite: false,
  });
  let level: 'turtle' | 'butterfly' = 'butterfly';
  const shade = {
    butterfly: { color: '#c98496', x: 0.1, y: 0, size: 1, angle: 5, opacity: 0.95 },
    turtle: { color: '#5f7828', x: 0, y: 0, size: 1, angle: 15, opacity: 1 },
  };
  let syncShadePanel = () => {};
  let turtleOverall = 0.9;
  let turtleAngle = 15;
  let turtleFit = { fit: 1, cx: 0, cy: 0 };
  const turtleTune = {
    shell: { x: 0.3, y: 0, size: 1 },
    legL: { x: 0.49, y: 0, size: 1 },
    legR: { x: 0.11, y: 0, size: 1 },
    head: { x: 0.2, y: 0, size: 0.7 },
    eye: { x: 0.3, y: 0.16, size: 1 },
  };
  type TurtleTuneId = keyof typeof turtleTune;
  const shadowLayer = {
    outer: { x: 0, y: 0, size: 1, opacity: 1 },
  };
  const headRimTune = { x: 0.15, y: -0.15, size: 1.45 };
  const innerTune = {
    shell: { x: 0, y: 0, size: 1, opacity: 0.3 },
    legL: { x: -0.13, y: -0.1, size: 0.9, opacity: 0.3 },
    legR: { x: 0.13, y: -0.1, size: 0.9, opacity: 0.3 },
  };
  const applyTurtleTune = () => {
    shade.turtle.opacity = shadowLayer.outer.opacity;
    shadePivot.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      if (obj.userData.headRim) {
        obj.position.set(headRimTune.x, headRimTune.y, -0.012);
        obj.scale.setScalar(headRimTune.size);
        return;
      }
      const id = obj.userData.turtleId as TurtleTuneId | undefined;
      const home = obj.userData.turtleHome as { x: number; y: number; z: number } | undefined;
      if (!id || !home) return;
      const tune = turtleTune[id];
      const layer = obj.userData.turtleLayer as 'outer' | 'inner' | undefined;
      const extra = layer === 'outer'
        ? shadowLayer.outer
        : layer === 'inner' && id in innerTune
          ? innerTune[id as keyof typeof innerTune]
          : { x: 0, y: 0, size: 1 };
      obj.position.set(home.x + tune.x + extra.x, home.y + tune.y + extra.y, home.z);
      obj.scale.setScalar(tune.size * extra.size);
      if (layer === 'inner' && id in innerTune) {
        const mat = obj.material;
        const mats = Array.isArray(mat) ? mat : [mat];
        for (const item of mats) {
          if (!('opacity' in item)) continue;
          item.opacity = innerTune[id as keyof typeof innerTune].opacity;
          item.transparent = item.opacity < 1;
        }
      }
    });
    placeOuterDrops();
  };
  const placeOuterDrops = () => {
    const groupScale = PATTERN_FIT * (shade[level].size || 1);
    shadePivot.traverse((obj) => {
      if (!obj.userData.outerDrop) return;
      const parentScale = obj.parent instanceof THREE.Object3D ? obj.parent.scale.x || 1 : 1;
      const worldScale = groupScale * parentScale;
      obj.position.set(
        (PAPER.shadowX * 0.4) / worldScale,
        (PAPER.shadowY * 0.4) / worldScale,
        0.002,
      );
    });
  };
  const anchorTurtle = (
    mesh: THREE.Mesh,
    id: TurtleTuneId,
    ox: number,
    oy: number,
    z: number,
    layer?: 'outer' | 'inner',
  ) => {
    mesh.geometry.translate(-ox, -oy, 0);
    const profile = mesh.userData.profile as Poly2[] | undefined;
    if (profile) {
      mesh.userData.profile = profile.map((p) => ({ x: p.x - ox, y: p.y - oy }));
    }
    mesh.userData.turtleId = id;
    mesh.userData.turtleLayer = layer;
    mesh.userData.turtleHome = { x: ox, y: oy, z };
    mesh.position.set(ox, oy, z);
  };
  const applyShade = () => {
    const s = shade[level];
    const hex = Number.parseInt(s.color.slice(1), 16);
    const mats = level === 'butterfly' ? [butterflyShadow] : [shadowFace, shadowEdge];
    for (const mat of mats) {
      paintPaper(mat, hex);
      mat.opacity = s.opacity;
      mat.transparent = s.opacity < 1;
      mat.depthWrite = s.opacity >= 1;
    }
    paperShade.opacity = 0.3;
    paperShade.transparent = paperShade.opacity < 1;
    placeOuterDrops();
    shadePivot.position.set(s.x, s.y, 0);
    shadePivot.rotation.z = (s.angle * Math.PI) / 180;
    shadePivot.scale.setScalar(s.size);
    syncShadePanel();
  };
  let parts: Array<TurtlePart | ButterflyPart> = [];
  const slots = new Map<string, THREE.Mesh>();
  const extras: THREE.Mesh[] = [];
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: PAPER.shadowOpacity,
    depthWrite: false,
    toneMapped: false,
  });
  const pageW = TURTLE.r * 2 + 0.22;
  const pageH = pageW * 1.54;
  const look = {
    spine: 0.2,
    rim: 0.09,
    coverDepth: 0.11,
    pageDepth: 0.07,
    cover: '#db96a8',
    page: '#fef2df',
  };
  let syncBookColors = () => {};
  const coverW = () => pageW + look.spine + look.rim;
  const coverH = () => pageH + look.rim * 2;
  const coverFace = new THREE.MeshBasicMaterial({ color: 0xdb96a8 });
  const coverEdge = new THREE.MeshBasicMaterial({ color: 0xd590a2 });
  const pageFace = new THREE.MeshBasicMaterial({ color: 0xfef2df });
  const pageEdge = new THREE.MeshBasicMaterial({ color: 0xf6ead7 });
  const ringFace = new THREE.MeshLambertMaterial({ color: 0xf4f7fb });
  const coverFront = 0.02;
  const tint = (hex: string, amt: number) => {
    const n = Number.parseInt(hex.slice(1), 16);
    const ch = (shift: number) => Math.max(0, ((n >> shift) & 255) - amt);
    return (ch(16) << 16) | (ch(8) << 8) | ch(0);
  };
  const page = new THREE.Mesh(slabGeometry(pageW, pageH, 0.06, look.pageDepth), [pageFace, pageEdge]);
  page.position.z = coverFront + look.pageDepth;
  const cover = new THREE.Mesh(
    slabGeometry(coverW(), coverH(), 0.09, look.coverDepth),
    [coverFace, coverEdge],
  );
  cover.position.set(-(look.spine - look.rim) * 0.5, 0, coverFront);
  const shadow = new THREE.Mesh(
    new THREE.ShapeGeometry(roundedRectShape(coverW(), coverH(), 0.09)),
    shadowMat,
  );
  shadow.position.set(cover.position.x + PAPER.shadowX, PAPER.shadowY, coverFront - 0.01);
  shadow.renderOrder = 0;
  const ringGeom = new THREE.CylinderGeometry(0.042, 0.042, 0.025, 18);
  ringGeom.rotateX(Math.PI / 2);
  const holeGeom = new THREE.CylinderGeometry(0.018, 0.018, 0.028, 14);
  holeGeom.rotateX(Math.PI / 2);
  const rings: THREE.Mesh[] = [];
  const ringX = () => -pageW / 2 - look.spine * 0.5;
  for (let i = 0; i < 7; i++) {
    const y = -pageH * 0.38 + (pageH * 0.76 * i) / 6;
    const ring = new THREE.Mesh(ringGeom, ringFace);
    ring.position.set(ringX(), y, cover.position.z + 0.012);
    const hole = new THREE.Mesh(holeGeom, coverFace);
    hole.position.set(ringX(), y, cover.position.z + 0.016);
    rings.push(ring, hole);
  }
  const board = new THREE.Group();
  const notebookFrame = new THREE.Group();
  notebookFrame.add(shadow);
  notebookFrame.add(cover);
  notebookFrame.add(page);
  for (const ring of rings) notebookFrame.add(ring);
  board.add(notebookFrame);
  const PATTERN_FIT = 0.8;
  const pattern = new THREE.Group();
  pattern.scale.setScalar(PATTERN_FIT);
  pattern.position.z = page.position.z + 0.012;
  const shadePivot = new THREE.Group();
  pattern.add(shadePivot);
  board.add(pattern);
  const placeNotebook = () => {
    board.position.set(NOTEBOOK.x, NOTEBOOK.y, 0);
    board.rotation.z = (NOTEBOOK.angle * Math.PI) / 180;
    notebookFrame.scale.setScalar(NOTEBOOK.scale);
  };
  placeNotebook();
  opts.scene.add(board);

  const dropMesh = (mesh: THREE.Mesh) => {
    shadePivot.remove(mesh);
    mesh.geometry.dispose();
    if (mesh.userData.ownMat) {
      const mat = mesh.material;
      for (const item of Array.isArray(mat) ? mat : [mat]) item.dispose();
    }
  };

  const mountLevel = () => {
    for (const mesh of slots.values()) dropMesh(mesh);
    slots.clear();
    for (const mesh of extras) dropMesh(mesh);
    extras.length = 0;
    pattern.scale.setScalar(PATTERN_FIT);
    pattern.rotation.z = 0;
    if (level === 'turtle') {
      look.cover = '#93af48';
      look.page = '#fff9e4';
      opts.setGrid?.(0xf2c8cb, 0xe7bdc0);
    } else {
      look.cover = '#db96a8';
      look.page = '#fef2df';
      opts.setGrid?.(0xafc4d9, 0xabc0d5);
    }
    coverFace.color.set(look.cover);
    coverEdge.color.set(tint(look.cover, 8));
    pageFace.color.set(look.page);
    pageEdge.color.set(tint(look.page, 8));
    syncBookColors();
    pattern.position.x = 0;
    pattern.position.z = page.position.z + 0.012;
    parts = level === 'turtle' ? turtleParts() : butterflyParts();
    for (const part of parts) {
      const mesh = makePartMesh(
        part.poly,
        level === 'butterfly' ? butterflyShadow : shadowFace,
        level === 'butterfly' ? butterflyShadow : shadowEdge,
      );
      mesh.name = part.id;
      slots.set(part.id, mesh);
      shadePivot.add(mesh);
      if (level === 'turtle' && (part.id === 'shell' || part.id === 'legL' || part.id === 'legR')) {
        const origin = part.id === 'legL' ? { x: TURTLE.r, y: 0 }
          : part.id === 'legR' ? { x: -TURTLE.r, y: 0 }
          : { x: 0, y: 0 };
        anchorTurtle(mesh, part.id, origin.x, origin.y, 0, 'outer');
        const drop = new THREE.Mesh(mesh.geometry, turtleOuterDropMat);
        drop.userData.outerDrop = true;
        drop.renderOrder = 1;
        mesh.add(drop);
      }
      if (level === 'butterfly' && (part.id === 'wingL' || part.id === 'wingR')) {
        const drop = new THREE.Mesh(mesh.geometry, butterflyOuterDropMat);
        drop.userData.outerDrop = true;
        drop.renderOrder = 1;
        mesh.add(drop);
      }
    }
    if (level === 'turtle') {
      const caps = turtleShadeCaps();
      const capIds: TurtleTuneId[] = ['shell', 'legL', 'legR'];
      caps.forEach((poly, index) => {
        const capMat = paperShade.clone();
        const cap = makePartMesh(poly, capMat, capMat);
        cap.userData.ownMat = true;
        const id = capIds[index];
        const origin = id === 'legL' ? { x: TURTLE.r, y: 0 }
          : id === 'legR' ? { x: -TURTLE.r, y: 0 }
          : { x: 0, y: 0 };
        anchorTurtle(cap, id, origin.x, origin.y, PAPER.depth + 0.01, 'inner');
        cap.renderOrder = 3;
        extras.push(cap);
        shadePivot.add(cap);
      });
      const head = makePartMesh(turtleHeadPoly(), headFace, headEdge);
      anchorTurtle(head, 'head', TURTLE.r * 2, 0, PAPER.depth + 0.03);
      const headRim = new THREE.Mesh(head.geometry, turtleHeadRimMat);
      headRim.userData.headRim = true;
      headRim.scale.setScalar(headRimTune.size);
      headRim.position.set(headRimTune.x, headRimTune.y, -0.012);
      headRim.renderOrder = 4;
      head.add(headRim);
      const headDrop = new THREE.Mesh(head.geometry, pieceShadowMat);
      headDrop.userData.outerDrop = true;
      headDrop.renderOrder = 1;
      head.add(headDrop);
      head.renderOrder = 5;
      extras.push(head);
      shadePivot.add(head);
      const eyeAt = turtleEyeCenter();
      const eye = new THREE.Mesh(new THREE.CircleGeometry(TURTLE.r * 0.07, 16), eyeMat);
      eye.userData.turtleId = 'eye';
      eye.userData.turtleHome = { x: eyeAt.x, y: eyeAt.y, z: PAPER.depth + 0.05 };
      eye.position.set(eyeAt.x, eyeAt.y, PAPER.depth + 0.05);
      const eyeDrop = new THREE.Mesh(eye.geometry, pieceShadowMat);
      eyeDrop.userData.outerDrop = true;
      eyeDrop.renderOrder = 1;
      eye.add(eyeDrop);
      eye.renderOrder = 5;
      extras.push(eye);
      shadePivot.add(eye);
    } else {
      for (const poly of butterflyBody()) {
        const half = makePartMesh(poly, paperShade, paperShade);
        half.position.z = PAPER.depth + 0.01;
        half.renderOrder = 3;
        extras.push(half);
        shadePivot.add(half);
      }
      for (const at of butterflyEyes()) {
        const halo = new THREE.Mesh(
          new THREE.CircleGeometry(BUTTERFLY.r * 0.055 * 1.8, 16),
          butterflyShadow,
        );
        halo.position.set(at.x, at.y, PAPER.depth + 0.02);
        halo.renderOrder = 4;
        extras.push(halo);
        shadePivot.add(halo);
        const eyeR = BUTTERFLY.r * 0.055;
        const eyeShadow = new THREE.Mesh(new THREE.CircleGeometry(eyeR, 16), butterflyEyeShadowMat);
        eyeShadow.position.set(at.x + 0.006, at.y - 0.007, PAPER.depth + 0.025);
        eyeShadow.renderOrder = 5;
        extras.push(eyeShadow);
        shadePivot.add(eyeShadow);
        const eye = new THREE.Mesh(new THREE.CircleGeometry(eyeR, 16), butterflyEyeMat);
        eye.position.set(at.x, at.y, PAPER.depth + 0.03);
        eye.renderOrder = 6;
        extras.push(eye);
        shadePivot.add(eye);
      }
    }
    if (level === 'turtle') {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const add = (x: number, y: number) => {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      };
      for (const poly of turtleShadeCaps()) {
        for (const p of poly) add(p.x, p.y);
      }
      for (const p of turtleHeadPoly()) add(p.x, p.y);
      const eyeAt = turtleEyeCenter();
      const eyeR = TURTLE.r * 0.07;
      add(eyeAt.x - eyeR, eyeAt.y - eyeR);
      add(eyeAt.x + eyeR, eyeAt.y + eyeR);
      const pageW = TURTLE.r * 2 + 0.22;
      const pageH = pageW * 1.54;
      const localW = pageW * NOTEBOOK.scale / PATTERN_FIT;
      const localH = pageH * NOTEBOOK.scale / PATTERN_FIT;
      const fit = Math.min(1, (localW * 0.86) / (maxX - minX), (localH * 0.86) / (maxY - minY));
      turtleFit = { fit, cx: (minX + maxX) * 0.5, cy: (minY + maxY) * 0.5 };
      shade.turtle.size = fit * turtleOverall;
      shade.turtle.x = -turtleFit.cx * shade.turtle.size;
      shade.turtle.y = -turtleFit.cy * shade.turtle.size;
    }
    applyShade();
    applyTurtleTune();
  };
  mountLevel();
  board.scale.set(1, 1, 1);
  board.visible = true;

  const hit = document.createElement('button');
  hit.type = 'button';
  hit.className = 'puzzle-submit-hit';
  hit.textContent = '装上';
  hit.setAttribute('aria-label', '装上');
  hit.tabIndex = -1;

  const iconAttrs = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const undoIcon =
    `<svg ${iconAttrs}><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>`;
  const hintIcon =
    `<svg ${iconAttrs}><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>`;
  const gearIcon =
    `<svg ${iconAttrs}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`;

  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.className = 'puzzle-tool is-left';
  undoBtn.innerHTML = undoIcon;
  undoBtn.setAttribute('aria-label', '撤销');

  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'puzzle-preview';
  previewBtn.setAttribute('aria-label', '回到预览');
  previewBtn.innerHTML = `<svg ${iconAttrs}><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>`;
  const hintBtn = document.createElement('button');
  hintBtn.type = 'button';
  hintBtn.className = 'puzzle-tool is-right';
  hintBtn.innerHTML = hintIcon;
  hintBtn.setAttribute('aria-label', '提示');

  const hintMat = new THREE.LineDashedMaterial({
    color: 0xffffff,
    dashSize: 0.07,
    gapSize: 0.05,
    toneMapped: false,
  });
  const hintLine = new THREE.LineSegments(new THREE.BufferGeometry(), hintMat);
  hintLine.visible = false;
  hintLine.renderOrder = 4;

  const starsEl = document.createElement('div');
  starsEl.className = 'puzzle-stars';
  starsEl.setAttribute('aria-hidden', 'true');
  const starSvg =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>';
  for (let i = 0; i < 3; i++) {
    const d = document.createElement('span');
    d.className = 'puzzle-star';
    d.innerHTML = `<span class="puzzle-star-base">${starSvg}</span><span class="puzzle-star-gain">${starSvg}</span>`;
    starsEl.appendChild(d);
  }

  const stepsEl = document.createElement('div');
  stepsEl.className = 'puzzle-moves';
  const stepsLabel = document.createElement('div');
  stepsLabel.className = 'puzzle-moves-label';
  stepsLabel.textContent = 'Moves';
  const stepsCount = document.createElement('div');
  stepsCount.className = 'puzzle-moves-count';
  stepsEl.append(stepsLabel, stepsCount);
  const goalEl = document.createElement('div');
  goalEl.className = 'puzzle-goal is-away';
  goalEl.textContent = '在规定步数内裁剪出蝴蝶翅膀';

  const applyLook = () => {
    cover.geometry.dispose();
    page.geometry.dispose();
    shadow.geometry.dispose();
    cover.geometry = slabGeometry(coverW(), coverH(), 0.09, look.coverDepth);
    page.geometry = slabGeometry(pageW, pageH, 0.06, look.pageDepth);
    shadow.geometry = new THREE.ShapeGeometry(roundedRectShape(coverW(), coverH(), 0.09));
    page.position.z = coverFront + look.pageDepth;
    cover.position.set(-(look.spine - look.rim) * 0.5, 0, coverFront);
    shadow.position.set(cover.position.x + PAPER.shadowX, PAPER.shadowY, coverFront - 0.01);
    pattern.position.z = page.position.z + 0.012;
    coverFace.color.set(look.cover);
    coverEdge.color.set(tint(look.cover, 8));
    pageFace.color.set(look.page);
    pageEdge.color.set(tint(look.page, 8));
    for (let i = 0; i < rings.length; i += 2) {
      const y = rings[i].position.y;
      rings[i].position.set(ringX(), y, cover.position.z + 0.012);
      rings[i + 1].position.set(ringX(), y, cover.position.z + 0.016);
    }
    placeNotebook();
  };

  let tuneEl: HTMLDivElement | null = null;
  const resultEl = document.createElement('div');
  const replayBtn = document.createElement('button');
  const nextBtn = document.createElement('button');
  if (opts.uiRoot) {
    opts.uiRoot.appendChild(stepsEl);
    opts.uiRoot.appendChild(goalEl);
    opts.uiRoot.appendChild(hit);
    opts.uiRoot.appendChild(undoBtn);
    opts.uiRoot.appendChild(hintBtn);
    opts.uiRoot.appendChild(previewBtn);
    resultEl.className = 'puzzle-result';
    resultEl.className = 'puzzle-result';
    const resultCard = document.createElement('div');
    resultCard.className = 'puzzle-result-card';
    const resultActions = document.createElement('div');
    resultActions.className = 'puzzle-result-actions';
    replayBtn.type = 'button';
    replayBtn.className = 'puzzle-result-btn';
    replayBtn.setAttribute('aria-label', '重玩');
    replayBtn.innerHTML = `<svg ${iconAttrs}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg><span>重玩</span>`;
    nextBtn.type = 'button';
    nextBtn.className = 'puzzle-result-btn';
    nextBtn.setAttribute('aria-label', '下一关');
    nextBtn.innerHTML = `<svg ${iconAttrs}><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg><span>下一关</span>`;
    resultActions.append(replayBtn, nextBtn);
    resultCard.append(starsEl, resultActions);
    resultEl.append(resultCard);
    opts.uiRoot.appendChild(resultEl);
    tuneEl = document.createElement('div');
    tuneEl.className = 'puzzle-settings';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'puzzle-settings-btn';
    toggle.setAttribute('aria-label', '设置');
    toggle.innerHTML = gearIcon;
    const panel = document.createElement('div');
    panel.className = 'puzzle-settings-panel';
    panel.hidden = true;
    toggle.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      panel.hidden = !panel.hidden;
    });
    const addRange = (
      label: string,
      read: () => number,
      write: (n: number) => void,
      min: number,
      max: number,
      step = 0.005,
      live = true,
    ) => {
      const row = document.createElement('label');
      const name = document.createElement('span');
      name.textContent = label;
      const value = document.createElement('span');
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(read());
      value.textContent = read().toFixed(2);
      input.addEventListener('input', () => {
        write(Number(input.value));
        value.textContent = read().toFixed(2);
        if (live) applyLook();
      });
      row.append(name, input, value);
      panel.append(row);
    };
    const colorInputs: Partial<Record<'cover' | 'page', HTMLInputElement>> = {};
    const addColor = (label: string, key: 'cover' | 'page') => {
      const row = document.createElement('label');
      const name = document.createElement('span');
      name.textContent = label;
      const input = document.createElement('input');
      input.type = 'color';
      input.value = look[key];
      colorInputs[key] = input;
      input.addEventListener('input', () => {
        look[key] = input.value;
        applyLook();
      });
      row.append(name, input);
      panel.append(row);
    };
    syncBookColors = () => {
      if (colorInputs.cover) colorInputs.cover.value = look.cover;
      if (colorInputs.page) colorInputs.page.value = look.page;
    };
    addRange('外皮边', () => look.rim, (n) => { look.rim = n; }, 0.02, 0.22);
    addRange('线圈边', () => look.spine, (n) => { look.spine = n; }, 0.08, 0.42);
    addRange('外皮厚', () => look.coverDepth, (n) => { look.coverDepth = n; }, 0.04, 0.24);
    addRange('内页厚', () => look.pageDepth, (n) => { look.pageDepth = n; }, 0.03, 0.18);
    addRange('大小', () => NOTEBOOK.scale, (n) => { NOTEBOOK.scale = n; }, 0.5, 1.8);
    addRange('左右', () => NOTEBOOK.x, (n) => { NOTEBOOK.x = n; }, -1.2, 1.2);
    addRange('上下', () => NOTEBOOK.y, (n) => { NOTEBOOK.y = n; }, -1.2, 1.2);
    addRange('角度', () => NOTEBOOK.angle, (n) => { NOTEBOOK.angle = n; }, -180, 180, 1);
    addRange('痕长', () => TRAIL.maxLen, (n) => { TRAIL.maxLen = n; }, 40, 480, 1, false);
    addRange('痕寿命', () => TRAIL.life, (n) => { TRAIL.life = n; }, 0.04, 0.6, 0.01, false);
    addRange('痕间距', () => TRAIL.minDist, (n) => { TRAIL.minDist = n; }, 1, 24, 0.5, false);
    addRange('痕平滑', () => TRAIL.smooth, (n) => { TRAIL.smooth = n; }, 0, 0.12, 0.005, false);
    addRange('痕头宽', () => TRAIL.headW, (n) => { TRAIL.headW = n; }, 1, 24, 0.5, false);
    addRange('痕尾宽', () => TRAIL.tailW, (n) => { TRAIL.tailW = n; }, 0, 16, 0.5, false);
    addRange('痕尖长', () => TRAIL.tipLen, (n) => { TRAIL.tipLen = n; }, 0, 40, 1, false);
    addRange('痕细分', () => TRAIL.subdiv, (n) => { TRAIL.subdiv = n; }, 1, 12, 1, false);
    const turtleTitle = document.createElement('div');
    turtleTitle.textContent = '乌龟零件';
    panel.append(turtleTitle);
    addRange('整体大小', () => turtleOverall, (n) => {
      turtleOverall = n;
      shade.turtle.size = turtleFit.fit * n;
      shade.turtle.x = -turtleFit.cx * shade.turtle.size;
      shade.turtle.y = -turtleFit.cy * shade.turtle.size;
      applyShade();
    }, 0.4, 1.8, 0.01, false);
    addRange('整体角度', () => turtleAngle, (n) => {
      turtleAngle = n;
      shade.turtle.angle = n;
      applyShade();
    }, -180, 180, 1, false);
    addRange('头轮廓左右', () => headRimTune.x, (n) => { headRimTune.x = n; applyTurtleTune(); }, -0.8, 0.8, 0.01, false);
    addRange('头轮廓上下', () => headRimTune.y, (n) => { headRimTune.y = n; applyTurtleTune(); }, -0.8, 0.8, 0.01, false);
    addRange('头轮廓大小', () => headRimTune.size, (n) => { headRimTune.size = n; applyTurtleTune(); }, 1, 2.2, 0.01, false);
    addRange('外影左右', () => shadowLayer.outer.x, (n) => { shadowLayer.outer.x = n; applyTurtleTune(); applyShade(); }, -0.8, 0.8, 0.01, false);
    addRange('外影上下', () => shadowLayer.outer.y, (n) => { shadowLayer.outer.y = n; applyTurtleTune(); applyShade(); }, -0.8, 0.8, 0.01, false);
    addRange('外影大小', () => shadowLayer.outer.size, (n) => { shadowLayer.outer.size = n; applyTurtleTune(); }, 0.4, 2, 0.01, false);
    addRange('外影透明', () => shadowLayer.outer.opacity, (n) => { shadowLayer.outer.opacity = n; applyTurtleTune(); applyShade(); }, 0, 1, 0.01, false);
    for (const [label, id] of [['壳内', 'shell'], ['左腿内', 'legL'], ['右腿内', 'legR']] as const) {
      addRange(`${label}左右`, () => innerTune[id].x, (n) => { innerTune[id].x = n; applyTurtleTune(); }, -0.8, 0.8, 0.01, false);
      addRange(`${label}上下`, () => innerTune[id].y, (n) => { innerTune[id].y = n; applyTurtleTune(); }, -0.8, 0.8, 0.01, false);
      addRange(`${label}大小`, () => innerTune[id].size, (n) => { innerTune[id].size = n; applyTurtleTune(); }, 0.4, 2, 0.01, false);
      addRange(`${label}透明`, () => innerTune[id].opacity, (n) => { innerTune[id].opacity = n; applyTurtleTune(); }, 0, 1, 0.01, false);
    }
    const turtleIds = [
      ['壳', 'shell'],
      ['左腿', 'legL'],
      ['右腿', 'legR'],
      ['头', 'head'],
      ['眼', 'eye'],
    ] as const;
    for (const [label, id] of turtleIds) {
      addRange(`${label}左右`, () => turtleTune[id].x, (n) => { turtleTune[id].x = n; applyTurtleTune(); }, -1.2, 1.2, 0.01, false);
      addRange(`${label}上下`, () => turtleTune[id].y, (n) => { turtleTune[id].y = n; applyTurtleTune(); }, -1.2, 1.2, 0.01, false);
      addRange(`${label}大小`, () => turtleTune[id].size, (n) => { turtleTune[id].size = n; applyTurtleTune(); }, 0.4, 2, 0.01, false);
    }
    addColor('外皮色', 'cover');
    addColor('内页色', 'page');
    const shadeRows: Array<{ pull: () => void }> = [];
    const addShadeRange = (
      label: string,
      key: 'x' | 'y' | 'size' | 'angle' | 'opacity',
      min: number,
      max: number,
      step = 0.01,
    ) => {
      const row = document.createElement('label');
      const name = document.createElement('span');
      name.textContent = label;
      const value = document.createElement('span');
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      const pull = () => {
        const n = shade[level][key];
        input.value = String(n);
        value.textContent = n.toFixed(2);
      };
      pull();
      input.addEventListener('input', () => {
        shade[level][key] = Number(input.value);
        value.textContent = shade[level][key].toFixed(2);
        applyShade();
      });
      row.append(name, input, value);
      panel.append(row);
      shadeRows.push({ pull });
    };
    const shadeColor = document.createElement('label');
    const shadeColorName = document.createElement('span');
    shadeColorName.textContent = '阴影色';
    const shadeColorInput = document.createElement('input');
    shadeColorInput.type = 'color';
    shadeColorInput.value = shade[level].color;
    shadeColorInput.addEventListener('input', () => {
      shade[level].color = shadeColorInput.value;
      applyShade();
    });
    shadeColor.append(shadeColorName, shadeColorInput);
    panel.append(shadeColor);
    addShadeRange('阴影左右', 'x', -0.6, 0.6);
    addShadeRange('阴影上下', 'y', -0.6, 0.6);
    addShadeRange('阴影大小', 'size', 0.4, 1.8);
    addShadeRange('阴影角度', 'angle', -180, 180, 1);
    addShadeRange('透明度', 'opacity', 0, 1);
    syncShadePanel = () => {
      shadeColorInput.value = shade[level].color;
      for (const row of shadeRows) row.pull();
    };
    tuneEl.append(toggle, panel);
    opts.uiRoot.appendChild(tuneEl);
  }

  let phase: PuzzlePhase = 'show';
  let goalLive = false;
  let holdSettings = false;
  let holdPreview = false;
  let goalTimer = 0;
  let lookX = 0;
  let lookZ = VIEW.cameraZ;
  let sheetFit = 1;
  const cutCamZ = () => VIEW.cameraZ * sheetFit;
  let pan: { from: number; to: number; u: number; then: 'cut' | 'place' } | null = null;
  let t = 0;
  let cuts = 0;
  let stepsLeft = 0;
  let hintOn = false;
  type CutSnap = {
    kind: 'cut';
    geometry: THREE.BufferGeometry;
    profile: Poly2[];
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    scale: THREE.Vector3;
    material: THREE.Material | THREE.Material[];
    depth: number;
    role: string | undefined;
    originVolume: number;
    inFrags: boolean;
    children: [THREE.Mesh, THREE.Mesh];
  };
  type PoseSnap = {
    kind: 'pose';
    mesh: THREE.Mesh;
    p: THREE.Vector3;
    q: THREE.Quaternion;
  };
  const history: Array<CutSnap | PoseSnap> = [];
  let stars = 0;
  let buttonLatched = false;
  const frags: THREE.Mesh[] = [];

  const setThumbHit = (on: boolean) => {
    hit.classList.toggle('is-on', on);
  };

  const stepBudget = () =>
    level === 'butterfly' ? PUZZLE.stepsButterfly : PUZZLE.stepsTurtle;

  const paintSteps = () => {
    const started = phase === 'cut' || phase === 'carry' || phase === 'place'
      || phase === 'inspect' || phase === 'score';
    const n = started ? Math.max(0, stepsLeft) : stepBudget();
    stepsCount.textContent = String(n);
    const onCut = phase === 'cut' || (phase === 'pan' && pan?.then === 'cut');
    const showGoal = goalLive && level === 'butterfly' && onCut;
    if (showGoal) goalEl.classList.remove('is-away', 'is-fade');
    else if (!onCut || !goalEl.classList.contains('is-fade')) {
      goalEl.classList.add('is-away');
      goalEl.classList.remove('is-fade');
    }
    const hudIn = onCut && !showGoal;
    stepsEl.classList.toggle('is-away', !hudIn);
    tuneEl?.classList.toggle('is-away', !hudIn && !holdSettings);
  };
  const dismissGoal = () => {
    if (!goalLive) return;
    goalLive = false;
    goalEl.classList.add('is-fade');
    goalEl.classList.remove('is-away');
    paintSteps();
  };
  paintSteps();

  const toolsLive = () => phase === 'cut' || phase === 'place';

  const paintTools = () => {
    const cutting = phase === 'cut';
    const placing = phase === 'place';
    undoBtn.classList.toggle('is-on', cutting || placing);
    undoBtn.classList.toggle('is-ready', (cutting || placing) && history.length > 0);
    hintBtn.classList.toggle('is-on', cutting);
    hintBtn.classList.toggle('is-ready', cutting && hintOn);
    hintLine.visible = cutting && hintOn && !buttonLatched;
  };

  const rebuildHint = () => {
    const r = TURTLE.r;
    const z = PAPER.depth * 1.6;
    const pts =
      level === 'butterfly'
        ? [new THREE.Vector3(0, -r, z), new THREE.Vector3(0, r, z)]
        : [
            new THREE.Vector3(-r, 0, z),
            new THREE.Vector3(r, 0, z),
            new THREE.Vector3(0, -r, z),
            new THREE.Vector3(0, 0, z),
          ];
    hintLine.geometry.dispose();
    hintLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    hintLine.computeLineDistances();
  };
  rebuildHint();

  const clearHistory = () => {
    for (const op of history) {
      if (op.kind === 'cut') op.geometry.dispose();
    }
    history.length = 0;
  };

  const showNotebook = () => {
    board.visible = true;
    board.scale.set(1, 1, 1);
    placeNotebook();
  };

  const resetPieces = () => {
    frags.length = 0;
    buttonLatched = false;
  };

  const beginCut = () => {
    phase = 'cut';
    t = 0;
    cuts = 0;
    stepsLeft = stepBudget();
    hintOn = level === 'butterfly';
    hit.textContent = '装上';
    clearHistory();
    resetPieces();
    for (const mesh of slots.values()) mesh.visible = true;
    showNotebook();
    paintSteps();
    paintTools();
    setThumbHit(false);
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
    paintTools();
  };

  const forget = (mesh: THREE.Mesh) => {
    const i = frags.indexOf(mesh);
    if (i >= 0) frags.splice(i, 1);
  };

  const beginInstall = () => {
    if (phase !== 'cut' || !buttonLatched) return;
    phase = 'carry';
    t = 0;
    hintOn = false;
    setThumbHit(false);
    paintSteps();
    paintTools();
    opts.haltFly();
    const lift = page.position.z + 0.055;
    for (const mesh of frags) {
      opts.physics.removeMesh(mesh);
      mesh.position.z = lift;
    }
    pan = { from: lookX, to: 0, u: 0, then: 'place' };
  };

  const rememberCut = (parent: THREE.Mesh, a: THREE.Mesh, b: THREE.Mesh) => {
    if (hintLine.parent === parent) {
      parent.updateWorldMatrix(true, false);
      const wm = hintLine.matrixWorld.clone();
      hintLine.removeFromParent();
      opts.scene.add(hintLine);
      wm.decompose(hintLine.position, hintLine.quaternion, hintLine.scale);
    }
    const profile = ((parent.userData.profile as Poly2[] | undefined) ?? []).map((p) => ({
      x: p.x,
      y: p.y,
    }));
    history.push({
      kind: 'cut',
      geometry: parent.geometry.clone(),
      profile,
      position: parent.position.clone(),
      quaternion: parent.quaternion.clone(),
      scale: parent.scale.clone(),
      material: parent.material,
      depth: Number(parent.userData.depth) || PAPER.depth,
      role: parent.userData.puzzleRole as string | undefined,
      originVolume: Number(parent.userData.originVolume) || 0,
      inFrags: frags.includes(parent),
      children: [a, b],
    });
    paintTools();
  };

  const undo = () => {
    const op = history.pop();
    if (!op || !toolsLive()) {
      if (op) history.push(op);
      return;
    }
    if (op.kind === 'pose') {
      op.mesh.position.copy(op.p);
      op.mesh.quaternion.copy(op.q);
      paintTools();
      return;
    }
    for (const child of op.children) {
      const i = frags.indexOf(child);
      if (i >= 0) frags.splice(i, 1);
      opts.unmountPiece(child);
    }
    const mesh = new THREE.Mesh(op.geometry, op.material);
    mesh.position.copy(op.position);
    mesh.quaternion.copy(op.quaternion);
    mesh.scale.copy(op.scale);
    mesh.userData.cuttable = true;
    mesh.userData.profile = op.profile;
    mesh.userData.depth = op.depth;
    mesh.userData.originVolume = op.originVolume;
    if (op.role) mesh.userData.puzzleRole = op.role;
    opts.mountPiece(mesh);
    if (op.inFrags) frags.push(mesh);
    else {
      hintLine.position.set(0, 0, 0);
      hintLine.quaternion.identity();
      hintLine.scale.set(1, 1, 1);
      mesh.add(hintLine);
    }
    stepsLeft = Math.min(stepBudget(), stepsLeft + 1);
    cuts = Math.max(0, cuts - 1);
    buttonLatched = false;
    refreshButton();
    paintTools();
  };

  const finishPlace = () => {
    if (phase !== 'place') return;
    const live = frags.filter(
      (m) => ((m.userData.profile as Poly2[] | undefined)?.length ?? 0) >= 3,
    );
    const cands: { mesh: THREE.Mesh; id: string; iou: number }[] = [];
    for (const mesh of live) {
      mesh.updateMatrixWorld(true);
      const poly = worldPoly(mesh).map((p) => ({
        x: p.x - board.position.x,
        y: p.y - board.position.y,
      }));
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
    }
    const shape = ious.reduce((s, n) => s + n, 0) / Math.max(1, ious.length);
    const color = colors.reduce((s, n) => s + n, 0) / Math.max(1, colors.length);
    stars = starRank(shape, color);
    phase = 'inspect';
    t = 0;
    fingers.clear();
    endPlace();
    if (held) restPiece(held);
    held = null;
    setThumbHit(false);
    paintTools();
  };

  hit.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (phase === 'cut' && buttonLatched) beginInstall();
    else if (phase === 'place') finishPlace();
  });

  const returnPreview = () => {
    resultEl.classList.remove('is-on');
    starsEl.classList.remove('is-pop');
    starsEl.dataset.n = '0';
    goalLive = false;
    holdSettings = true;
    holdPreview = true;
    t = 0;
    pan = null;
    clearHistory();
    hintLine.removeFromParent();
    opts.clearBoard();
    mountLevel();
    rebuildHint();
    lookX = 0;
    lookZ = VIEW.cameraZ;
    phase = 'show';
    showNotebook();
    paintSteps();
    paintTools();
    setThumbHit(false);
  };
  const stopTool = (ev: Event) => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  undoBtn.addEventListener('pointerdown', (ev) => {
    stopTool(ev);
    undo();
  });
  const leaveScore = (next: boolean) => {
    resultEl.classList.remove('is-on');
    starsEl.classList.remove('is-pop');
    starsEl.dataset.n = '0';
    t = 0;
    clearHistory();
    hintLine.removeFromParent();
    opts.clearBoard();
    if (next) level = level === 'butterfly' ? 'turtle' : 'butterfly';
    mountLevel();
    rebuildHint();
    lookX = 0;
    lookZ = VIEW.cameraZ;
    pan = null;
    phase = 'show';
    showNotebook();
    paintSteps();
    paintTools();
  };
  previewBtn.addEventListener('pointerdown', (ev) => {
    stopTool(ev);
    if (phase === 'show') return;
    returnPreview();
  });
  replayBtn.addEventListener('pointerdown', (ev) => {
    stopTool(ev);
    if (phase !== 'score') return;
    leaveScore(false);
  });
  nextBtn.addEventListener('pointerdown', (ev) => {
    stopTool(ev);
    if (phase !== 'score') return;
    leaveScore(true);
  });
  goalEl.ownerDocument.addEventListener('pointerdown', (ev) => {
    const target = ev.target;
    if (target instanceof Element && target.closest('.puzzle-preview, .puzzle-settings, .puzzle-result, .puzzle-tool, .puzzle-submit-hit')) return;
    if (goalLive) dismissGoal();
    if (holdPreview && phase === 'show') {
      phase = 'pan';
      pan = { from: lookX, to: puzzleCutX(), u: 0, then: 'cut' };
      holdPreview = false;
      holdSettings = false;
      goalLive = level === 'butterfly';
      goalTimer = 0;
      if (goalLive) goalEl.classList.remove('is-fade');
      paintSteps();
      opts.spawnBoard();
    }
  });
  hintBtn.addEventListener('pointerdown', (ev) => {
    stopTool(ev);
    if (phase !== 'cut') return;
    hintOn = !hintOn;
    paintTools();
  });

  const stage = document.getElementById('stage');
  const fingers = new Map<number, { x: number; y: number }>();
  let held: THREE.Mesh | null = null;
  const restScales = new Map<THREE.Mesh, THREE.Vector3>();
  const scaleTweens: Array<{
    mesh: THREE.Mesh;
    from: THREE.Vector3;
    to: THREE.Vector3;
    fromZ: number;
    toZ: number;
    u: number;
    lift: boolean;
  }> = [];
  const GROW = 1.05;
  const SCALE_DUR = 0.18;
  const startScale = (mesh: THREE.Mesh, to: THREE.Vector3, toZ: number, lift: boolean) => {
    const prev = scaleTweens.findIndex((item) => item.mesh === mesh);
    const next = {
      mesh,
      from: mesh.scale.clone(),
      to,
      fromZ: mesh.position.z,
      toZ,
      u: 0,
      lift,
    };
    if (prev >= 0) scaleTweens[prev] = next;
    else scaleTweens.push(next);
  };
  const liftPiece = (mesh: THREE.Mesh) => {
    if (!restScales.has(mesh)) restScales.set(mesh, mesh.scale.clone());
    const base = restScales.get(mesh)!;
    mesh.renderOrder = 8;
    startScale(mesh, base.clone().multiplyScalar(GROW), page.position.z + 0.085, true);
  };
  const restPiece = (mesh: THREE.Mesh) => {
    const base = restScales.get(mesh) ?? mesh.scale.clone();
    startScale(mesh, base.clone(), page.position.z + 0.055, false);
  };
  const tickScales = (dt: number) => {
    for (let i = scaleTweens.length - 1; i >= 0; i--) {
      const item = scaleTweens[i];
      item.u = Math.min(1, item.u + dt / SCALE_DUR);
      const k = 1 - (1 - item.u) ** 3;
      const keep = item.mesh === held && center ? worldCenter() : null;
      item.mesh.scale.lerpVectors(item.from, item.to, k);
      item.mesh.position.z = item.fromZ + (item.toZ - item.fromZ) * k;
      if (keep && held) {
        const now = worldCenter();
        held.position.x += keep.x - now.x;
        held.position.y += keep.y - now.y;
      }
      if (item.u < 1) continue;
      if (!item.lift && item.mesh !== held) item.mesh.renderOrder = 2;
      scaleTweens.splice(i, 1);
    }
  };
  type V2 = { x: number; y: number };
  type PairTrack = {
    ax: number;
    ay: number;
    bx: number;
    by: number;
    ang: number;
    mx: number;
    my: number;
  };
  const PLACE_SMOOTH = 0.45;
  let primaryId: number | null = null;
  let center: V2 | null = null;
  let pair: PairTrack | null = null;
  let pose0: { mesh: THREE.Mesh; p: THREE.Vector3; q: THREE.Quaternion } | null = null;

  const endPlace = () => {
    primaryId = null;
    center = null;
    pair = null;
  };

  const twoFingers = (): { a: V2; b: V2 } | null => {
    if (primaryId == null || fingers.size < 2) return null;
    const a = fingers.get(primaryId);
    let b: V2 | null = null;
    for (const [id, p] of fingers) {
      if (id === primaryId) continue;
      b = p;
      break;
    }
    if (!a || !b) return null;
    return { a, b };
  };

  const seedPair = (a: V2, b: V2): PairTrack => ({
    ax: a.x,
    ay: a.y,
    bx: b.x,
    by: b.y,
    ang: Math.atan2(b.y - a.y, b.x - a.x),
    mx: (a.x + b.x) * 0.5,
    my: (a.y + b.y) * 0.5,
  });

  const armPair = () => {
    const pts = twoFingers();
    pair = pts ? seedPair(pts.a, pts.b) : null;
  };

  const stepPair = (a: V2, b: V2) => {
    if (!pair) return null;
    const k = PLACE_SMOOTH;
    pair.ax += (a.x - pair.ax) * k;
    pair.ay += (a.y - pair.ay) * k;
    pair.bx += (b.x - pair.bx) * k;
    pair.by += (b.y - pair.by) * k;
    const ang = Math.atan2(pair.by - pair.ay, pair.bx - pair.ax);
    const mx = (pair.ax + pair.bx) * 0.5;
    const my = (pair.ay + pair.by) * 0.5;
    let dA = ang - pair.ang;
    if (dA > Math.PI) dA -= Math.PI * 2;
    if (dA < -Math.PI) dA += Math.PI * 2;
    const dX = mx - pair.mx;
    const dY = my - pair.my;
    pair.ang = ang;
    pair.mx = mx;
    pair.my = my;
    return { dA, dX, dY };
  };

  const lockCenter = (mesh: THREE.Mesh) => {
    const raw = (mesh.userData.profile as Poly2[] | undefined) ?? [];
    center = raw.length >= 3 ? areaCentroid(raw) : { x: 0, y: 0 };
  };

  const worldCenter = () => {
    if (!held || !center) return { x: held?.position.x ?? 0, y: held?.position.y ?? 0 };
    held.updateMatrixWorld(true);
    const e = held.matrixWorld.elements;
    return {
      x: e[0] * center.x + e[4] * center.y + e[12],
      y: e[1] * center.x + e[5] * center.y + e[13],
    };
  };

  const turnAboutCenter = (dA: number, dX: number, dY: number) => {
    if (!held) return;
    const c = worldCenter();
    const ox = held.position.x - c.x;
    const oy = held.position.y - c.y;
    const co = Math.cos(dA);
    const si = Math.sin(dA);
    held.position.x = c.x + dX + ox * co - oy * si;
    held.position.y = c.y + dY + ox * si + oy * co;
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
    e.stopImmediatePropagation();
    const at = worldOnPlane(e);
    if (!at) return;
    fingers.set(e.pointerId, at);
    e.preventDefault();
    if (!held) {
      const mesh = pickFrag(at.x, at.y);
      if (!mesh) {
        if (fingers.size < 2) fingers.delete(e.pointerId);
        return;
      }
      held = mesh;
      primaryId = e.pointerId;
      lockCenter(mesh);
      pose0 = {
        mesh,
        p: mesh.position.clone(),
        q: mesh.quaternion.clone(),
      };
      liftPiece(mesh);
    }
    armPair();
  };

  const onPlaceMove = (e: PointerEvent) => {
    const prev = fingers.get(e.pointerId);
    if (!prev || !held) return;
    const at = worldOnPlane(e);
    if (!at) return;
    fingers.set(e.pointerId, at);
    const pts = twoFingers();
    if (pts && pair) {
      const step = stepPair(pts.a, pts.b);
      if (step) turnAboutCenter(step.dA, step.dX, step.dY);
      return;
    }
    held.position.x += at.x - prev.x;
    held.position.y += at.y - prev.y;
  };

  const onPlaceUp = (e: PointerEvent) => {
    fingers.delete(e.pointerId);
    pair = null;
    if (fingers.size === 0) {
      if (held && pose0 && pose0.mesh === held) {
        const moved =
          held.position.distanceTo(pose0.p) > 1e-4 ||
          1 - Math.abs(held.quaternion.dot(pose0.q)) > 1e-5;
        if (moved) history.push({ kind: 'pose', mesh: held, p: pose0.p, q: pose0.q });
        paintTools();
      }
      if (held) restPiece(held);
      held = null;
      pose0 = null;
      endPlace();
      return;
    }
    if (e.pointerId === primaryId) {
      primaryId = fingers.keys().next().value ?? null;
    }
    armPair();
  };

  const onPlaceMoveWindow = (e: PointerEvent) => {
    if (stage && e.target instanceof Node && stage.contains(e.target)) return;
    onPlaceMove(e);
  };
  const onPlaceUpWindow = (e: PointerEvent) => {
    if (stage && e.target instanceof Node && stage.contains(e.target)) return;
    onPlaceUp(e);
  };

  stage?.addEventListener('pointerdown', onPlaceDown, true);
  stage?.addEventListener('pointermove', onPlaceMove);
  stage?.addEventListener('pointerup', onPlaceUp);
  stage?.addEventListener('pointercancel', onPlaceUp);
  window.addEventListener('pointermove', onPlaceMoveWindow);
  window.addEventListener('pointerup', onPlaceUpWindow);
  window.addEventListener('pointercancel', onPlaceUpWindow);

  return {
    phase: () => phase,
    canCut: () => phase === 'cut' && stepsLeft > 0,
    cuts: () => cuts,
    level: () => level,
    forget,
    sheetScale: () => PATTERN_FIT * shade[level].size,
    attachSheet: (mesh: THREE.Mesh) => {
      sheetFit = mesh.scale.x || 1;
      hintLine.position.set(0, 0, 0);
      hintLine.quaternion.identity();
      hintLine.scale.set(1, 1, 1);
      mesh.add(hintLine);
      paintTools();
    },
    rememberCut,
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
    scorePlacement: () => finishPlace(),
    step: (dt) => {
      placeNotebook();
      tickScales(dt);
      t += dt;
      if (goalLive && phase === 'cut') {
        goalTimer += dt;
        if (goalTimer >= 2) dismissGoal();
      }
      const glide = () => {
        if (!pan) return false;
        const prev = lookX;
        const prevU = pan.u;
        pan.u = Math.min(1, pan.u + dt / Math.max(0.05, PUZZLE.panDur));
        const u = 1 - (1 - pan.u) ** 3;
        lookX = pan.from + (pan.to - pan.from) * u;
        const zCut = cutCamZ();
        lookZ = pan.then === 'cut'
          ? VIEW.cameraZ + (zCut - VIEW.cameraZ) * u
          : zCut + (VIEW.cameraZ - zCut) * u;
        if (pan.then === 'place') {
          const dx = lookX - prev + NOTEBOOK.x * (pan.u - prevU);
          for (const mesh of frags) mesh.position.x += dx;
        }
        if (pan.u >= 1) {
          const then = pan.then;
          pan = null;
          if (then === 'cut') beginCut();
          else {
            phase = 'place';
            for (let i = history.length - 1; i >= 0; i--) {
              const op = history[i];
              if (op.kind !== 'cut') continue;
              op.geometry.dispose();
              history.splice(i, 1);
            }
            showNotebook();
            hit.textContent = '完成';
            setThumbHit(true);
            paintSteps();
            paintTools();
          }
        }
        return true;
      };
      if (phase === 'show') {
        lookX = 0;
        lookZ = VIEW.cameraZ;
        showNotebook();
        paintSteps();
        paintTools();
        setThumbHit(false);
        opts.setLook(lookX, lookZ);
        if (t >= PUZZLE.showDur && !holdPreview) {
          phase = 'pan';
          pan = { from: lookX, to: puzzleCutX(), u: 0, then: 'cut' };
          holdPreview = false;
          holdSettings = false;
          goalLive = level === 'butterfly';
          goalTimer = 0;
          if (goalLive) goalEl.classList.remove('is-fade');
          paintSteps();
          opts.spawnBoard();
        }
        return;
      }
      if (phase === 'pan' || phase === 'carry') {
        glide();
        opts.setLook(lookX, lookZ);
        return;
      }
      opts.setLook(lookX, lookZ);
      if (phase === 'inspect') {
        if (t >= PUZZLE.inspectDur) {
          phase = 'score';
          t = 0;
          starsEl.dataset.n = String(stars);
          starsEl.classList.remove('is-pop');
          void starsEl.offsetWidth;
          starsEl.classList.add('is-pop');
          resultEl.classList.add('is-on');
        }
        return;
      }
      if (phase === 'score') return;
    },
    dispose: () => {
      hit.remove();
      undoBtn.remove();
      hintBtn.remove();
      previewBtn.remove();
      hintLine.geometry.dispose();
      hintMat.dispose();
      stepsEl.remove();
      stage?.removeEventListener('pointerdown', onPlaceDown, true);
      stage?.removeEventListener('pointermove', onPlaceMove);
      stage?.removeEventListener('pointerup', onPlaceUp);
      stage?.removeEventListener('pointercancel', onPlaceUp);
      window.removeEventListener('pointermove', onPlaceMoveWindow);
      window.removeEventListener('pointerup', onPlaceUpWindow);
      window.removeEventListener('pointercancel', onPlaceUpWindow);
      resultEl.remove();
      goalEl.remove();
      tuneEl?.remove();
      opts.scene.remove(board);
      for (const mesh of slots.values()) mesh.geometry.dispose();
      for (const mesh of extras) mesh.geometry.dispose();
      cover.geometry.dispose();
      page.geometry.dispose();
      ringGeom.dispose();
      holeGeom.dispose();
      coverFace.dispose();
      coverEdge.dispose();
      pageFace.dispose();
      pageEdge.dispose();
      ringFace.dispose();
      shadow.geometry.dispose();
      shadowMat.dispose();
      eyeMat.map?.dispose();
      eyeMat.dispose();
      butterflyEyeMat.map?.dispose();
      butterflyEyeMat.dispose();
      butterflyShadow.map?.dispose();
      butterflyShadow.dispose();
      shadowFace.map?.dispose();
      shadowFace.dispose();
      shadowEdge.map?.dispose();
      shadowEdge.dispose();
      turtleHeadRimMat.map?.dispose();
      turtleHeadRimMat.dispose();
      butterflyEyeShadowMat.dispose();
      pieceShadowMat.dispose();
      turtleOuterDropMat.dispose();
      butterflyOuterDropMat.dispose();
      shadowEdge.dispose();
      butterflyShadow.dispose();
      paperShade.dispose();
      headFace.map?.dispose();
      headFace.dispose();
      headEdge.map?.dispose();
      headEdge.dispose();
    },
  };
}
