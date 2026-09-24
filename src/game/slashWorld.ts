import * as THREE from 'three';
import { applyBladeImpulse, pieceVolume } from './bladeForce';
import { boardCutProgress, CUT, FINALE, FLASH, FX, PAPER, puzzleCutX, SHAKE, WOOD } from './design';
import { createCutPuzzle } from './cutPuzzle';
import { BUTTERFLY } from './butterflyLevel';
import { FISH, fishSheet } from './fishLevel';
import { localIsDark, TURTLE } from './turtleLevel';
import { mountCutProgressHud } from './cutProgressHud';
import { createScreenShake, cutHit } from './screenShake';
import type { PhysBody } from './slashPhysics';
import {
  crackAlongStroke,
  resetSlashIntent,
  stepSlashIntent,
} from './slashIntent';
import { beginFollow } from './slashFollow';
import { createSlashOverlay } from './slashDebug';
import { cutMeshBySlash, prepareCuttable } from './slashCut';
import { designToLocalXY, projectMeshHull } from './slashHit';
import {
  createSlashInput,
  segmentSpeedPxPerSec,
  strokePathLength,
  type ConsumedLine,
  type DesignPoint,
  type SlashStroke,
} from './slashInput';
import { createSlashPhysics } from './slashPhysics';
import { createWoodSet } from './wood';
import { createCucumberClip } from './cucumberClip';
import { isSolid3d } from './solid3d';
import { createSlashHaptics } from './slashHaptics';
import { gameAudio } from '../audio/gameAudio';
import type { StageLayout } from '../adapt/design';

export type SlashSession = {
  step: (dt: number) => void;
  applyView: () => void;
  restoreView: () => void;
  dispose: () => void;
};

function report(msg: string): void {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
}

export async function mountSlashWorld(
  stage: HTMLElement,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  getLayout: () => StageLayout | null,
  setGrid?: (light: number, dark: number) => void,
): Promise<SlashSession> {
  const physics = await createSlashPhysics();
  void gameAudio.preload();
  const overlay = createSlashOverlay(stage);
  const shake = createScreenShake(camera);
  const bladeHaptics = createSlashHaptics();
  const wood = createWoodSet(scene, physics);
  const cucumberClip = createCucumberClip(scene);
  let enter: {
    from: number;
    to: number;
    t: number;
    meshId: number | null;
  } | null = null;
  const beginEnter = () => {
    const mesh = wood.cuttables[0];
    enter = mesh
      ? { from: mesh.position.y, to: WOOD.lift, t: 0, meshId: mesh.id }
      : null;
  };
  const halt = { fly: () => {} };
  const puzzle = createCutPuzzle({
    scene,
    uiRoot: document.getElementById('ui-root'),
    physics,
    spawnBoard: () => {
      const atX = puzzleCutX();
      const fit = puzzle.sheetScale();
      if (puzzle.level() === 'butterfly') wood.spawnSolidDisc(BUTTERFLY.pink, BUTTERFLY.edge, atX, fit);
      else if (puzzle.level() === 'turtle') wood.spawnDisc(atX, fit);
      else wood.spawnPolySheet(fishSheet(), FISH.paper, atX, fit);
      const sheet = wood.cuttables[0];
      if (sheet) puzzle.attachSheet(sheet);
    },
    mountPiece: (mesh) => {
      scene.add(mesh);
      prepareCuttable(mesh);
      if (puzzle.canCut()) physics.addMesh(mesh, 'paper');
      else physics.addMesh(mesh, 'staticConvex');
      wood.cuttables.push(mesh);
      wood.track(mesh);
    },
    unmountPiece: (mesh) => {
      physics.removeMesh(mesh);
      scene.remove(mesh);
      mesh.geometry.dispose();
      wood.forget(mesh);
    },
    clearBoard: () => wood.clear(),
    haltFly: () => halt.fly(),
    camera,
    setLook: (x, z) => {
      shake.setLookX(x);
      if (z != null) shake.setLookZ(z);
    },
    setGrid,
    faceMat: wood.faceMat,
    edgeMat: wood.edgeMat,
  });
  let submitAfterFly = false;
  let nextBoardIn = -1;
  let lastCommit: { c0: DesignPoint; c1: DesignPoint } | null = null;
  let lastMeshFail: { c0: DesignPoint; c1: DesignPoint } | null = null;
  let strokeCuts: { c0: DesignPoint; c1: DesignPoint }[] = [];
  let lastClearedLine: ConsumedLine | null = null;
  const cancelPushed = new Set<number>();
  const boardFingers = new Set<number>();
  const pendingFly: {
    rec?: PhysBody;
    recKeep?: PhysBody;
    keep: THREE.Mesh;
    drop: THREE.Mesh;
    bladeDir: THREE.Vector3;
    hitPoint: THREE.Vector3;
    speedPx: number;
    squeeze: THREE.Vector3;
    keepRest: THREE.Vector3;
    dropRest: THREE.Vector3;
    freezeLeft: number;
    hit: number;
    dir: THREE.Vector3;
    finish: boolean;
    chord: { c0: DesignPoint; c1: DesignPoint };
  }[] = [];
  halt.fly = () => {
    pendingFly.length = 0;
  };
  const _squeezeN = new THREE.Vector3();
  const _zero = { x: 0, y: 0, z: 0 };
  let slowLeft = 0;

  const worldCentroid = (mesh: THREE.Mesh) => {
    const raw = mesh.userData.profile as { x: number; y: number }[] | undefined;
    const out = mesh.position.clone();
    if (!raw || raw.length < 3) return out;
    mesh.updateMatrixWorld(true);
    const e = mesh.matrixWorld.elements;
    let x = 0;
    let y = 0;
    for (const p of raw) {
      x += e[0] * p.x + e[4] * p.y + e[12];
      y += e[1] * p.x + e[5] * p.y + e[13];
    }
    out.x = x / raw.length;
    out.y = y / raw.length;
    return out;
  };

  const openCutGap = (a: THREE.Mesh, b: THREE.Mesh) => {
    const half = PAPER.cutGap * 0.5;
    const ca = worldCentroid(a);
    const cb = worldCentroid(b);
    _squeezeN.subVectors(cb, ca);
    _squeezeN.z = 0;
    if (_squeezeN.lengthSq() < 1e-8) return;
    _squeezeN.normalize();
    a.position.addScaledVector(_squeezeN, -half);
    b.position.addScaledVector(_squeezeN, half);
  };

  const replaceCut = (
    old: THREE.Mesh,
    a: THREE.Mesh,
    b: THREE.Mesh,
    finish: boolean,
  ): {
    keep: THREE.Mesh;
    drop: THREE.Mesh;
    rec?: PhysBody;
    recKeep?: PhysBody;
  } => {
    cucumberClip.hide();
    physics.removeMesh(old);
    old.removeFromParent();
    old.geometry.dispose();
    wood.forget(old);

    const keep = pieceVolume(a) >= pieceVolume(b) ? a : b;
    const drop = keep === a ? b : a;

    const mount = (mesh: THREE.Mesh, fly: boolean, cuttable: boolean) => {
      scene.add(mesh);
      prepareCuttable(mesh);
      if (fly) {
        const rec = physics.addMesh(mesh, 'convex');
        wood.track(mesh);
        return rec;
      }
      if (puzzle.canCut()) physics.addMesh(mesh, 'paper');
      else physics.addMesh(mesh, 'staticConvex');
      if (cuttable) wood.cuttables.push(mesh);
      wood.track(mesh);
      return undefined;
    };

    if (puzzle.canCut()) {
      mount(keep, false, true);
      mount(drop, false, true);
      return { keep, drop };
    }

    scene.add(keep);
    prepareCuttable(keep);
    let recKeep: PhysBody | undefined;
    if (finish) {
      recKeep = physics.addMesh(keep, 'convex');
      wood.track(keep);
    } else {
      physics.addMesh(keep, 'staticConvex');
      wood.cuttables.push(keep);
      wood.track(keep);
    }

    scene.add(drop);
    prepareCuttable(drop);
    const rec = physics.addMesh(drop, 'convex');
    wood.track(drop);

    return { keep, drop, rec, recKeep };
  };

  const pinBody = (
    rec: PhysBody,
    rest: THREE.Vector3,
  ) => {
    const b = rec.body;
    b.setGravityScale(0, true);
    b.setLinvel(_zero, true);
    b.setAngvel(_zero, true);
    b.setTranslation(rest, true);
  };

  const pinDrop = (p: (typeof pendingFly)[number]) => {
    if (p.rec) pinBody(p.rec, p.dropRest);
    if (p.recKeep) pinBody(p.recKeep, p.keepRest);
  };

  const releaseCut = (p: (typeof pendingFly)[number]) => {
    p.keep.position.copy(p.keepRest);
    p.drop.position.copy(p.dropRest);
    const burst = p.finish ? FX.burst * FINALE.burst : FX.burst;
    if (p.rec) {
      p.rec.body.setGravityScale(1, true);
      applyBladeImpulse(
        p.rec.body,
        camera,
        p.keep,
        p.drop,
        p.bladeDir,
        p.hitPoint,
        p.speedPx,
        burst,
      );
    }
    if (p.recKeep) {
      p.recKeep.body.setGravityScale(1, true);
      applyBladeImpulse(
        p.recKeep.body,
        camera,
        p.drop,
        p.keep,
        p.bladeDir,
        p.hitPoint,
        p.speedPx,
        burst,
      );
    }
    shake.hit(p.hit, p.dir, p.finish ? FINALE.kickMul : 1);
    if (p.finish) {
      slowLeft = 0;
      nextBoardIn = CUT.nextDelay;
    }
  };

  const applyCommit = (
    stroke: SlashStroke,
    seg: [DesignPoint, DesignPoint],
    dtSec: number,
    commit: {
      mesh: THREE.Mesh;
      c0: DesignPoint;
      c1: DesignPoint;
      enterEdge?: number;
    },
    commitFlash: boolean,
    crack: { c0: DesignPoint; c1: DesignPoint } | null,
  ): boolean => {
    camera.updateMatrixWorld(true);
    const result = cutMeshBySlash(commit.mesh, camera, commit.c0, commit.c1);
    if (!result) {
      report('碰到了但切开失败');
      lastMeshFail = { c0: commit.c0, c1: commit.c1 };
      if (!stroke.progress.has(commit.mesh.id)) {
        const dx = commit.c1.x - commit.c0.x;
        const dy = commit.c1.y - commit.c0.y;
        const len = Math.hypot(dx, dy) || 1;
        stroke.progress.set(commit.mesh.id, {
          c0: commit.c0,
          c1: commit.c1,
          chord: Math.hypot(
            commit.c1.x - commit.c0.x,
            commit.c1.y - commit.c0.y,
          ),
          inside: false,
          enterEdge: commit.enterEdge ?? -1,
          dirx: dx / len,
          diry: dy / len,
        });
      }
      return false;
    }
    stroke.slicedIds.add(commit.mesh.id);
    stroke.progress.clear();
    resetSlashIntent(stroke);
    const speedPx = Math.max(
      segmentSpeedPxPerSec(seg[0], seg[1], dtSec),
      80,
    );
    const volA = pieceVolume(result.a);
    const volB = pieceVolume(result.b);
    const dropVol = Math.min(volA, volB);
    const keepVol = Math.max(volA, volB);
    const originVol =
      Number(commit.mesh.userData.originVolume) || volA + volB;
    const puzzleCut = puzzle.canCut();
    const finish = puzzleCut
      ? false
      : keepVol < originVol * CUT.finishRemain;
    if (puzzleCut) puzzle.rememberCut(commit.mesh, result.a, result.b);
    if (puzzleCut) puzzle.forget(commit.mesh);
    if (puzzleCut) openCutGap(result.a, result.b);
    const pieces = replaceCut(commit.mesh, result.a, result.b, finish);
    const judged = puzzleCut ? puzzle.onCut(result.a, result.b) : 'ok';
    const hit = cutHit(speedPx, dropVol, keepVol);
    const freeze = finish
      ? FINALE.freeze
      : SHAKE.freezeMin + hit * (SHAKE.freezeMax - SHAKE.freezeMin);
    _squeezeN.subVectors(pieces.drop.position, pieces.keep.position);
    if (_squeezeN.lengthSq() < 1e-10) _squeezeN.copy(result.normal);
    _squeezeN.normalize();
    const sq = new THREE.Vector3();
    const keepRest = pieces.keep.position.clone();
    const dropRest = pieces.drop.position.clone();
    if (freeze > 1e-4) {
      sq.copy(_squeezeN).multiplyScalar(FX.squeeze * (0.45 + 0.55 * hit));
      pieces.keep.position.add(sq);
      pieces.drop.position.addScaledVector(sq, -1);
    }
    const pending = {
      rec: pieces.rec,
      recKeep: pieces.recKeep,
      keep: pieces.keep,
      drop: pieces.drop,
      bladeDir: result.bladeDir.clone(),
      hitPoint: result.hitPoint.clone(),
      speedPx,
      squeeze: sq,
      keepRest,
      dropRest,
      freezeLeft: freeze,
      hit,
      dir: result.bladeDir.clone(),
      finish,
      chord: { c0: commit.c0, c1: commit.c1 },
    };
    overlay.burstChips(commit.c0, commit.c1, hit);
    if (finish) {
      overlay.finaleFlash(commit.c0, commit.c1);
      if (freeze > 1e-4) slowLeft = freeze;
    } else overlay.impactFlash(hit);
    if (freeze <= 1e-4) {
      releaseCut(pending);
    } else {
      pinDrop(pending);
      pendingFly.push(pending);
    }
    lastCommit = { c0: commit.c0, c1: commit.c1 };
    beginFollow(
      stroke,
      commit.c0,
      commit.c1,
      pieces.keep.id,
      pieces.drop.id,
    );
    if (finish) enter = null;
    else if (puzzle.canCut()) {
      const stock = [pieces.keep, pieces.drop].find(
        (m) => m.userData.puzzleRole !== 'scrap',
      );
      if (stock && enter) enter.meshId = stock.id;
      else enter = null;
    } else if (enter) enter.meshId = pieces.keep.id;
    const crack2 =
      crackAlongStroke(
        wood.cuttables,
        camera,
        stroke,
        seg[1],
        seg[0],
      ) ?? crack;
    if (crack2) {
      inkFor(pieces.keep.userData.puzzleRole === 'stock' ? pieces.keep : pieces.drop);
      overlay.setCrack(crack2.c0, crack2.c1, stroke.pointerId);
    } else overlay.setCrack(null, undefined, stroke.pointerId);
    overlay.freezeFlash();
    if (!finish && commitFlash) {
      overlay.flash(commit.c0, commit.c1, false, stroke.pointerId);
    }
    hud.set(boardCutProgress(originVol, keepVol, finish));
    bladeHaptics.onCut(speedPx, finish);
    const sizeK = Math.min(1, (2 * dropVol) / Math.max(1e-12, dropVol + keepVol));
    gameAudio.crack({ speedPx, sizeK, finish });
    if (boardFingers.size <= 1) gameAudio.resetSlide();
    if (puzzle.canCut() && judged === 'submit') {
      submitAfterFly = true;
    }
    report(finish ? '完成切割' : '已切开');
    return true;
  };

  const uiRoot = document.getElementById('ui-root');
  const hud = uiRoot
    ? mountCutProgressHud(uiRoot)
    : { set: (_t: number) => {}, dispose: () => {} };
  uiRoot?.querySelector('.cut-progress')?.classList.add('is-hidden');
  const panel = { dispose: () => {} };

  let liveCutter: number | null = null;

  const skipMeshes = (except: SlashStroke): Set<number> => {
    const ids = new Set<number>();
    for (const s of input.strokes()) {
      if (s.pointerId === except.pointerId) continue;
      if (s.enterLock) ids.add(s.enterLock.meshId);
      for (const id of s.progress.keys()) ids.add(id);
    }
    return ids;
  };

  const cutterId = (): number | null => {
    const all = input.strokes();
    if (all.length === 0) {
      liveCutter = null;
      return null;
    }
    const alive = (id: number) => all.some((s) => s.pointerId === id);
    if (liveCutter != null && !alive(liveCutter)) liveCutter = null;
    if (liveCutter != null) {
      const cur = all.find((s) => s.pointerId === liveCutter);
      if (cur?.enterLock) return liveCutter;
      const othersArmed = all.some(
        (s) => s.pointerId !== liveCutter && s.armed,
      );
      if (cur && (cur.armed || !othersArmed)) return liveCutter;
      liveCutter = null;
    }
    const armed = all.filter((s) => s.armed);
    const pool = armed.length > 0 ? armed : all;
    let best = pool[0];
    let bestLen = strokePathLength(best.points);
    for (let i = 1; i < pool.length; i++) {
      const len = strokePathLength(pool[i].points);
      if (len > bestLen || (len === bestLen && pool[i].lastAt > best.lastAt)) {
        best = pool[i];
        bestLen = len;
      }
    }
    liveCutter = best.pointerId;
    return liveCutter;
  };

  const syncTrails = (active: SlashStroke) => {
    const id = cutterId();
    for (const s of input.strokes()) {
      if (s.pointerId !== id) overlay.endTrail(s.pointerId);
    }
    return id === active.pointerId;
  };

  const tone = (hex: number): [number, number, number] => {
    const k = FLASH.crackDarken;
    return [
      Math.round(((hex >> 16) & 255) * k),
      Math.round(((hex >> 8) & 255) * k),
      Math.round((hex & 255) * k),
    ];
  };

  const inkFor = (mesh: THREE.Mesh | undefined) => {
    if (!mesh || mesh.userData.puzzleRole !== 'stock') {
      overlay.setSheetInk(null);
      return;
    }
    overlay.setSheetInk((p) => {
      if (puzzle.level() === 'butterfly') return tone(BUTTERFLY.pink);
      if (puzzle.level() === 'fish') return tone(FISH.paper);
      const local = designToLocalXY(p, camera, mesh);
      const hex = local && localIsDark(local.y) ? TURTLE.dark : TURTLE.light;
      return tone(hex);
    });
  };

  const input = createSlashInput(stage, getLayout, {
    onStroke: (stroke) => {
      if (puzzle.phase() !== 'cut') return;
      if (stroke.points.length === 1) {
        if (syncTrails(stroke)) overlay.begin(stroke.pointerId);
        gameAudio.unlock();
        cancelPushed.delete(stroke.pointerId);
        boardFingers.delete(stroke.pointerId);
      }
    },
    onTip: (stroke, p) => {
      if (puzzle.phase() !== 'cut') return;
      if (syncTrails(stroke)) {
        overlay.ensureTrail(stroke.pointerId);
        overlay.push(stroke.pointerId, p);
      }
    },
    onPredicted: (stroke, points) => {
      if (syncTrails(stroke)) overlay.setPredicted(stroke.pointerId, points);
      else overlay.setPredicted(stroke.pointerId, []);
    },
    onMove: (stroke, lastSeg, dtSec) => {
      if (puzzle.phase() !== 'cut') return;
      if (!puzzle.canCut()) {
        boardFingers.delete(stroke.pointerId);
        return;
      }
      if (!syncTrails(stroke)) {
        boardFingers.delete(stroke.pointerId);
        return;
      }
      const followBefore = stroke.follow;
      const frame = stepSlashIntent(
        wood.cuttables.slice(),
        camera,
        stroke,
        lastSeg,
        skipMeshes(stroke),
        dtSec,
      );
      if (stroke.enterLock) {
        if (frame.scribble) {
          overlay.retractCrack(stroke.pointerId);
          if (!cancelPushed.has(stroke.pointerId)) {
            shake.pushIn();
            cancelPushed.add(stroke.pointerId);
          }
        } else {
          overlay.allowCrack(stroke.pointerId);
          cancelPushed.delete(stroke.pointerId);
          if (frame.crack) {
            const inkMesh =
              frame.meshId != null
                ? wood.cuttables.find((m) => m.id === frame.meshId)
                : wood.cuttables[0];
            inkFor(inkMesh);
            overlay.setCrack(frame.crack.c0, frame.crack.c1, stroke.pointerId);
          } else overlay.setCrack(null, undefined, stroke.pointerId);
        }
      }
      const onBoard =
        !frame.scribble &&
        !!frame.enter &&
        (frame.phase === 'track' || frame.phase === 'aimed' || !!frame.commit);
      if (onBoard) boardFingers.add(stroke.pointerId);
      else boardFingers.delete(stroke.pointerId);
      if (onBoard) {
        gameAudio.slideOnBoard(
          segmentSpeedPxPerSec(lastSeg[0], lastSeg[1], dtSec),
        );
      }
      let meshFailNow = false;
      if (frame.commit) {
        const ok = applyCommit(
          stroke,
          lastSeg,
          dtSec,
          frame.commit,
          frame.commitFlash,
          frame.crack,
        );
        if (!ok) {
          meshFailNow = true;
          if (boardFingers.size === 0) bladeHaptics.cancel();
        } else {
          strokeCuts.push({ c0: frame.commit.c0, c1: frame.commit.c1 });
        }
      } else {
        if (onBoard) bladeHaptics.onFrame(frame);
        else if (boardFingers.size === 0) bladeHaptics.cancel();
        if (frame.scribble) overlay.cancelFlash(stroke.pointerId);
        else if (frame.earlyFlash) {
          const chord = frame.crack ?? frame.cyan;
          if (chord) overlay.flash(chord.c0, chord.c1, true, stroke.pointerId);
        }
      }
      overlay.setPreview(null);
      if (followBefore && !stroke.follow) {
        lastClearedLine = followBefore;
      }
      const trackedMesh =
        frame.meshId != null
          ? wood.cuttables.find((m) => m.id === frame.meshId)
          : wood.cuttables[0];
      if (
        onBoard &&
        frame.enter &&
        trackedMesh &&
        isSolid3d(trackedMesh) &&
        !frame.commit &&
        !frame.scribble
      ) {
        cucumberClip.show(trackedMesh, camera, frame.enter, lastSeg[1]);
      } else {
        cucumberClip.hide();
      }
      const hull = trackedMesh
        ? projectMeshHull(trackedMesh, camera)?.hull ?? null
        : null;
      overlay.setIntentDebug({
        geom: frame.cyan,
        locked:
          frame.locked && stroke.intent.c0 && stroke.intent.c1
            ? { c0: stroke.intent.c0, c1: stroke.intent.c1 }
            : null,
        commit: lastCommit,
        stable: stroke.intent.stable,
        lockedFlag: frame.locked,
        phase: frame.phase,
        why: meshFailNow ? '剖分失败（剪影过了轮廓没切开）' : frame.why,
        hull,
        enter: stroke.enterLock?.c0 ?? frame.enter,
        enterEdge: frame.enterEdge,
        travel: frame.travelRatio,
        occupying: frame.phase === 'hold',
        consumed: stroke.follow ? [stroke.follow] : [],
        meshFail: lastMeshFail,
        cuts: strokeCuts,
        cleared: lastClearedLine,
        seg: { c0: lastSeg[0], c1: lastSeg[1] },
      });
    },
    onEnd: (stroke) => {
      cucumberClip.hide();
      if (stroke) {
        boardFingers.delete(stroke.pointerId);
        cancelPushed.delete(stroke.pointerId);
        overlay.setPredicted(stroke.pointerId, []);
        overlay.end(stroke.pointerId);
      }
      if (boardFingers.size === 0) {
        gameAudio.resetSlide();
        bladeHaptics.cancel();
      }
      if (stroke && stroke.slicedIds.size === 0 && input.strokes().length === 0) {
        report('划过但未贯穿木板');
      }
    },
  });

  const paperShadows = new Map<THREE.Mesh, THREE.Mesh>();
  const paperShadowMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: PAPER.shadowOpacity,
    depthWrite: false,
    toneMapped: false,
  });
  const syncPaperShadows = () => {
    const live = new Set<THREE.Mesh>();
    for (const mesh of wood.cuttables) {
      if (mesh.userData.puzzleRole !== 'stock') continue;
      live.add(mesh);
      mesh.castShadow = false;
      let shadow = paperShadows.get(mesh);
      if (!shadow) {
        shadow = new THREE.Mesh(mesh.geometry, paperShadowMat);
        shadow.frustumCulled = false;
        shadow.renderOrder = 1;
        scene.add(shadow);
        paperShadows.set(mesh, shadow);
      }
      shadow.geometry = mesh.geometry;
      const onBook = puzzle.phase() === 'carry'
        || puzzle.phase() === 'place'
        || puzzle.phase() === 'inspect'
        || puzzle.phase() === 'score';
      const ox = onBook ? PAPER.shadowX * 0.4 : PAPER.shadowX;
      const oy = onBook ? PAPER.shadowY * 0.4 : PAPER.shadowY;
      shadow.position.set(
        mesh.position.x + ox,
        mesh.position.y + oy,
        mesh.position.z - (onBook ? 0.006 : 0.02),
      );
      shadow.renderOrder = onBook ? 5 : 1;
      shadow.quaternion.copy(mesh.quaternion);
      shadow.scale.copy(mesh.scale);
      shadow.visible = mesh.visible;
    }
    for (const [mesh, shadow] of paperShadows) {
      if (live.has(mesh)) continue;
      shadow.removeFromParent();
      paperShadows.delete(mesh);
    }
  };

  return {
    step: (dt) => {
      puzzle.step(dt);
      if (submitAfterFly && pendingFly.length === 0) {
        submitAfterFly = false;
        puzzle.requestInstall();
      }
      overlay.step();
      for (let i = pendingFly.length - 1; i >= 0; i--) {
        const p = pendingFly[i];
        p.freezeLeft -= dt;
        if (p.freezeLeft > 0) pinDrop(p);
        else {
          pendingFly.splice(i, 1);
          releaseCut(p);
        }
      }
      const slowing = slowLeft > 0;
      if (slowing) slowLeft = Math.max(0, slowLeft - dt);
      if (enter && CUT.enterDur > 1e-4 && pendingFly.length === 0) {
        enter.t = Math.min(1, enter.t + dt / CUT.enterDur);
        const u = 1 - (1 - enter.t) ** 3;
        const y = enter.from + (enter.to - enter.from) * u;
        for (const mesh of wood.cuttables) {
          if (enter.meshId != null && mesh.id !== enter.meshId) continue;
          const rec = physics.bodies.find((b) => b.mesh === mesh);
          if (!rec) continue;
          const t = rec.body.translation();
          rec.body.setTranslation({ x: t.x, y, z: t.z }, true);
        }
        if (enter.t >= 1) enter = null;
      }
      physics.step(slowing ? dt * FINALE.scale : dt);
      const liveStroke = input
        .strokes()
        .find((s) => s.enterLock && s.points.length >= 2);
      if (liveStroke) {
        const tip = liveStroke.points[liveStroke.points.length - 1];
        const from = liveStroke.points[liveStroke.points.length - 2];
        const crack = crackAlongStroke(
          wood.cuttables,
          camera,
          liveStroke,
          tip,
          from,
        );
        if (crack) {
          const tracked = [...liveStroke.progress.keys()][0];
          const inkMesh =
            (tracked != null
              ? wood.cuttables.find((m) => m.id === tracked)
              : undefined) ??
            wood.cuttables.find((m) => !liveStroke.slicedIds.has(m.id));
          inkFor(inkMesh);
          overlay.setCrack(crack.c0, crack.c1, liveStroke.pointerId);
        } else overlay.setCrack(null, undefined, liveStroke.pointerId);
      } else {
        overlay.setCrack(null);
      }
      for (const p of pendingFly) {
        p.keep.position.copy(p.keepRest).add(p.squeeze);
        p.drop.position.copy(p.dropRest).addScaledVector(p.squeeze, -1);
      }
      syncPaperShadows();
      shake.step(dt);
      if (nextBoardIn >= 0 && !puzzle.canCut() && puzzle.phase() !== 'show') {
        nextBoardIn -= dt;
        if (nextBoardIn <= 0) {
          nextBoardIn = -1;
          wood.spawn(true);
          beginEnter();
          hud.set(0);
          report('下一块');
        }
      }
    },
    applyView: () => shake.applyView(),
    restoreView: () => shake.restoreView(),
    dispose: () => {
      for (const shadow of paperShadows.values()) shadow.removeFromParent();
      paperShadows.clear();
      paperShadowMat.dispose();
      gameAudio.dispose();
      bladeHaptics.cancel();
      input.dispose();
      panel.dispose();
      hud.dispose();
      overlay.canvas.remove();
      cucumberClip.dispose();
      puzzle.dispose();
      wood.dispose();
      physics.dispose();
    },
  };
}
