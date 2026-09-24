import * as THREE from 'three';
import { pieceVolume } from './bladeForce';
import { CUT, CYL, PAPER, VIEW, WOOD, bevelInset, viewHalfH, woodSize } from './design';
import { TURTLE, paperFaceTexture, turtleInkTexture } from './turtleLevel';
import { createSolidCylinderMesh } from './solid3d';
import { createCucumberSkinTexture } from './cucumberLook';
import woodGrainUrl from '../assets/wood-grain.jpg';
import { createWoodSolid } from './woodChamfer';
import {
  catalogBoardProfile,
  circleProfileAt,
  polyCentroid,
  polySpanX,
  polySpanY,
  rectProfile,
  type Poly2,
} from './woodProfile';
import type { SlashPhysics } from './slashPhysics';

export type { Poly2 } from './woodProfile';
export {
  circleProfileAt,
  ensureCcw,
  polyCentroid,
  polySpanX,
  polySpanY,
  rectProfile,
  splitConvexPolygon,
} from './woodProfile';

export function prepareCuttable(mesh: THREE.Mesh): void {
  mesh.userData.cuttable = true;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
}

/** @deprecated 历史名，实际是竖挤 + 半平面内收倒角，不是锥台。 */
export function createFrustumGeometry(
  profile: Poly2[],
  depth: number,
  inset: number,
): THREE.BufferGeometry | null {
  return createWoodSolid(profile, depth, inset);
}

export function createWoodGeometry(
  width: number,
  height: number,
  depth: number,
): THREE.BufferGeometry {
  const geom = createWoodSolid(
    rectProfile(width, height),
    depth,
    bevelInset(depth),
  );
  if (!geom) {
    return new THREE.BoxGeometry(width, height, depth);
  }
  return geom;
}

export function meshFromProfile(
  profile: Poly2[],
  depth: number,
  source: THREE.Mesh,
): THREE.Mesh | null {
  const paper = source.userData.puzzleRole === 'stock';
  const geom = createWoodSolid(
    profile,
    depth,
    paper ? PAPER.edgeInset : bevelInset(depth),
  );
  if (!geom) return null;
  const srcMat = source.material;
  const mat = Array.isArray(srcMat)
    ? srcMat.map((m) => m.clone())
    : (srcMat as THREE.Material).clone();
  if (paper && Array.isArray(mat)) mat[1] = mat[0];
  if (paper) flattenPaperRim(geom);
  const m = new THREE.Mesh(geom, mat);
  m.position.copy(source.position);
  m.quaternion.copy(source.quaternion);
  m.scale.copy(source.scale);
  m.userData.cuttable = true;
  if (paper) m.userData.puzzleRole = 'stock';
  m.userData.profile = (geom.userData.profile as Poly2[] | undefined) ?? profile;
  m.userData.depth = depth;
  m.userData.originVolume = source.userData.originVolume;
  copySolidUserData(source, m);
  return m;
}

/** 纸的侧面不另上色，法线也朝向正面，避免切缝露出一条棱。 */
function flattenPaperRim(geom: THREE.BufferGeometry): void {
  const nrm = geom.getAttribute('normal');
  const rim = geom.groups.find((g) => g.materialIndex === 1);
  if (!nrm || !rim) return;
  for (let i = rim.start; i < rim.start + rim.count; i++) nrm.setXYZ(i, 0, 0, 1);
  nrm.needsUpdate = true;
}

function copySolidUserData(source: THREE.Mesh, dest: THREE.Mesh): void {
  if (source.userData.kind === 'cylinder') {
    dest.userData.kind = 'cylinder';
    dest.userData.cylRadius = source.userData.cylRadius;
  }
}

function finishPiece(m: THREE.Mesh, source: THREE.Mesh): THREE.Mesh {
  m.position.copy(source.position);
  m.quaternion.copy(source.quaternion);
  m.scale.copy(source.scale);
  m.userData.cuttable = true;
  m.userData.originVolume = source.userData.originVolume;
  return m;
}

/** 真圆柱：轴沿 Y，侧面朝相机。不要挤成朝镜头的厚板。 */
export function createCylinderGeometry(
  radius: number,
  length: number,
  cy = 0,
): THREE.BufferGeometry {
  const geom = new THREE.CylinderGeometry(radius, radius, length, 32, 1, false);
  if (Math.abs(cy) > 1e-8) geom.translate(0, cy, 0);
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

function meshFromCylinderLog(poly: Poly2[], source: THREE.Mesh): THREE.Mesh | null {
  const r = source.userData.cylRadius as number | undefined;
  if (!r || r < 1e-4) return null;
  const span = polySpanY(poly);
  if (span < 1e-4) return null;
  const c = polyCentroid(poly);
  const geom = createCylinderGeometry(r, span, c.y);
  const srcMat = source.material;
  const mat = Array.isArray(srcMat)
    ? srcMat.map((m) => m.clone())
    : (srcMat as THREE.Material).clone();
  const m = new THREE.Mesh(geom, mat);
  finishPiece(m, source);
  m.userData.kind = 'cylinder';
  m.userData.cylRadius = r;
  m.userData.profile = poly;
  m.userData.depth = r * 2;
  return m;
}

/** 横切：薄块建成圆片，轴转成朝相机（看见圆切面）。 */
export function meshFromCylinderCoin(
  sliver: Poly2[],
  source: THREE.Mesh,
): THREE.Mesh | null {
  const r = source.userData.cylRadius as number | undefined;
  if (!r || r < 1e-4) return null;
  const span = polySpanY(sliver);
  const thick = Math.max(0.045, Math.min(span, r * CYL.coinSpan));
  const c = polyCentroid(sliver);
  const profile = circleProfileAt(c.x, c.y, r);
  const geom = new THREE.CylinderGeometry(r, r, thick, 32, 1, false);
  geom.rotateX(Math.PI / 2);
  geom.translate(c.x, c.y, 0);
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  const src0 = Array.isArray(source.material) ? source.material[0] : source.material;
  const map =
    src0 instanceof THREE.MeshLambertMaterial ? src0.map : null;
  const skin = new THREE.MeshLambertMaterial({ color: CYL.faceColor, map });
  const flesh = new THREE.MeshLambertMaterial({ color: CYL.fleshColor });
  const m = new THREE.Mesh(geom, [skin, flesh, flesh]);
  finishPiece(m, source);
  m.userData.kind = 'disc';
  m.userData.profile = profile;
  m.userData.depth = thick;
  return m;
}

export function shouldMakeCylinderCoin(poly: Poly2[], source: THREE.Mesh): boolean {
  if (source.userData.kind !== 'cylinder') return false;
  const r = source.userData.cylRadius as number | undefined;
  if (!r) return false;
  return polySpanY(poly) <= r * CYL.coinSpan;
}

function stillCylinderLog(poly: Poly2[], source: THREE.Mesh): boolean {
  if (source.userData.kind !== 'cylinder') return false;
  const r = source.userData.cylRadius as number | undefined;
  if (!r) return false;
  return polySpanX(poly) >= r * 1.55;
}

export function meshFromCutPiece(
  poly: Poly2[],
  depth: number,
  source: THREE.Mesh,
): THREE.Mesh | null {
  if (shouldMakeCylinderCoin(poly, source)) return meshFromCylinderCoin(poly, source);
  if (stillCylinderLog(poly, source)) return meshFromCylinderLog(poly, source);
  return meshFromProfile(poly, depth, source);
}

export type WoodSet = {
  cuttables: THREE.Mesh[];
  faceMat: THREE.MeshLambertMaterial;
  edgeMat: THREE.MeshLambertMaterial;
  spawn: (next?: boolean) => void;
  spawnSquare: () => void;
  spawnDisc: (atX?: number, fit?: number) => void;
  spawnSolidDisc: (color: number, edge: number, atX?: number, fit?: number) => void;
  clear: () => void;
  forget: (mesh: THREE.Mesh) => void;
  track: (mesh: THREE.Mesh) => void;
  dispose: () => void;
};

export function createWoodSet(
  scene: THREE.Scene,
  physics: SlashPhysics,
): WoodSet {
  const cuttables: THREE.Mesh[] = [];
  const spawned: THREE.Mesh[] = [];
  const grain = new THREE.TextureLoader().load(woodGrainUrl);
  grain.wrapS = THREE.ClampToEdgeWrapping;
  grain.wrapT = THREE.ClampToEdgeWrapping;
  grain.colorSpace = THREE.SRGBColorSpace;
  grain.anisotropy = 4;
  const lambert = (color: number) =>
    new THREE.MeshLambertMaterial({
      color,
      map: grain,
      emissive: 0x000000,
      specularMap: null,
      envMap: null,
      reflectivity: 0,
    });
  const matFace = lambert(WOOD.faceColor);
  const matEdge = lambert(VIEW.woodChamfer);
  const mat = [matFace, matEdge];
  const cylSkinMap = createCucumberSkinTexture();
  const cylSkin = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    map: cylSkinMap,
  });
  const cylFlesh = new THREE.MeshLambertMaterial({
    color: CYL.flesh,
    side: THREE.DoubleSide,
  });

  const forget = (mesh: THREE.Mesh) => {
    const i = cuttables.indexOf(mesh);
    if (i >= 0) cuttables.splice(i, 1);
    const si = spawned.indexOf(mesh);
    if (si >= 0) spawned.splice(si, 1);
  };

  const track = (mesh: THREE.Mesh) => {
    spawned.push(mesh);
  };

  let lastShape = -1;

  const spawn = (_next = false) => {
    for (const m of spawned) {
      physics.removeMesh(m);
      scene.remove(m);
      m.geometry.dispose();
    }
    spawned.length = 0;
    cuttables.length = 0;

    const size = woodSize();
    const targetArea = size.width * size.height;
    const picked = catalogBoardProfile(
      targetArea,
      CUT.boardMaxW,
      CUT.boardMaxH,
      lastShape,
    );
    const profile = picked.profile;
    lastShape = picked.index;
    const depth = picked.depth ?? size.depth;
    let mesh: THREE.Mesh;
    if (picked.solid === 'cylinder' && picked.cylRadius) {
      mesh = createSolidCylinderMesh(
        picked.cylRadius,
        polySpanY(profile),
        cylSkin,
        cylFlesh,
      );
    } else {
      const geom =
        createWoodSolid(profile, depth, bevelInset(depth)) ??
        createWoodGeometry(size.width, size.height, size.depth);
      mesh = new THREE.Mesh(geom, mat);
      mesh.userData.profile =
        (geom.userData.profile as Poly2[] | undefined) ?? profile;
      mesh.userData.depth = depth;
    }
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    const minY = bb ? bb.min.y : 0;
    mesh.position.set(0, viewHalfH() + CUT.enterPad - minY, 0);
    mesh.userData.originVolume = pieceVolume(mesh);
    scene.add(mesh);
    prepareCuttable(mesh);
    physics.addMesh(mesh, 'staticConvex');
    cuttables.push(mesh);
    spawned.push(mesh);
  };

  const clear = () => {
    for (const m of spawned) {
      physics.removeMesh(m);
      scene.remove(m);
      m.geometry.dispose();
    }
    spawned.length = 0;
    cuttables.length = 0;
  };

  const spawnSquare = () => {
    clear();

    const size = woodSize();
    const side = Math.min(size.width, size.height) * 1.05;
    const profile = rectProfile(side, side);
    const depth = size.depth;
    const geom =
      createWoodSolid(profile, depth, bevelInset(depth)) ??
      createWoodGeometry(side, side, depth);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.userData.profile =
      (geom.userData.profile as Poly2[] | undefined) ?? profile;
    mesh.userData.depth = depth;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    const minY = bb ? bb.min.y : 0;
    mesh.position.set(0, viewHalfH() + CUT.enterPad - minY, 0);
    mesh.userData.originVolume = pieceVolume(mesh);
    scene.add(mesh);
    prepareCuttable(mesh);
    physics.addMesh(mesh, 'staticConvex');
    cuttables.push(mesh);
    spawned.push(mesh);
  };

  let ink: THREE.CanvasTexture | null = null;
  const spawnDisc = (atX = 0, fit = 1) => {
    clear();
    const profile = circleProfileAt(0, 0, TURTLE.r, 40);
    const depth = PAPER.depth;
    const geom =
      createWoodSolid(profile, depth, PAPER.edgeInset) ??
      createWoodGeometry(TURTLE.r * 2, TURTLE.r * 2, depth);
    if (!ink) ink = turtleInkTexture();
    const face = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      map: ink,
    });
    const mesh = new THREE.Mesh(geom, [face, face]);
    mesh.userData.profile =
      (geom.userData.profile as Poly2[] | undefined) ?? profile;
    mesh.userData.depth = depth;
    mesh.userData.puzzleRole = 'stock';
    mesh.scale.setScalar(fit);
    mesh.position.set(atX, WOOD.lift, 0);
    mesh.userData.originVolume = pieceVolume(mesh);
    scene.add(mesh);
    prepareCuttable(mesh);
    physics.addMesh(mesh, 'staticConvex');
    cuttables.push(mesh);
    spawned.push(mesh);
  };

  const spawnSolidDisc = (color: number, _edgeColor: number, atX = 0, fit = 1) => {
    clear();
    const profile = circleProfileAt(0, 0, TURTLE.r, 40);
    const depth = PAPER.depth;
    const geom =
      createWoodSolid(profile, depth, PAPER.edgeInset) ??
      createWoodGeometry(TURTLE.r * 2, TURTLE.r * 2, depth);
    const face = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      map: paperFaceTexture(color),
    });
    const mesh = new THREE.Mesh(geom, [face, face]);
    mesh.userData.profile =
      (geom.userData.profile as Poly2[] | undefined) ?? profile;
    mesh.userData.depth = depth;
    mesh.userData.puzzleRole = 'stock';
    mesh.scale.setScalar(fit);
    mesh.position.set(atX, WOOD.lift, 0);
    mesh.userData.originVolume = pieceVolume(mesh);
    scene.add(mesh);
    prepareCuttable(mesh);
    physics.addMesh(mesh, 'staticConvex');
    cuttables.push(mesh);
    spawned.push(mesh);
  };

  return {
    cuttables,
    faceMat: matFace,
    edgeMat: matEdge,
    spawn,
    spawnSquare,
    spawnDisc,
    spawnSolidDisc,
    clear,
    forget,
    track,
    dispose: () => {
      for (const m of spawned) {
        physics.removeMesh(m);
        scene.remove(m);
        m.geometry.dispose();
      }
      spawned.length = 0;
      cuttables.length = 0;
      for (const m of mat) m.dispose();
      cylSkin.dispose();
      cylSkinMap.dispose();
      cylFlesh.dispose();
      ink?.dispose();
    },
  };
}
