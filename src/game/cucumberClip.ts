import * as THREE from 'three';
import { ClippingGroup } from 'three/webgpu';
import { CYL } from './design';
import type { DesignPoint } from './slashInput';
import { designToLocalXY } from './slashHit';
import { isSolid3d } from './solid3d';

function cucumberSliceTexture(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const g = c.getContext('2d');
  if (!g) return new THREE.CanvasTexture(c);
  const cx = s * 0.5;
  const cy = s * 0.5;
  const r = s * 0.48;
  g.fillStyle = '#3f8a2a';
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#2a5c18';
  g.beginPath();
  g.arc(cx, cy, r * 0.92, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#dde8b0';
  g.beginPath();
  g.arc(cx, cy, r * 0.84, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#c5d48a';
  g.beginPath();
  g.ellipse(cx, cy, r * 0.28, r * 0.22, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#c8c070';
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.2;
    const rr = r * 0.2;
    g.beginPath();
    g.ellipse(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.75, 5, 8, a, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const _fwd = new THREE.Vector3();
const _n = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _mat = new THREE.Matrix4();

export type CucumberClip = {
  show: (
    mesh: THREE.Mesh,
    camera: THREE.Camera,
    c0: DesignPoint,
    c1: DesignPoint,
  ) => void;
  hide: () => void;
  dispose: () => void;
};

export function createCucumberClip(scene: THREE.Scene): CucumberClip {
  const group = new ClippingGroup();
  group.enabled = false;
  const plane = new THREE.Plane();
  group.clippingPlanes = [plane];
  scene.add(group);

  const capTex = cucumberSliceTexture();
  const capMat = new THREE.MeshLambertMaterial({
    map: capTex,
    color: 0xffffff,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const cap = new THREE.Mesh(new THREE.CircleGeometry(1, 48), capMat);
  cap.visible = false;
  cap.renderOrder = 2;
  scene.add(cap);

  const hide = () => {
    group.enabled = false;
    cap.visible = false;
  };

  const show: CucumberClip['show'] = (mesh, camera, c0, c1) => {
    if (!isSolid3d(mesh)) {
      hide();
      return;
    }
    mesh.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    const a = designToLocalXY(c0, camera, mesh);
    const b = designToLocalXY(c1, camera, mesh);
    if (!a || !b) {
      hide();
      return;
    }
    const la = new THREE.Vector3(a.x, a.y, 0);
    const lb = new THREE.Vector3(b.x, b.y, 0);
    mesh.localToWorld(la);
    mesh.localToWorld(lb);
    const blade = lb.clone().sub(la);
    if (blade.lengthSq() < 1e-8) {
      hide();
      return;
    }
    blade.normalize();
    camera.getWorldDirection(_fwd);
    _n.crossVectors(blade, _fwd);
    if (_n.lengthSq() < 1e-8) {
      hide();
      return;
    }
    _n.normalize();
    const origin = la.clone().add(lb).multiplyScalar(0.5);
    plane.setFromNormalAndCoplanarPoint(_n, origin);

    if (mesh.parent !== group) group.attach(mesh);
    group.enabled = true;

    const r = (mesh.userData.cylRadius as number | undefined) ?? CYL.radius;
    _axis.set(0, 1, 0).transformDirection(mesh.matrixWorld).normalize();
    const along = Math.abs(_n.dot(_axis));
    if (along < 0.28) {
      cap.visible = false;
      return;
    }
    _y.copy(_axis).addScaledVector(_n, -_n.dot(_axis));
    if (_y.lengthSq() < 1e-6) _y.copy(blade);
    _y.normalize();
    _x.crossVectors(_y, _n).normalize();
    _y.crossVectors(_n, _x).normalize();
    _mat.makeBasis(_x, _y, _n);
    cap.quaternion.setFromRotationMatrix(_mat);
    cap.position.copy(origin).addScaledVector(_n, 0.006);
    const major = r / along;
    cap.scale.set(r, major, 1);
    cap.visible = true;
  };

  return {
    show,
    hide,
    dispose: () => {
      hide();
      cap.geometry.dispose();
      capMat.dispose();
      capTex.dispose();
      scene.remove(cap);
      scene.remove(group);
    },
  };
}
