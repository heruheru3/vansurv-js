'use strict';
/* 敵モジュール (enemies.js)
元コード対応: core/enemy.py の Enemy / EnemyProjectile、
core/game_logic.py の spawn_enemies（出現タイミング）、
core/enemy_spawn_manager.py の出現ルール適用。


- 新しい敵（ステータス違い）: data/enemy_stats.csv に行を足すだけ。
- 新しい行動パターン: BEHAVIORS に1エントリ足し、CSVの type にその番号を使う。
- ボス: data/boss_stats.csv に行を足すだけ（type 101〜104が行動1〜4に対応）。 */

/* HSV→RGB（core/enemy.py _hsv_to_rgb の移植。色はパーティクル等に使う） */
function hsvToRgbInt(hueDeg, saturation, value255) {
const h = (((hueDeg % 360) + 360) % 360) / 360;
const s = saturation, v = value255 / 255;
const i = Math.floor(h * 6), f = h * 6 - i;
const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
let r, g, b;
switch (i % 6) {
case 0: r = v; g = t; b = p; break;
case 1: r = q; g = v; b = p; break;
case 2: r = p; g = v; b = t; break;
case 3: r = p; g = q; b = v; break;
case 4: r = t; g = p; b = v; break;
default: r = v; g = p; b = q; break;
}
return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}
/* 行動タイプ別の色（enemy.py: 1=赤,2=青,3=緑,4=橙。彩度はタイプで決まる） */
function enemyColor(behaviorType) {
const saturation = 0.2 + (behaviorType - 1) * 0.2;
const hue = { 1: 0, 2: 240, 3: 120, 4: 30}[behaviorType] || 240;
return hsvToRgbInt(hue, saturation, 200);
}

/* 敵弾の色（原作 _setup_bullet_color: 色相は行動タイプ、彩度は敵レベルで上昇） */
function bulletColor(behaviorType, enemyLevel) {
const saturation = 0.2 + (Math.max(1, enemyLevel) - 1) * 0.2;
const hue = { 1: 0, 2: 240, 3: 120, 4: 30 }[behaviorType] || 240;
return hsvToRgbInt(hue, Math.min(1, saturation), 200);
}

/* ---------------- 行動パターンレジストリ ----------------
各振る舞いは「移動先候補 [nx, ny]」を返す。障害物・敵同士の衝突解決は
Enemy.move() の共通処理が行うので、振る舞い側は行き先だけ決めればよい。
shoots=true のタイプは update_attack で弾を撃つ。 */
const BEHAVIORS = {
1: { // 追跡: プレイヤーへ直進
shoots: false,
move(e, p, dtF) {
const a = Math.atan2(p.y - e.y, p.x - e.x);
return [e.x + Math.cos(a) * e.baseSpeed * dtF, e.y + Math.sin(a) * e.baseSpeed * dtF];
},
},
2: { // 直進: 最初に決めた方向へ進み続ける（跳ね返りなし）
shoots: false,
move(e, p, dtF) {
if (e.initialDirection === null || e.noclipMode) {
e.initialDirection = Math.atan2(p.y - e.y, p.x - e.x);
e.velocityX = Math.cos(e.initialDirection) * e.baseSpeed;
e.velocityY = Math.sin(e.initialDirection) * e.baseSpeed;
}
return [e.x + e.velocityX * dtF, e.y + e.velocityY * dtF];
},
},
3: { // 距離保持＋射撃: 目標距離200±20を保つ
shoots: true,
move(e, p, dtF) {
const d = Math.hypot(p.x - e.x, p.y - e.y);
if (d < e.targetDistance - 20) {
const a = Math.atan2(e.y - p.y, e.x - p.x);
return [e.x + Math.cos(a) * e.baseSpeed * dtF, e.y + Math.sin(a) * e.baseSpeed * dtF];
} else if (d > e.targetDistance + 20) {
const a = Math.atan2(p.y - e.y, p.x - e.x);
return [e.x + Math.cos(a) * e.baseSpeed * dtF, e.y + Math.sin(a) * e.baseSpeed * dtF];
}
return [e.x, e.y];
},
},
4: { // 追跡＋射撃: 近づきながら撃つ
shoots: true,
move(e, p, dtF) {
const a = Math.atan2(p.y - e.y, p.x - e.x);
return [e.x + Math.cos(a) * e.baseSpeed * dtF, e.y + Math.sin(a) * e.baseSpeed * dtF];
},
},
};

/* ---------------- 敵本体 ---------------- */
let ENEMY_UID = 1;
class Enemy {
/* stat: GameData.enemyStats の1行。opts: { spawnX, spawnY, strengthMultiplier, sizeMultiplier} */
constructor(stat, opts = {}) {
this.uid = ENEMY_UID++;
this.isBoss = false;
this.enemyNo = stat.enemy_no;
this.behaviorType = stat.type;
this.level = stat.level;
this.hp = stat.base_hp;
this.maxHp = stat.base_hp;
this.baseSpeed = stat.base_speed * stat.speed_multiplier;
this.damage = stat.base_damage;
this.attackCooldown = stat.attack_cooldown;
this.projectileSpeed = stat.projectile_speed;
this.imageFile = stat.image_file;
this.imageSize = stat.image_size;
this.size = Math.floor(stat.image_size * 0.7); // 当たり判定は画像の70%（原作仕様）
this.color = enemyColor(this.behaviorType);
this._initCommon(opts);
// 出現ルールの倍率（game_logic / spawn_manager の適用順を再現）
if (this.strengthMultiplier!== 1.0) {
this.hp = Math.floor(this.hp * this.strengthMultiplier);
this.maxHp = Math.floor(this.maxHp * this.strengthMultiplier);
this.damage = Math.floor(this.damage * this.strengthMultiplier);
}
if (this.sizeMultiplier!== 1.0) {
this.size = Math.floor(this.size * this.sizeMultiplier);
this.imageSize = Math.floor(this.imageSize * this.sizeMultiplier);
}
}

/* ボス生成（boss_stats.csv の1行から）。行動は type-100、色は金、画像はボス用 */
static fromBossStat(stat, x, y) {
const e = Object.create(Enemy.prototype);
e.uid = ENEMY_UID++;
e.isBoss = true;
e.bossNo = stat.no;
e.enemyNo = null;
e.behaviorType = stat.type - 100;
e.level = 1;
e.hp = stat.base_hp;
e.maxHp = stat.base_hp;
e.baseSpeed = stat.base_speed * stat.speed_multiplier;
e.damage = stat.base_damage;
e.attackCooldown = stat.attack_cooldown;
e.projectileSpeed = stat.projectile_speed;
e.imageFile = stat.image_file;
e.imageSize = stat.image_size;
e.size = Math.floor(stat.image_size * 0.7);
e.color = 0xffd700;
e._initCommon({ spawnX: x, spawnY: y});
return e;
}

_initCommon(opts) {
this.x = opts.spawnX || 0;
this.y = opts.spawnY || 0;
this.strengthMultiplier = opts.strengthMultiplier || 1.0;
this.sizeMultiplier = opts.sizeMultiplier || 1.0;
this.targetDistance = 200;
this.initialDirection = null;
this.velocityX = 0; this.velocityY = 0;
this.projectiles = [];
this.deadProjectiles = []; // 消滅した弾（描画側でスプライト解放待ち）
this.lastAttackMs = 0;
// ノックバック（enemy.py apply_knockback / update_knockback）
this.knockbackVx = 0; this.knockbackVy = 0;
this.knockbackTimer = 0; this.knockbackCooldown = 0;
// 地形ハマり検出→noclip（enemy.py: 3秒動けなければ1秒間地形無視）
this.stuckTimer = 0; this.noclipMode = false; this.noclipTimer = 0;
// アニメーション・表示
this.animationTime = 0; this.isMoving = false; this.facingRight = true;
this.hitFlashTimer = 0; this.hitFlashDuration = 0.25;
this.sprite = null; this.hpBar = null;
}

onHit() { this.hitFlashTimer = this.hitFlashDuration;}

/* ノックバック適用（力を1.5倍して速度化する原作式）。クールダウン中は無効 */
applyKnockback(fromX, fromY, force) {
if (this.knockbackCooldown > 0) return;
let dx = this.x - fromX, dy = this.y - fromY;
let d = Math.hypot(dx, dy);
if (d === 0) { dx = 1; dy = 0; d = 1;}
const f = force * 1.5;
this.knockbackVx = (dx / d) * f;
this.knockbackVy = (dy / d) * f;
this.knockbackTimer = C.KNOCKBACK_DURATION;
}

/* 移動の共通解決: 障害物（軸分離スライド）と敵同士の重なり回避。
ENABLE_ENEMY_SEPARATION=false の原作では「押しのけ」は行われないが、
移動先で他敵と重なる場合は軸分離で止まるフォールバックが常時働く。
敵同士の判定は game.enemyGrid（空間グリッド）を使う。 */
_tryMove(game, nx, ny) {
const stage = game.stage;
const h = Math.floor(this.size / 2);
const blockedByEnemy = (px, py) => {
if (this.noclipMode) return false; // ハマり脱出中は敵同士の重なりも無視する（重なったまま固まる個体の救済）
const cell = 64;
const cx = Math.floor(px / cell), cy = Math.floor(py / cell);
for (let gy = cy - 1; gy <= cy + 1; gy++) {
for (let gx = cx - 1; gx <= cx + 1; gx++) {
const list = game.enemyGrid.get(gx + ',' + gy);
if (!list) continue;
for (const o of list) {
if (o === this) continue;
const minDist = (this.size + o.size) * C.ENEMY_COLLISION_SEPARATION_FACTOR;
const dx = px - o.x, dy = py - o.y;
if (dx * dx + dy * dy < minDist * minDist) return true;
}
}
}
return false;
};
const terrainOk = (px, py) => this.noclipMode ||!stage.cornersBlocked(px, py, h);

if (terrainOk(nx, ny) &&!blockedByEnemy(nx, ny)) { this.x = nx; this.y = ny; return;}
// 軸分離フォールバック（Xのみ→Yのみ）
if (terrainOk(nx, this.y) &&!blockedByEnemy(nx, this.y)) this.x = nx;
if (terrainOk(this.x, ny) &&!blockedByEnemy(this.x, ny)) this.y = ny;
}

update(game, dtF) {
const p = game.player;
const startX = this.x, startY = this.y;

// ノックバック中は通常移動しない
if (this.knockbackTimer > 0) {
const nx = this.x + this.knockbackVx * (dtF / 60);
const ny = this.y + this.knockbackVy * (dtF / 60);
if (!game.stage.cornersBlocked(nx, ny, Math.floor(this.size / 2))) { this.x = nx; this.y = ny;}
this.knockbackTimer -= dtF / 60;
if (this.knockbackTimer <= 0) {
this.knockbackVx = 0; this.knockbackVy = 0; this.knockbackTimer = 0;
this.knockbackCooldown = C.KNOCKBACK_COOLDOWN_DURATION;
}
} else {
const b = BEHAVIORS[this.behaviorType] || BEHAVIORS[1];
const [nx, ny] = b.move(this, p, dtF);
if (nx!== this.x || ny!== this.y) this._tryMove(game, nx, ny);
}
if (this.knockbackCooldown > 0) this.knockbackCooldown = Math.max(0, this.knockbackCooldown - dtF / 60);

// 向き・歩行アニメーション
const movedX = this.x - startX;
if (Math.abs(movedX) > 0.1) this.facingRight = movedX > 0;
const moved = Math.hypot(this.x - startX, this.y - startY);
this.isMoving = moved > 0.1;
if (this.isMoving) this.animationTime += dtF / 60;

// ハマり検出（移動量が1px未満なら加算。3秒で noclip、1秒経過＆地形外で解除）
if (moved < 1.0) {
this.stuckTimer += dtF / 60;
if (this.stuckTimer >= 3.0 &&!this.noclipMode) { this.noclipMode = true; this.noclipTimer = 0;}
} else this.stuckTimer = 0;
if (this.noclipMode) {
this.noclipTimer += dtF / 60;
if (this.noclipTimer >= 1.0 &&!game.stage.cornersBlocked(this.x, this.y, Math.floor(this.size / 2))) {
this.noclipMode = false; this.noclipTimer = 0;
}
}

if (this.hitFlashTimer > 0) this.hitFlashTimer = Math.max(0, this.hitFlashTimer - dtF / 60);

this.updateAttack(game);
this.updateProjectiles(game, dtF);
}

/* 射撃（行動タイプ3,4のみ。enemy.py update_attack） */
updateAttack(game) {
const b = BEHAVIORS[this.behaviorType];
if (!b ||!b.shoots || this.attackCooldown <= 0) return;
if (game.nowMs - this.lastAttackMs < this.attackCooldown) return;
const p = game.player;
const angle = Math.atan2(p.y - this.y, p.x - this.x);
if (!this.isBoss && this.projectiles.length >= 5) this.projectiles.shift(); // 通常敵は同時5発まで
const pr = new EnemyProjectile(this.x, this.y, angle, Math.floor(this.damage / 2), this.behaviorType, this.isBoss, this.projectileSpeed, this.level);
pr.createdMs = game.nowMs; // 生成時刻は発射時点で確定させる（描画側で付けると初回判定で即期限切れになる）
this.projectiles.push(pr);
this.lastAttackMs = game.nowMs;
}

updateProjectiles(game, dtF) {
const p = game.player;
const kept = [];
for (const pr of this.projectiles) {
if (pr.createdMs < 0) pr.createdMs = game.nowMs; // 未設定なら寿命をここから数える
let drop = false;
if (pr.isExpired(game)) drop = true;
else if (!pr.isOnScreen()) drop = true;
// 通常弾はプレイヤーから600px超で消去（ボス弾は無制限）
else if (!pr.isBossBullet) {
const dx = pr.x - p.x, dy = pr.y - p.y;
if (dx * dx + dy * dy > 360000) drop = true;
}
if (!drop) {
pr.update(game, dtF);
if (pr.expiredByObstacle) drop = true;
}
if (drop) this.deadProjectiles.push(pr); // 描画側でスプライトを解放させる（残すと弾が画面に残り続ける）
else kept.push(pr);
}
this.projectiles = kept;
}

isOffScreen() { // 直進タイプ等の削除判定（ボスは対象外）
if (this.isBoss) return false;
const m = C.OFFSCREEN_MARGIN;
return this.x < -m || this.x > C.WORLD_WIDTH + m || this.y < -m || this.y > C.WORLD_HEIGHT + m;
}
isBossOffScreen() {
if (!this.isBoss) return false;
const m = C.BOSS_WORLD_MARGIN;
return this.x < -m || this.x > C.WORLD_WIDTH + m || this.y < -m || this.y > C.WORLD_HEIGHT + m;
}
/* ボスがワールド外へ出たらプレイヤー付近へ再配置（respawn_boss_randomly） */
respawnNearPlayer(game) {
const p = game.player;
const side = randInt(0, 3), m = 100;
if (side === 0) { this.x = p.x + randInt(-C.SCREEN_WIDTH / 2, C.SCREEN_WIDTH / 2); this.y = p.y - C.SCREEN_HEIGHT / 2 - m;}
else if (side === 1) { this.x = p.x + C.SCREEN_WIDTH / 2 + m; this.y = p.y + randInt(-C.SCREEN_HEIGHT / 2, C.SCREEN_HEIGHT / 2);}
else if (side === 2) { this.x = p.x + randInt(-C.SCREEN_WIDTH / 2, C.SCREEN_WIDTH / 2); this.y = p.y + C.SCREEN_HEIGHT / 2 + m;}
else { this.x = p.x - C.SCREEN_WIDTH / 2 - m; this.y = p.y + randInt(-C.SCREEN_HEIGHT / 2, C.SCREEN_HEIGHT / 2);}
this.x = Math.max(50, Math.min(C.WORLD_WIDTH - 50, this.x));
this.y = Math.max(50, Math.min(C.WORLD_HEIGHT - 50, this.y));
this.initialDirection = null;
}
}

/* ---------------- 敵の弾 (core/enemy.py EnemyProjectile) ---------------- */
class EnemyProjectile {
constructor(x, y, angle, damage, behaviorType, isBossBullet, projectileSpeed, enemyLevel = 1) {
this.x = x; this.y = y;
this.angle = angle;
this.damage = damage;
this.behaviorType = behaviorType;
this.isBossBullet =!!isBossBullet;
this.speed = projectileSpeed;
this.size = this.isBossBullet? 24: 22; // 当たり判定サイズ（原作準拠）
this.drawSize = this.isBossBullet? 48: 22; // 描画キャンバス寸法（原作はボス弾を半径=sizeで描くため48）
this.lifetime = 3000; // ms
this.createdMs = -1; // game 側でセット
this.vx = Math.cos(angle) * this.speed;
this.vy = Math.sin(angle) * this.speed;
this.color = this.isBossBullet? 0xffd700: bulletColor(behaviorType, enemyLevel);
this.expiredByObstacle = false;
this.sprite = null;
}
update(game, dtF) {
this.x += this.vx * dtF;
this.y += this.vy * dtF;
// ボス弾のみ障害物（森5・岩9）で消える（原作仕様。通常弾は地形無視）
if (this.isBossBullet) {
const t = game.stage.tileAt(this.x, this.y);
if (t === 5 || t === 9) this.expiredByObstacle = true;
}
}
isExpired(game) { return game.nowMs - this.createdMs >= this.lifetime;}
isOnScreen() {
const m = 50;
return -m <= this.x && this.x <= C.WORLD_WIDTH + m && -m <= this.y && this.y <= C.WORLD_HEIGHT + m;
}
}

/* 出現位置が既存の敵と重なっている場合、近くの空いた安全な位置へずらす。
安全位置探索は決定的で、障害物際では多数の出現が同一点に集約され、
重なった敵同士が身動きできなくなるため、その予防（最大8回試行）。 */
function scatterIfStacked(game, x, y) {
const overlaps = (px, py) => game.queryEnemies(px, py, 96).some(o => {
const d = (o.size + 32) * C.ENEMY_COLLISION_SEPARATION_FACTOR;
const dx = px - o.x, dy = py - o.y;
return dx * dx + dy * dy < d * d;
});
if (!overlaps(x, y)) return [x, y];
for (let i = 0; i < 8; i++) {
const a = Math.random() * Math.PI * 2, r = 28 + Math.random() * 44;
const tx = x + Math.cos(a) * r, ty = y + Math.sin(a) * r;
if (tx < 50 || tx > C.WORLD_WIDTH - 50 || ty < 50 || ty > C.WORLD_HEIGHT - 50) continue;
if (!game.stage.isPositionSafe(tx, ty, 32)) continue;
if (!overlaps(tx, ty)) return [tx, ty];
}
return [x, y];
}

/* ---------------- 出現ディレクター (game_logic.py spawn_enemies 相当) ----------------
通常敵: spawnInterval フレームごとに画面端へ出現。間隔は時間とともに短縮し、
1回あたりの出現数は 30 秒ごとに +1 され続ける（負荷確認用の増量仕様。
原作は間隔 60f→最小10f・1回 1→3 体止まりだった）。
上限到達時は古い敵から削除して 80% まで減らす（原作方式）。
ボス: boss_stats.csv の spawn_time（秒）に各1回、画面外近傍に出現。 */
class SpawnDirector {
constructor() {
this.spawnTimerFrames = 0;
this.spawnIntervalFrames = C.SPAWN_INTERVAL_START_FRAMES;
this.lastDifficultyIncrease = 0; // 秒
this.spawnedBossNos = new Set();
}

update(game, dtF) {
// 難易度: SPAWN_INTERVAL_STEP_SEC ごとに出現間隔 -1（最小 SPAWN_INTERVAL_MIN_FRAMES）
if (game.gameTime - this.lastDifficultyIncrease >= C.SPAWN_INTERVAL_STEP_SEC) {
this.spawnIntervalFrames = Math.max(C.SPAWN_INTERVAL_MIN_FRAMES, this.spawnIntervalFrames - 1);
this.lastDifficultyIncrease = game.gameTime;
}
this.spawnTimerFrames += dtF;
if (this.spawnTimerFrames >= this.spawnIntervalFrames) {
this.spawnTimerFrames = 0;
this.spawnWave(game);
}
// ボス出現チェック
for (const [no, stat] of GameData.bossStats) {
if (this.spawnedBossNos.has(no)) continue;
if (game.gameTime >= stat.spawn_time) {
this.spawnedBossNos.add(no);
this.spawnBoss(game, stat);
}
}
}

spawnWave(game) {
if (game.enemies.length >= C.MAX_ENEMIES_ON_SCREEN) {
while (game.enemies.length > C.MAX_ENEMIES_ON_SCREEN * 0.8) game.removeEnemy(game.enemies[0]);
}
// 1回あたりの出現数: 30秒ごとに +1（増量仕様。原作は最大3体）。
// ただし画面付近の敵数がレベル別上限に達している間は追加しない。
const room = game.onscreenCap() - game.screenPopulation();
if (room <= 0) return;
const num = Math.min(1 + Math.floor(game.gameTime / C.SPAWN_BATCH_STEP_SEC), room);
const cam = game.camera, margin = 100;
for (let i = 0; i < num; i++) {
const side = ['top', 'bottom', 'left', 'right'][randInt(0, 3)];
let x, y;
if (side === 'top') { x = randInt(Math.floor(cam.x) - margin, Math.floor(cam.x) + C.SCREEN_WIDTH + margin); y = Math.floor(cam.y) - margin;}
else if (side === 'bottom') { x = randInt(Math.floor(cam.x) - margin, Math.floor(cam.x) + C.SCREEN_WIDTH + margin); y = Math.floor(cam.y) + C.SCREEN_HEIGHT + margin;}
else if (side === 'left') { x = Math.floor(cam.x) - margin; y = randInt(Math.floor(cam.y) - margin, Math.floor(cam.y) + C.SCREEN_HEIGHT + margin);}
else { x = Math.floor(cam.x) + C.SCREEN_WIDTH + margin; y = randInt(Math.floor(cam.y) - margin, Math.floor(cam.y) + C.SCREEN_HEIGHT + margin);}
x = Math.max(50, Math.min(C.WORLD_WIDTH - 50, x));
y = Math.max(50, Math.min(C.WORLD_HEIGHT - 50, y));
[x, y] = game.stage.findSafeSpawnPosition(x, y, 32);
[x, y] = scatterIfStacked(game, x, y);
const [enemyNo, rule] = GameData.selectEnemyNo(game.gameTime);
const stat = GameData.enemyStats.get(enemyNo);
if (!stat) continue;
const e = new Enemy(stat, {
spawnX: x, spawnY: y,
strengthMultiplier: rule.strength_multiplier, sizeMultiplier: rule.size_multiplier,
});
game.addEnemy(e);
game.particles.spawnBurst(x, y, 0xffffff, 1);
}
}

/* 画面外回収した敵の再出現: 同じ enemyNo を画面端の内側へ新品で出現させる */
respawnAtEdge(game, enemyNo) {
const stat = GameData.enemyStats.get(enemyNo);
if (!stat) return;
const cam = game.camera, inset = 40;
const side = ['top', 'bottom', 'left', 'right'][randInt(0, 3)];
let x, y;
if (side === 'top') { x = randInt(Math.floor(cam.x) + inset, Math.floor(cam.x) + C.SCREEN_WIDTH - inset); y = Math.floor(cam.y) + inset; }
else if (side === 'bottom') { x = randInt(Math.floor(cam.x) + inset, Math.floor(cam.x) + C.SCREEN_WIDTH - inset); y = Math.floor(cam.y) + C.SCREEN_HEIGHT - inset; }
else if (side === 'left') { x = Math.floor(cam.x) + inset; y = randInt(Math.floor(cam.y) + inset, Math.floor(cam.y) + C.SCREEN_HEIGHT - inset); }
else { x = Math.floor(cam.x) + C.SCREEN_WIDTH - inset; y = randInt(Math.floor(cam.y) + inset, Math.floor(cam.y) + C.SCREEN_HEIGHT - inset); }
x = Math.max(50, Math.min(C.WORLD_WIDTH - 50, x));
y = Math.max(50, Math.min(C.WORLD_HEIGHT - 50, y));
[x, y] = game.stage.findSafeSpawnPosition(x, y, 32);
[x, y] = scatterIfStacked(game, x, y);
game.addEnemy(new Enemy(stat, { spawnX: x, spawnY: y }));
game.particles.spawnBurst(x, y, 0xffffff, 1);
}

spawnBoss(game, stat) {
const p = game.player, margin = 150;
let bx = null, by = null;
for (let attempt = 0; attempt < 3 && bx === null; attempt++) {
const side = randInt(0, 3);
let tx, ty;
if (side === 0) { tx = p.x + randInt(-C.SCREEN_WIDTH / 2, C.SCREEN_WIDTH / 2); ty = p.y - C.SCREEN_HEIGHT / 2 - margin - randInt(0, 50);}
else if (side === 1) { tx = p.x + C.SCREEN_WIDTH / 2 + margin + randInt(0, 50); ty = p.y + randInt(-C.SCREEN_HEIGHT / 2, C.SCREEN_HEIGHT / 2);}
else if (side === 2) { tx = p.x + randInt(-C.SCREEN_WIDTH / 2, C.SCREEN_WIDTH / 2); ty = p.y + C.SCREEN_HEIGHT / 2 + margin + randInt(0, 50);}
else { tx = p.x - C.SCREEN_WIDTH / 2 - margin - randInt(0, 50); ty = p.y + randInt(-C.SCREEN_HEIGHT / 2, C.SCREEN_HEIGHT / 2);}
tx = Math.max(50, Math.min(C.WORLD_WIDTH - 50, tx));
ty = Math.max(50, Math.min(C.WORLD_HEIGHT - 50, ty));
if (50 <= tx && tx <= C.WORLD_WIDTH - 50 && 50 <= ty && ty <= C.WORLD_HEIGHT - 50) { bx = tx; by = ty;}
}
if (bx === null) { bx = p.x; by = Math.max(50, p.y - 400);}
[bx, by] = game.stage.findSafeSpawnPosition(bx, by, 50);
const boss = Enemy.fromBossStat(stat, bx, by);
game.addEnemy(boss);
game.particles.spawnBurst(bx, by, 0xff5050, 15);
}
}
if (typeof module!== 'undefined') module.exports = { Enemy, EnemyProjectile, SpawnDirector, BEHAVIORS, enemyColor, hsvToRgbInt};
