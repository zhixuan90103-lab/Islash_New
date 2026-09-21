import * as THREE from 'three';
import { CYL } from './design';
import type { DesignPoint } from './slashInput';
import { designToLocalXY } from './slashHit';
import { ensureCcw, stadiumProfile, type Poly2 } from './woodProfile';

const _fwd = new THREE.Vector3();
const _n = new THREE.Vector3();

type Vtx = {
  p: THREE.Vector3;
  n: THREE.Vector3;
  uv: THREE.Vector2;
};

function hullXY(geom: THREE.BufferGeometry): Poly2[] {
  const pos = geom.getAttribute('position');
  if (!pos || pos.count < 3) return [];
  const raw: Poly2[] = [];
  for (let i = 0; i < pos.count; i++) {
    raw.push({ x: pos.getX(i), y: pos.getY(i) });
  }
  raw.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Poly2, a: Poly2, b: Poly2) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Poly2[] = [];
  for (const p of raw) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Poly2[] = [];
  for (let i = raw.length - 1; i >= 0; i--) {
    const p = raw[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  if (hull.length < 3) return [];
  return ensureCcw(hull);
}

function spanZ(geom: THREE.BufferGeometry): number {
  const pos = geom.getAttribute('position');
  if (!pos || pos.count < 1) return 0.08;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return Math.max(0.05, maxZ - minZ);
}

function tagSolidPiece(piece: THREE.Mesh, source: THREE.Mesh): boolean {
  const profile = hullXY(piece.geometry);
  if (profile.length < 3) return false;
  piece.userData.kind = 'solid3d';
  piece.userData.profile = profile;
  piece.userData.depth = spanZ(piece.geometry);
  piece.userData.originVolume = source.userData.originVolume;
  piece.userData.cuttable = true;
  piece.castShadow = true;
  piece.receiveShadow = false;
  piece.userData.outerMat = source.userData.outerMat;
  piece.userData.innerMat = source.userData.innerMat;
  return true;
}

export function isSolid3d(mesh: THREE.Mesh): boolean {
  return mesh.userData.kind === 'solid3d';
}

function planeSide(p: THREE.Vector3, n: THREE.Vector3, o: THREE.Vector3): number {
  const d = n.dot(p) - n.dot(o);
  if (d > 1e-5) return 1;
  if (d < -1e-5) return -1;
  return 0;
}

function lerpVtx(a: Vtx, b: Vtx, n: THREE.Vector3, o: THREE.Vector3): Vtx {
  const da = n.dot(a.p) - n.dot(o);
  const db = n.dot(b.p) - n.dot(o);
  const t = da / (da - db);
  const tt = Math.min(1, Math.max(0, t));
  const p = a.p.clone().lerp(b.p, tt);
  p.addScaledVector(n, n.dot(o) - n.dot(p));
  return {
    p,
    n: a.n.clone().lerp(b.n, tt).normalize(),
    uv: a.uv.clone().lerp(b.uv, tt),
  };
}

function pushTri(
  pos: number[],
  nrm: number[],
  uv: number[],
  a: Vtx,
  b: Vtx,
  c: Vtx,
): void {
  const tri = [a, b, c];
  for (const v of tri) {
    pos.push(v.p.x, v.p.y, v.p.z);
    nrm.push(v.n.x, v.n.y, v.n.z);
    uv.push(v.uv.x, v.uv.y);
  }
}

function faceAlongPlane(a: Vtx, b: Vtx, c: Vtx, n: THREE.Vector3): boolean {
  const abx = b.p.x - a.p.x;
  const aby = b.p.y - a.p.y;
  const abz = b.p.z - a.p.z;
  const acx = c.p.x - a.p.x;
  const acy = c.p.y - a.p.y;
  const acz = c.p.z - a.p.z;
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-10) return true;
  return Math.abs((nx * n.x + ny * n.y + nz * n.z) / len) > 0.94;
}

function geomFromArrays(
  pos: number[],
  nrm: number[],
  uv: number[],
  capStart: number,
): THREE.BufferGeometry | null {
  if (pos.length < 9) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const outerCount = capStart / 3;
  const capCount = pos.length / 3 - outerCount;
  g.clearGroups();
  if (outerCount > 0) g.addGroup(0, outerCount, 0);
  if (capCount > 0) g.addGroup(outerCount, capCount, 1);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

type Cap2 = { x: number; y: number; p: THREE.Vector3 };

function weldCapPoints(raw: THREE.Vector3[], n: THREE.Vector3, o: THREE.Vector3): Cap2[] {
  const tmp = new THREE.Vector3(1, 0, 0);
  if (Math.abs(n.dot(tmp)) > 0.92) tmp.set(0, 1, 0);
  const u = tmp.clone().cross(n).normalize();
  const v = n.clone().cross(u).normalize();
  const seen = new Set<string>();
  const pts: Cap2[] = [];
  for (const p of raw) {
    const q = p.clone().addScaledVector(n, n.dot(o) - n.dot(p));
    const x = u.dot(q.clone().sub(o));
    const y = v.dot(q.clone().sub(o));
    const k = `${x.toFixed(4)},${y.toFixed(4)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    pts.push({ x, y, p: q });
  }
  return pts;
}

function hullCap2(pts: Cap2[]): Cap2[] {
  if (pts.length < 3) return pts;
  const sorted = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (A: Cap2, B: Cap2, C: Cap2) =>
    (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
  const lower: Cap2[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Cap2[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function fanCap(
  loop: THREE.Vector3[],
  n: THREE.Vector3,
  o: THREE.Vector3,
  outN: THREE.Vector3,
  pos: number[],
  nrm: number[],
  uv: number[],
): void {
  const welded = weldCapPoints(loop, n, o);
  const hull = hullCap2(welded);
  if (hull.length < 3) return;
  const tmp = new THREE.Vector3(1, 0, 0);
  if (Math.abs(n.dot(tmp)) > 0.92) tmp.set(0, 1, 0);
  const u = tmp.clone().cross(n).normalize();
  const v = n.clone().cross(u).normalize();
  const c = new THREE.Vector3();
  for (const q of hull) c.add(q.p);
  c.multiplyScalar(1 / hull.length);
  const e1 = hull[1].p.clone().sub(hull[0].p);
  const e2 = hull[2].p.clone().sub(hull[0].p);
  const wind = new THREE.Vector3().crossVectors(e1, e2);
  const flip = wind.dot(outN) < 0;
  const nx = outN.x;
  const ny = outN.y;
  const nz = outN.z;
  for (let i = 0; i < hull.length; i++) {
    const j = (i + 1) % hull.length;
    const a = hull[i].p;
    const b = hull[j].p;
    const order = flip ? [c, b, a] : [c, a, b];
    for (const p of order) {
      pos.push(p.x, p.y, p.z);
      nrm.push(nx, ny, nz);
      uv.push(
        0.5 + u.dot(p.clone().sub(c)) * CYL.uvScale,
        0.5 + v.dot(p.clone().sub(c)) * CYL.uvScale,
      );
    }
  }
}

/** 平面剖封闭网格，两侧都封切面。 */
export function clipMeshByPlane(
  geom: THREE.BufferGeometry,
  n: THREE.Vector3,
  o: THREE.Vector3,
): { pos: THREE.BufferGeometry; neg: THREE.BufferGeometry } | null {
  const src = geom.index ? geom.toNonIndexed() : geom;
  const pa = src.getAttribute('position');
  const na = src.getAttribute('normal');
  const ua = src.getAttribute('uv');
  if (!pa || pa.count < 3) return null;
  const read = (i: number): Vtx => ({
    p: new THREE.Vector3(pa.getX(i), pa.getY(i), pa.getZ(i)),
    n: na
      ? new THREE.Vector3(na.getX(i), na.getY(i), na.getZ(i))
      : new THREE.Vector3(0, 0, 1),
    uv: ua ? new THREE.Vector2(ua.getX(i), ua.getY(i)) : new THREE.Vector2(0, 0),
  });

  const posA: number[] = [];
  const nrmA: number[] = [];
  const uvA: number[] = [];
  const posB: number[] = [];
  const nrmB: number[] = [];
  const uvB: number[] = [];
  const capPts: THREE.Vector3[] = [];

  const addCap = (p: THREE.Vector3) => {
    capPts.push(p.clone());
  };

  for (let i = 0; i < pa.count; i += 3) {
    const v0 = read(i);
    const v1 = read(i + 1);
    const v2 = read(i + 2);
    const s0 = planeSide(v0.p, n, o);
    const s1 = planeSide(v1.p, n, o);
    const s2 = planeSide(v2.p, n, o);
    const vs = [v0, v1, v2];
    const ss = [s0, s1, s2];
    if (s0 === 0) addCap(v0.p);
    if (s1 === 0) addCap(v1.p);
    if (s2 === 0) addCap(v2.p);
    if (s0 === 0 && s1 === 0 && s2 === 0) continue;
    if (s0 >= 0 && s1 >= 0 && s2 >= 0) {
      if (!faceAlongPlane(v0, v1, v2, n)) pushTri(posA, nrmA, uvA, v0, v1, v2);
      continue;
    }
    if (s0 <= 0 && s1 <= 0 && s2 <= 0) {
      if (!faceAlongPlane(v0, v1, v2, n)) pushTri(posB, nrmB, uvB, v0, v1, v2);
      continue;
    }
    const posV: Vtx[] = [];
    const negV: Vtx[] = [];
    for (let k = 0; k < 3; k++) {
      const cur = vs[k];
      const nxt = vs[(k + 1) % 3];
      const sc = ss[k];
      const snx = ss[(k + 1) % 3];
      if (sc > 0) posV.push(cur);
      else if (sc < 0) negV.push(cur);
      else {
        posV.push(cur);
        negV.push(cur);
      }
      if ((sc > 0 && snx < 0) || (sc < 0 && snx > 0)) {
        const hit = lerpVtx(cur, nxt, n, o);
        posV.push(hit);
        negV.push(hit);
        addCap(hit.p);
      }
    }
    const emit = (
      arrP: number[],
      arrN: number[],
      arrU: number[],
      vs: Vtx[],
    ) => {
      const emitOne = (a: Vtx, b: Vtx, c: Vtx) => {
        if (faceAlongPlane(a, b, c, n)) {
          addCap(a.p);
          addCap(b.p);
          addCap(c.p);
          return;
        }
        pushTri(arrP, arrN, arrU, a, b, c);
      };
      if (vs.length === 3) emitOne(vs[0], vs[1], vs[2]);
      else if (vs.length === 4) {
        emitOne(vs[0], vs[1], vs[2]);
        emitOne(vs[0], vs[2], vs[3]);
      }
    };
    emit(posA, nrmA, uvA, posV);
    emit(posB, nrmB, uvB, negV);
  }

  const capStartA = posA.length;
  const capStartB = posB.length;
  fanCap(capPts, n, o, n.clone().negate(), posA, nrmA, uvA);
  fanCap(capPts, n, o, n, posB, nrmB, uvB);
  const ga = geomFromArrays(posA, nrmA, uvA, capStartA);
  const gb = geomFromArrays(posB, nrmB, uvB, capStartB);
  if (!ga || !gb) {
    ga?.dispose();
    gb?.dispose();
    return null;
  }
  return { pos: ga, neg: gb };
}

export function createSolidCylinderMesh(
  radius: number,
  length: number,
  outer: THREE.Material,
  inner: THREE.Material,
): THREE.Mesh {
  const mid = Math.max(0.02, length - 2 * radius);
  const geom = new THREE.CapsuleGeometry(radius, mid, 8, 28);
  const idx = geom.getIndex();
  geom.clearGroups();
  if (idx) geom.addGroup(0, idx.count, 0);
  else geom.addGroup(0, geom.getAttribute('position').count, 0);
  geom.computeVertexNormals();
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  const mesh = new THREE.Mesh(geom, [outer, inner]);
  mesh.userData.kind = 'solid3d';
  mesh.userData.profile = stadiumProfile(length, radius);
  mesh.userData.depth = radius * 2;
  mesh.userData.cylRadius = radius;
  mesh.userData.outerMat = outer;
  mesh.userData.innerMat = inner;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.userData.cuttable = true;
  return mesh;
}

export function sliceSolid3d(
  mesh: THREE.Mesh,
  camera: THREE.Camera,
  p0: DesignPoint,
  p1: DesignPoint,
): {
  a: THREE.Mesh;
  b: THREE.Mesh;
  normal: THREE.Vector3;
  bladeDir: THREE.Vector3;
  hitPoint: THREE.Vector3;
} | null {
  mesh.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  const a = designToLocalXY(p0, camera, mesh);
  const b = designToLocalXY(p1, camera, mesh);
  if (!a || !b) return null;

  const la = new THREE.Vector3(a.x, a.y, 0);
  const lb = new THREE.Vector3(b.x, b.y, 0);
  mesh.localToWorld(la);
  mesh.localToWorld(lb);
  const bladeDir = lb.clone().sub(la);
  if (bladeDir.lengthSq() < 1e-10) bladeDir.copy(camera.up);
  else bladeDir.normalize();
  const hitPoint = la.clone().add(lb).multiplyScalar(0.5);
  camera.getWorldDirection(_fwd);
  _n.crossVectors(bladeDir, _fwd);
  if (_n.lengthSq() < 1e-8) _n.copy(camera.up);
  else _n.normalize();

  const inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  const localN = _n.clone().transformDirection(inv).normalize();
  const localO = hitPoint.clone().applyMatrix4(inv);

  const clipped = clipMeshByPlane(mesh.geometry, localN, localO);
  if (!clipped) return null;

  const outer = (mesh.userData.outerMat as THREE.Material | undefined) ??
    (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material);
  const inner = (mesh.userData.innerMat as THREE.Material | undefined) ?? outer;

  const capMat =
    inner instanceof THREE.MeshLambertMaterial
      ? inner
      : new THREE.MeshLambertMaterial({
          color: CYL.flesh,
          side: THREE.DoubleSide,
        });
  if (capMat instanceof THREE.MeshLambertMaterial) {
    capMat.map = null;
    capMat.side = THREE.DoubleSide;
  }
  const pa = new THREE.Mesh(clipped.pos, [outer, capMat]);
  const pb = new THREE.Mesh(clipped.neg, [outer, capMat]);
  pa.position.copy(mesh.position);
  pa.quaternion.copy(mesh.quaternion);
  pa.scale.copy(mesh.scale);
  pb.position.copy(mesh.position);
  pb.quaternion.copy(mesh.quaternion);
  pb.scale.copy(mesh.scale);
  if (!tagSolidPiece(pa, mesh) || !tagSolidPiece(pb, mesh)) {
    pa.geometry.dispose();
    pb.geometry.dispose();
    return null;
  }

  return {
    a: pa,
    b: pb,
    normal: _n.clone(),
    bladeDir,
    hitPoint,
  };
}
