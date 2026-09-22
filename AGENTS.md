# AGENTS.md — Islash Cut

> **打开本仓库时的第一入口。**  
> 壳：portrait-webgpu-base（niantu 适配 + three-webgpu-cap-shell 打包）。  
> 玩法：切割拼图（`src/game/cutPuzzle.ts`）。刀法仍是练习场 A–B。

## 一句话

**TypeScript + Three.js WebGPU + Vite + Capacitor iOS** 竖屏。  
设计空间 **390×844** contain letterbox；`base: './'`。  
当前玩法：用关卡给的一张料，把指定零件裁出来装进完成图案（准了爽，不准也好看；都能过关）。规范：[docs/CUT-PUZZLE.md](docs/CUT-PUZZLE.md)。第一关蝴蝶，第二关乌龟。不限刀。  
滑动=刀。拼贴关不限刀数，切开的都留下、都能再切；指定轮廓齐了才从下方点按钮自动装。刀法细则 [docs/SLASH-INTENT.md](docs/SLASH-INTENT.md)；玩法 [docs/CUT-PUZZLE.md](docs/CUT-PUZZLE.md)。

## 入口地图

| 职责 | 文件 |
|------|------|
| Web 启动 | `index.html` → `src/main.ts` |
| 设计舞台 | `src/adapt/design.ts` |
| 设备预览 | `src/adapt/devicePreview.ts` |
| Safe Area | `src/adapt/safeArea.ts` + `src/style.css` |
| WebGPU | `src/create-renderer.ts` |
| 震动 JS | `src/utils/haptics.ts` |
| 震动 Swift 真源 | `plugins/native-haptics/*` |
| 震动怎么接 | `docs/HAPTICS.md` **§0 正确接入** |
| Capacitor | `capacitor.config.ts`（`contentInset: never`） |
| 构建 | `vite.config.ts`（**`base: './'`**） |
| iOS 注入 | `scripts/bootstrap-ios.mjs` |
| 音效 | `src/audio/gameAudio.ts`（`SFX`；方案 [docs/AUDIO.md](docs/AUDIO.md)） |
| 划切规范 | `docs/SLASH-DESIGN.md`（参数 `src/game/design.ts`） |
| 打击感 | `docs/SLASH-FEEL.md`（`SHAKE` `FX` `TRAIL`；`screenShake.ts`；划痕 `slashTrail.ts`） |
| 意图识别 | `docs/SLASH-INTENT.md`（`slashIntent.ts`；余势 `slashFollow.ts`） |
| 关卡背景 + 投影 | `src/game/backdrop.ts`（浅蓝纯色，不用道场贴图） |
| 灯光 | `src/game/lights.ts`（参数 `LIGHT`） |
| 进度条 | `src/game/cutProgressHud.ts`（拼图关已隐藏） |
| 划切调研 | `docs/SLASH-RESEARCH.md` |
| 连续切技术 | `docs/SLASH-TECH.md` |
| 切割拼图（当前玩法） | [docs/CUT-PUZZLE.md](docs/CUT-PUZZLE.md) · `cutPuzzle.ts` · `PUZZLE` |
| 圆柱 3D 切（管线） | [docs/CYLINDER-CUT.md](docs/CYLINDER-CUT.md)（拼图关未用图库圆柱） |

## DOM（勿拆）

```
#shell > #viewport > #app > #stage
  canvas          ← WebGPU
  #ui-root        ← 所有游戏 UI（safe padding）
#device-switcher  ← 仅桌面预览例外
```

## 硬性约定

1. **`vite` `base: './'`** — Capacitor 禁止绝对 `/assets/`  
2. **`webDir: dist`** 与 Vite `outDir` 一致  
3. **`ios.contentInset: never`** — Safe Area 只走 CSS  
4. **布局坐标 390×844**；禁止 `renderer.setSize(window.innerWidth,…)`  
5. **UI 只挂 `#ui-root`**；禁止玩法 UI `position: fixed` 贴浏览器窗  
6. **Pad 只改外层视口**，不改 `DESIGN_*`  
7. **改 Swift 改 `plugins/native-haptics/`** 再 `ios:bootstrap`；震动接线见 `docs/HAPTICS.md`。Capacitor 8 的 `SceneDelegate` 必须 `rootViewController = BridgeViewController()`（默认 `CAPBridgeViewController` 不会注册插件）。不要用 JS `prepare()` 判断是否接上；真机 HUD 看 `plugin: true` + 点「点我震动」。  
8. **无 WebGPU 则明确失败**，不静默 WebGL  
9. **玩法参数只改 `src/game/design.ts`**。拼图关不挂调试面板。砍飞必须质量归一（`J = mass * Δv`），禁止固定冲量打所有块。顿帧只冻**本刀新块**；震屏只渲染前偏相机。  
10. **木板切开只切 2D 轮廓再竖直挤出 + 半平面内收倒角**（`userData.profile`）。块要封口。禁止锥台、禁止用 3D CSG/剖分去切倒角木板、禁止整块缩小 inset。细则：[docs/SLASH-DESIGN.md](docs/SLASH-DESIGN.md)「几何」。圆柱等回转体另走 3D 平面剖（[docs/CYLINDER-CUT.md](docs/CYLINDER-CUT.md)），不要缩短网格冒充。  
11. **iOS**：`appId` = `com.wangzhixuan.islash.cut`，显示名 Islash Cut；真机不要 Simulator。  

## 命令

```bash
npm install
npm run dev           # http://127.0.0.1:5200/
npm run build
npm run cap:sync      # 网页改动同步 iOS
npm run ios:bootstrap # 首次 / 修 Swift 插件
npm run ios           # build + sync + 开 Xcode
```

查询参数：`?preview=0|1` · `?debugFit=1`  
调试安全区：`document.body.classList.add('debug-safe-area')`

## 业务怎么加

- 玩法循环：[docs/CUT-PUZZLE.md](docs/CUT-PUZZLE.md)；刀：[docs/SLASH-DESIGN.md](docs/SLASH-DESIGN.md) + [docs/SLASH-INTENT.md](docs/SLASH-INTENT.md)；打击感：[docs/SLASH-FEEL.md](docs/SLASH-FEEL.md)（入板锁 A、出板清、板心不锁；帮助指出 B；乱划 1.5 倍钉死到出板；余势拦弧线，短距离尖角才第二刀；有效刀钉到抬起）  
- 保留：adapt / create-renderer / haptics / plugins / `base`  
- 触控：整屏走刀，只对料判切；可同时按下最多 3 指，**有效刀只有一把**。指定零件轮廓齐了，下方出「装上」，点了才自动装。按钮样子仍可再改。  
- UI：只挂 `#ui-root`；进度条 / 调试面板不显示。画面是轻松浅蓝纯色，见 [docs/CUT-PUZZLE.md](docs/CUT-PUZZLE.md)。  
- 音效：`src/audio/gameAudio.ts` + `docs/AUDIO.md`；禁止热路径 `new Audio()` / 每发一次桥  

## 刻意不做

- 不要默默接回图库轮换 / 完成切割换板。关卡顺序是蝴蝶，然后乌龟  
- 连击 / 其它手势族  
- 伪造「重侧下垂」力矩  
- 整板锥台、3D CSG 切倒角网格  
- Android（可后加）  
- WebGL 静默回退  
