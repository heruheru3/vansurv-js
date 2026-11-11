'use strict';
/* ステージ抽象化モジュール (stage.js)
役割: ステージ（タイルマップ）に関する全てをこのクラスの裏側に隠す。
元コード対応: ui/stage.py の StageMap + map/map_loader.py の MapLoader。


ステージは当面 provisional（暫定）で、将来拡張・差し替え予定。
そのためエンジン側（game.js / player.js / enemies.js / weapons.js）は
この Stage クラスの API だけを使うこと。新しいステージを足す場合は
「CSV（または生成ロジック）＋ TILE_SEMANTICS への行追加」で済むようにし、
エンジン側のコードは変更しない。

公開API:
Stage.fromCSV(csvText) … CSVテキストからステージを構築
stage.tileAt(worldX, worldY) … ワールド座標のタイルID
stage.isObstacleAt(x, y) … 移動体（プレイヤー/敵）が進入不可か
stage.isWeaponBlockedAt(x, y, weaponKey)
… 武器が不可侵領域で止まるか（簡易版。下記参照）
stage.isPositionSafe(x, y, size) / findSafeSpawnPosition(x, y, size)
stage.buildGraphics() … 描画用PIXIオブジェクト（チャンク分割済み）を返す


原作はタイル5,9（SOLID）で stone/knife/axe/magic_wand を止め、6,7は貫通させる。
今回はこの判定自体は実装した（isWeaponBlockedAt）が、ステージ暫定のため
「次の移動先1点だけを見る」簡易判定であり、原作の軌道サンプリング等は行わない。
詳細は STATUS.md の既知の差異を参照。 */

/* タイル意味テーブル: タイルID -> { color, border, obstacle, weaponSolid}
新タイルを増やすときはここに行を足す。
- obstacle: 移動体が進入できない（原作 ui/stage.py: [5,7,8,9]）
- weaponSolid: 対象武器をブロックする（原作 constants: BLOCKER_AREAS_SOLID {5,9}）
- 6,7 は原作 BLOCKER_AREAS_PASSTHROUGH（武器は貫通）。weaponSolid=false で表現。 */
const TILE_SEMANTICS = {
0: { color: 0x242424, obstacle: false, weaponSolid: false}, // MOREDARK_GRAY
1: { color: 0x303030, obstacle: false, weaponSolid: false}, // DARK_GRAY
2: { color: 0x808080, obstacle: false, weaponSolid: false}, // GRAY
3: { color: 0xc0c0c0, obstacle: false, weaponSolid: false}, // LIGHT_GRAY
4: { color: 0x402010, obstacle: false, weaponSolid: false}, // 土
5: { color: 0x204020, border: 0x102010, obstacle: true, weaponSolid: true}, // 森
6: { color: 0x404020, obstacle: false, weaponSolid: false}, // 道（武器貫通）
7: { color: 0x202040, border: 0x101020, obstacle: true, weaponSolid: false}, // 水（移動不可・武器貫通）
8: { color: 0x401010, border: 0x200808, obstacle: true, weaponSolid: false}, // 危険地帯
9: { color: 0x303030, border: 0x181818, obstacle: true, weaponSolid: true}, // 石/岩
};
const TILE_SEMANTICS_DEFAULT = { color: 0x242424, obstacle: false, weaponSolid: false};

class Stage {
constructor(tiles) {
this.tiles = tiles; // tiles[y][x] = タイルID(int)
this.height = tiles.length;
this.width = tiles.length? tiles[0].length: 0;
this.tileSize = C.TILE_SIZE;
}

/* CSVテキスト（行=タイル行、カンマ区切り整数）から構築する */
static fromCSV(csvText) {
const tiles = parseCSV(csvText).map(row => {
// 元CSVは行末カンマで空セルが付くため、末尾の空セルは落とす
const cells = (row.length > 1 && row[row.length - 1] === '') ? row.slice(0, -1) : row;
return cells.map(v => {
const n = parseInt(v, 10);
return Number.isNaN(n) ? 0 : n;
});
});
return new Stage(tiles);
}

semantics(tileId) { return TILE_SEMANTICS[tileId] || TILE_SEMANTICS_DEFAULT;}

tileAt(worldX, worldY) {
const tx = Math.floor(worldX / this.tileSize);
const ty = Math.floor(worldY / this.tileSize);
if (ty < 0 || ty >= this.height || tx < 0 || tx >= this.width) return 0; // 範囲外は0（原作仕様）
return this.tiles[ty][tx];
}

isObstacleAt(worldX, worldY) {
return this.semantics(this.tileAt(worldX, worldY)).obstacle === true;
}

/* 武器ブロック判定（簡易版）: 対象武器のみ、weaponSolidタイルで止まる */
isWeaponBlockedAt(worldX, worldY, weaponKey) {
if (!C.WEAPONS_AFFECTED_BY_BLOCKERS.includes(weaponKey)) return false;
return this.semantics(this.tileAt(worldX, worldY)).weaponSolid === true;
}

/* 中心(x,y)・一辺entitySizeの四隅が全て障害物でなければ安全 */
isPositionSafe(worldX, worldY, entitySize) {
const h = Math.floor(entitySize / 2);
return!this.cornersBlocked(worldX, worldY, h);
}
cornersBlocked(x, y, h) {
return this.isObstacleAt(x - h, y - h) || this.isObstacleAt(x + h, y - h) ||
this.isObstacleAt(x - h, y + h) || this.isObstacleAt(x + h, y + h);
}

/* ui/stage.py findSafeSpawnPosition の移植（4方向直線探索→粗い全探索） */
findSafeSpawnPosition(preferredX, preferredY, entitySize) {
if (this.isPositionSafe(preferredX, preferredY, entitySize)) return [preferredX, preferredY];
const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
for (let radius = 1; radius <= 5; radius++) {
for (const [dx, dy] of dirs) {
const tx = preferredX + radius * this.tileSize * dx;
const ty = preferredY + radius * this.tileSize * dy;
if (entitySize <= tx && tx <= C.WORLD_WIDTH - entitySize &&
entitySize <= ty && ty <= C.WORLD_HEIGHT - entitySize &&
this.isPositionSafe(tx, ty, entitySize)) return [tx, ty];
}
}
const step = this.tileSize * 2;
for (let y = entitySize; y < C.WORLD_HEIGHT - entitySize; y += step) {
for (let x = entitySize; x < C.WORLD_WIDTH - entitySize; x += step) {
if (this.isPositionSafe(x, y, entitySize)) return [x, y];
}
}
return [preferredX, preferredY];
}

/* 描画: 16x16タイル単位のチャンクに分け、テクスチャ化して返す。
ワールド全体を1枚絵にしないので、将来ステージが大きくなっても差し替え可能。 */
/* 描画: チャンク（16×16タイル）ごとに Canvas へドット絵チップを描き、
   テクスチャ化して Sprite を返す。チップは隣接タイルを見て岸辺・縁が
   つながるよう描く（js/mapchips.js）。Canvas が使えない環境では
   従来のベタ塗り（Graphics→テクスチャ）にフォールバックする。 */
buildGraphics(renderer) {
const container = new PIXI.Container();
const CH = 16; // チャンクの一辺（タイル数）
const idAt = (x, y) => (x < 0 || y < 0 || x >= this.width || y >= this.height) ? -1 : this.tiles[y][x];
const useChips = typeof document !== 'undefined' && typeof MapChips !== 'undefined';
for (let cy = 0; cy < this.height; cy += CH) {
for (let cx = 0; cx < this.width; cx += CH) {
const wTiles = Math.min(CH, this.width - cx);
const hTiles = Math.min(CH, this.height - cy);
let tex = null;
if (useChips) {
try {
const canvas = document.createElement('canvas');
canvas.width = wTiles * this.tileSize;
canvas.height = hTiles * this.tileSize;
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;
for (let ty = 0; ty < hTiles; ty++) {
for (let tx = 0; tx < wTiles; tx++) {
MapChips.paintTile(ctx, tx * this.tileSize, ty * this.tileSize, idAt, cx + tx, cy + ty);
}
}
tex = PIXI.Texture.from(canvas);
tex.baseTexture.scaleMode = PIXI.SCALE_MODES.NEAREST;
} catch (e) { tex = null; }
}
if (!tex) { // フォールバック: ベタ塗り
const g = new PIXI.Graphics();
for (let ty = 0; ty < hTiles; ty++) {
for (let tx = 0; tx < wTiles; tx++) {
const sem = this.semantics(this.tiles[cy + ty][cx + tx]);
const px = tx * this.tileSize, py = ty * this.tileSize;
g.beginFill(sem.color);
g.drawRect(px, py, this.tileSize, this.tileSize);
g.endFill();
if (sem.border!== undefined) {
g.lineStyle(4, sem.border, 1);
g.drawRect(px + 2, py + 2, this.tileSize - 4, this.tileSize - 4);
g.lineStyle(0);
}
}
}
tex = renderer.generateTexture(g, { region: new PIXI.Rectangle(0, 0, wTiles * this.tileSize, hTiles * this.tileSize)});
g.destroy();
}
const spr = new PIXI.Sprite(tex);
spr.position.set(cx * this.tileSize, cy * this.tileSize);
container.addChild(spr);
}
}
return container;
}
}
if (typeof module!== 'undefined') module.exports = { Stage, TILE_SEMANTICS};
