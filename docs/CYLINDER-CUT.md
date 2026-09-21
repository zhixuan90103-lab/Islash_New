# 圆柱切割

> **已落地（图库第四块）。** 意图仍是 A–B 贯穿（[SLASH-INTENT.md](./SLASH-INTENT.md)）。  
> 木板几何仍只切 2D 轮廓（[SLASH-DESIGN.md](./SLASH-DESIGN.md)）。圆柱是**第二条固体管线**，禁止拿来剖倒角木板，禁止缩短 `CylinderGeometry` 冒充切开。

当前关卡循环见 [CUT-PUZZLE.md](./CUT-PUZZLE.md)（方板拼图，不用圆柱）。本文是图库圆柱 3D 剖，拼图关未启用。

## 黄瓜预览（进行中）

锁定 A 之后、尚未贯穿：用 `ClippingGroup` 按刀面裁掉已划过的一侧，刀面上贴黄瓜圆切面（皮圈 + 瓤 + 籽）。贯穿成功再 `clipMeshByPlane` 真剖。纵切（刀面几乎平行长轴）不贴圆片，只裁。背景不改。入口：`src/game/cucumberClip.ts`。

## 一句话

圆柱是沿 Y 的真圆管。刀面立着朝玩家切开，两块都封切面（瓤），大留小飞、重力、冲量和木板同一套。

## 为什么不能走木板那刀

木板：剪 XY 凸轮廓，Z 厚不变。切完是两块「同一厚度的板」。  
圆柱圆片 / 斜切椭圆面：刀面截的是 **3D 立体**。用挤出板或「高度变短的 CylinderGeometry」看起来像缩放，切面还会漏。

## 规范

| 项 | 锁定 |
|----|------|
| 网格 | `CylinderGeometry`，轴沿 Y，侧面朝相机。不要把胶囊往 Z 挤成厚板。 |
| 刀面 | `Cross(刀向, 相机朝向)`，过 A–B 中点。与木板同一意图。 |
| 剖分 | `src/game/solid3d.ts` `clipMeshByPlane`：三角分到两侧，交点焊到刀面，切面用**平面凸包**封口。 |
| 材质 | 外皮 `CYL.faceColor`（可带木纹），切面 `CYL.fleshColor`，双面。`userData.kind = 'solid3d'`。 |
| 下一刀 | 剖完用网格 XY 凸包当 `profile`，深度取 Z 跨度。A–B 仍对剪影。 |
| 体积 | 封闭网格有向体积（`pieceVolume`），大留小飞、1/10 完成切割。 |
| 物理 | 小块 `convex` + 重力 + 刀向冲量，与木板相同。 |
| 不要 | 缩短圆柱冒充切；切完把圆片转到朝相机；three-pinata（切面常缺）；3D 剖木板倒角。 |

斜切切面是椭圆，横切是圆。圆片先立在原朝向，飞转后才看见圆面——不要当场改朝向。

## 参数

`src/game/design.ts` `CYL`：`radius` `length` `faceColor` `fleshColor` `uvScale`。  
`coinSpan` 是旧「薄块改圆片」残留，**3D 剖分不再用它决定网格**。

## 入口

| 文件 | 职责 |
|------|------|
| `solid3d.ts` | 圆柱网格、平面剖、封切面、`sliceSolid3d` |
| `slashCut.ts` | `kind===solid3d` 走 3D，否则 2D profile |
| `wood.ts` | 图库第四块 `createSolidCylinderMesh` |
| `bladeForce.ts` | solid3d 体积 |

## 废弃

- 挤出胶囊当圆柱  
- `CylinderGeometry(r, 新长度)` 当切开  
- 薄块建成朝相机的圆片  
- three-pinata 剖圆柱  

检索过程里的弯路只保留这一节，细节不再当规范。
