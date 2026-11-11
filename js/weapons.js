'use strict';
/* 武器モジュール (weapons.js)
元コード対応: weapons/base.py, weapons/melee.py, weapons/projectile.py,
および effects/attack.py（Attackクラス）。

新しい武器を足すには:
1. WEAPON_DEFS にエントリを1つ追加する（init / attack / levelUp を書く）
2. 攻撃の移動・消滅ルールが新しい場合は ATTACK_BEHAVIORS にも1つ追加する
3. data/descriptions.json と assets/icons/ に名前とアイコンを足す
コアループ（game.js）は一切変更不要。

数値の出典: 各 init は原作クラスの __init__ の値をそのまま写した。
READMEと食い違う箇所（例: axe のクールダウン）はコード側を正とする。
サブアイテム補正の適用式も武器ごとに原作コードの式を再現している
（whip/garlic/book/thunder は「damage + 倍率」、他は「damage × 倍率」、
knife は基礎攻撃力ボーナスを適用しない、など原作の癖を含む）。 */

/* ---------------- Attack（effects/attack.py の移植） ----------------
攻撃1個分の状態。描画は game.js 側の簡易レンダラが type ごとに描く。
size = max(size_x, size_y) // 2 が当たり判定の半径（原作仕様）。 */
function makeAttack(opts) {
const atk = Object.assign({
x: 0, y: 0, sizeX: 10, sizeY: 10, type: 'unknown',
duration: 1000, // ms
damage: 0,
target: null, // magic_wand / thunder の追尾対象
speed: 0,
velocityX: null, velocityY: null,
dx: 0, dy: 0, // magic_wand の固定進行ベクトル
bouncesRemaining: 0, // stone
followPlayer: false, // whip / garlic / book
direction: null, // whip
spawnDelay: 0, // ms（複数同時発射時の遅延発生）
pending: false,
hitTargets: new Set(), // 非持続攻撃の再ヒット防止（敵オブジェクト参照）
hitBoxes: new Set(), // ボックス版
lastHitTimes: new Map(), // 持続攻撃（garlic/holy_water）の敵ごと最終ヒット時刻(ゲーム内秒)
lastBoxHitTimes: new Map(),
lastGarlicHealTime: -1e9,
angle: 0,
rotationSpeed: 0,
orbitRadius: 0, orbitAngle: 0,
strikeFromY: null, thunderStarted: false, struck: false, fallSpeed: 12,
headOffset: 0,
trail: null,
}, opts);
atk.size = Math.floor(Math.max(atk.sizeX, atk.sizeY) / 2);
atk.createdMs = -1; // 発生時刻は game 側でセット（pending解除時に再セット）
return atk;
}

/* 攻撃の「動き」だけを担当する振る舞いレジストリ。
update(atk, game, dtF): dtF は 60fps基準のフレーム換算デルタ。
消滅させたい場合は atk.duration = 0 にする（原作方式）。 */
const ATTACK_BEHAVIORS = {
/* ムチ: プレイヤー基点から sin 波で伸縮。当たり判定中心は全長の中央で固定（原作通り） */
whip(atk, game) {
const p = game.player;
const t = Math.min(Math.max((game.nowMs - atk.createdMs) / Math.max(1, atk.duration), 0), 1);
const extend = Math.pow(Math.sin(Math.PI * t), 2);
const angle = { right: 0, left: Math.PI, up: -Math.PI / 2, down: Math.PI / 2}[atk.direction || 'right'] || 0;
const length = atk.length || Math.max(atk.sizeX, atk.sizeY);
atk.renderPoints = [];
const segs = 4;
for (let i = 0; i <= segs; i++) {
const f = i / segs;
atk.renderPoints.push([p.x + Math.cos(angle) * length * extend * f, p.y + Math.sin(angle) * length * extend * f]);
}
atk.x = p.x + Math.cos(angle) * length * 0.5;
atk.y = p.y + Math.sin(angle) * length * 0.5;
},
/* ガーリック: プレイヤー追従＋パルスでサイズが 0.5〜1.0 倍に脈動（原作 Attack.update） */
garlic(atk, game) {
const p = game.player;
atk.x = p.x; atk.y = p.y;
atk.pulseTimer = (atk.pulseTimer || 0) + 1;
const ratio = Math.abs(Math.sin(atk.pulseTimer * Math.PI / 60));
atk.sizeX = atk.originalSize * (0.5 + 0.5 * ratio);
atk.sizeY = atk.sizeX;
atk.size = Math.floor(atk.sizeX / 2);
},
/* 回転する本: プレイヤー周囲を公転 */
book(atk, game, dtF) {
const p = game.player;
atk.orbitAngle += (atk.rotationSpeed || 0.05) * dtF;
atk.x = p.x + Math.cos(atk.orbitAngle) * atk.orbitRadius;
atk.y = p.y + Math.sin(atk.orbitAngle) * atk.orbitRadius;
},
/* 聖水: その場に静止（持続ダメージは衝突側で間隔管理） */
holy_water() {},
/* 魔法の杖: 生成時に決めた方向へ直進（追尾しないのが原作仕様）。不可侵領域で消滅 */
magic_wand(atk, game, dtF) {
const nx = atk.x + atk.dx * dtF, ny = atk.y + atk.dy * dtF;
if (game.stage.isWeaponBlockedAt(nx, ny, 'magic_wand')) { atk.duration = 0; return;}
atk.x = nx; atk.y = ny;
(atk.trail = atk.trail || []).push([atk.x, atk.y]);
if (atk.trail.length > 6) atk.trail = atk.trail.slice(-6);
},
/* 斧: 速度ベクトルで直進＋回転。不可侵領域で消滅。敵は貫通 */
axe(atk, game, dtF) {
const nx = atk.x + (atk.velocityX || 0) * dtF, ny = atk.y + (atk.velocityY || 0) * dtF;
if (game.stage.isWeaponBlockedAt(nx, ny, 'axe')) { atk.duration = 0; return;}
atk.angle += (atk.rotationSpeed || 0) * dtF;
atk.x = nx; atk.y = ny;
},
/* ナイフ: 速度ベクトルで直進。不可侵領域で消滅。敵は貫通 */
knife(atk, game, dtF) {
const nx = atk.x + (atk.velocityX || 0) * dtF, ny = atk.y + (atk.velocityY || 0) * dtF;
if (game.stage.isWeaponBlockedAt(nx, ny, 'knife')) { atk.duration = 0; return;}
atk.x = nx; atk.y = ny;
},
/* 石: カメラ範囲の端で反射（バウンド回数を消費）。不可侵領域でも反射。
バウンド残数が負になったら消滅（Attack.is_expired の移植） */
stone(atk, game, dtF) {
let nx = atk.x + atk.velocityX * dtF, ny = atk.y + atk.velocityY * dtF;
if (game.stage.isWeaponBlockedAt(nx, ny, 'stone')) {
atk.velocityX *= -1; atk.velocityY *= -1; atk.bouncesRemaining -= 1;
nx = atk.x + atk.velocityX * dtF; ny = atk.y + atk.velocityY * dtF;
}
atk.x = nx; atk.y = ny;
const left = game.camera.x, right = game.camera.x + C.SCREEN_WIDTH;
const top = game.camera.y, bottom = game.camera.y + C.SCREEN_HEIGHT;
let bounced = false;
if (atk.x <= left || atk.x >= right) {
atk.velocityX *= -1; atk.bouncesRemaining -= 1;
atk.x = Math.max(left + 1, Math.min(atk.x, right - 1)); bounced = true;
}
if (atk.y <= top || atk.y >= bottom) {
atk.velocityY *= -1; atk.bouncesRemaining -= 1;
atk.y = Math.max(top + 1, Math.min(atk.y, bottom - 1)); bounced = true;
}
(atk.trail = atk.trail || []).push([atk.x, atk.y]);
const trailLen = Math.max(3, Math.min(8, Math.floor(atk.size / 2) + 3));
if (atk.trail.length > trailLen) atk.trail = atk.trail.slice(-trailLen);
if (bounced && atk.trail.length > 2) atk.trail = atk.trail.slice(-2);
},
/* サンダー: 対象の頭上へ落下し、着弾後に300ms残る */
thunder(atk, game, dtF) {
if (!atk.thunderStarted && atk.strikeFromY!== null && atk.strikeFromY!== undefined) {
atk.y = atk.strikeFromY;
atk.thunderStarted = true;
const targetY = atk.target? atk.target.y - atk.headOffset: atk.y;
atk.fallSpeed = Math.max(8, Math.floor((targetY - atk.y) / 6)) || 12;
atk.struck = false;
}
if (!atk.struck) {
const targetY = atk.target? atk.target.y - atk.headOffset: atk.y;
if (atk.target) atk.x = atk.target.x;
atk.y += atk.fallSpeed * dtF;
if (atk.y >= targetY) {
atk.y = targetY; atk.struck = true;
atk.createdMs = game.nowMs; atk.duration = 300; // 着弾後に短時間残留（原作）
}
}
},
};

function updateAttack(atk, game, dtF) {
// spawn_delay 中は発生しない（原作 Attack.update の pending 処理）
if (atk.pending) {
if (game.nowMs - atk.spawnedMs < atk.spawnDelay) return;
atk.pending = false;
atk.createdMs = game.nowMs;
}
const fn = ATTACK_BEHAVIORS[atk.type];
if (fn) fn(atk, game, dtF);
}
function isAttackExpired(atk, game) {
if (atk.pending) return false;
return (game.nowMs - atk.createdMs >= atk.duration) ||
(atk.type === 'stone' && atk.bouncesRemaining < 0);
}

/* ---------------- 武器レジストリ ----------------
各エントリ:
init(w): w に初期パラメータを設定（原作 __init__）
attack(w, game): クールダウン判定込み。発射したら Attack[] を返す
levelUp(w): レベルアップ時の強化（原作 level_up の式を再現）
w は { key, level, cooldown, damage, lastAttackMs} を基本形とする。 */
function baseWeapon(key) {
return { key, level: 1, cooldown: 1000, damage: 5, lastAttackMs: -1000};
}
function canAttack(w, game) { return game.nowMs - w.lastAttackMs >= w.cooldown;}

const WEAPON_DEFS = {
/* ムチ (weapons/melee.py Whip): 横方向のみ。Lv3から前後両方向（後方は遅延） */
whip: {
init(w) { w.cooldown = 800; w.damage = 30; w.range = 200; w.duration = 180; w.width = 12; w.lastDirection = 'right';},
attack(w, game) {
if (!canAttack(w, game)) return [];
w.lastAttackMs = game.nowMs;
const p = game.player;
// 発射方向: 移動方向（左右）を優先、無ければ前回の方向（原作は左右のみ使用）
let primary = w.lastDirection;
if (Math.abs(p.movementDx) > Math.abs(p.movementDy) && p.movementDx!== 0) {
primary = p.movementDx < 0? 'left': 'right';
w.lastDirection = primary;
}
const dirs = w.level <= 2? [primary]: [primary, primary === 'right'? 'left': 'right'];
const range = Math.max(1, Math.floor(w.range * p.effectRangeMult()));
const duration = Math.floor(w.duration * p.effectTimeMult());
const damage = w.damage + p.baseDamageMult(); // 原作: damage + bonus（加算式）
return dirs.map((dir, i) => {
const horizontal = (dir === 'left' || dir === 'right');
const atk = makeAttack({
x: p.x + (horizontal? (dir === 'right'? range / 2: -range / 2): 0),
y: p.y + (!horizontal? (dir === 'down'? range / 2: -range / 2): 0),
sizeX: horizontal? range: w.width, sizeY: horizontal? w.width: range,
type: 'whip', duration, direction: dir, followPlayer: true, damage,
});
atk.length = range; atk.width = w.width;
if (w.level >= 3 && i === 1) { atk.spawnDelay = Math.max(40, Math.floor(w.duration * 0.4)); atk.pending = true;}
return atk;
});
},
levelUp(w) { w.range *= 1.1; w.width = Math.floor(w.width * 1.1);},
},

/* ガーリック (Whip と同じ melee.py): 追従する持続リング。ヒットで回復（間隔は衝突側） */
garlic: {
init(w) { w.cooldown = 1300; w.damage = 3; w.radius = 60; w.duration = 1000;},
attack(w, game) {
if (!canAttack(w, game)) return [];
w.lastAttackMs = game.nowMs;
const p = game.player;
const radius = Math.max(1, Math.floor(w.radius * p.effectRangeMult()));
const atk = makeAttack({
x: p.x, y: p.y, sizeX: radius * 2, sizeY: radius * 2, type: 'garlic',
duration: Math.floor(w.duration * p.effectTimeMult()), followPlayer: true,
damage: w.damage + p.baseDamageMult(), // 原作: 加算式
});
atk.originalSize = radius * 2;
return [atk];
},
levelUp(w) { w.radius = Math.floor(w.radius * 1.2); w.duration = Math.floor(w.duration * 1.1); w.damage *= 1.3;},
},

/* 聖水 (projectile.py HolyWater): プレイヤー周辺に持続する水溜まりを複数生成 */
holy_water: {
init(w) { w.cooldown = 2000; w.damage = 8; w.duration = 1000; w.radius = 50; w.numAttacks = 1;},
attack(w, game) {
if (!canAttack(w, game)) return [];
w.lastAttackMs = game.nowMs;
const p = game.player;
const radius = Math.max(1, Math.floor(w.radius * p.effectRangeMult()));
const count = Math.max(1, Math.floor(w.numAttacks + p.extraProjectiles()));
const damage = w.damage * p.baseDamageMult(); // 原作: 乗算式
const duration = Math.floor(w.duration * p.effectTimeMult());
const out = [];
for (let i = 0; i < count; i++) {
// 原作 _generate_non_overlapping_positions の簡易版（周辺に円形配置＋ランダム）
let x, y;
if (count === 1) { x = p.x + randInt(-50, 50); y = p.y + randInt(-50, 50);}
else {
const ang = (2 * Math.PI * i) / count + randFloat(-0.3, 0.3);
const dist = radius * 2 + randFloat(-20, 40);
x = p.x + Math.cos(ang) * dist; y = p.y + Math.sin(ang) * dist;
}
const atk = makeAttack({ x, y, sizeX: radius * 2, sizeY: radius * 2, type: 'holy_water', duration, damage});
if (count > 1) { atk.spawnDelay = i * 100; atk.pending = true;}
out.push(atk);
}
return out;
},
levelUp(w) { // 原作: レベルアップ後のレベルが偶数→範囲、奇数→個数
if (w.level % 2 === 0) w.radius = Math.floor(w.radius * 1.2); else w.numAttacks += 1;
w.damage *= 1.2;
},
},

/* 魔法の杖 (MagicWand): 最も近い敵へ直進弾。ヒットで消滅する唯一の武器 */
magic_wand: {
init(w) { w.cooldown = 800; w.damage = 12; w.speed = 5; w.numProjectiles = 1;},
attack(w, game) {
if (!canAttack(w, game) ||!game.enemies.length) return [];
w.lastAttackMs = game.nowMs;
const p = game.player;
const num = Math.max(1, Math.floor(w.numProjectiles + p.extraProjectiles()));
const damage = w.damage * p.baseDamageMult();
const speed = w.speed * p.projectileSpeedMult();
const targets = [...game.enemies]
.sort((a, b) => dist2(p, a) - dist2(p, b)).slice(0, num);
return targets.map(t => {
const ang = Math.atan2(t.y - p.y, t.x - p.x);
const atk = makeAttack({ x: p.x, y: p.y, sizeX: 10, sizeY: 10, type: 'magic_wand', target: t, speed, damage, duration: 3000});
atk.dx = Math.cos(ang) * speed; atk.dy = Math.sin(ang) * speed;
return atk;
});
},
levelUp(w, oldLevel) { // 原作の癖: 偶奇判定はレベルアップ「前」のレベルで行い、弾数は常時+1もされる
if (oldLevel % 2 === 0) w.speed += 3; else w.numProjectiles += 1;
w.damage *= 1.1;
w.numProjectiles += 1;
w.cooldown = Math.max(w.cooldown * 0.85, 500);
},
},

/* 斧 (Axe): ランダム方向へ投擲、回転しながら直進、貫通 */
axe: {
init(w) { w.cooldown = 1500; w.damage = 25; w.size = 50; w.throwSpeed = 6; w.rotationSpeed = 0.2; w.numProjectiles = 1;},
attack(w, game) {
if (!canAttack(w, game)) return [];
w.lastAttackMs = game.nowMs;
const p = game.player;
const size = Math.min(100, Math.floor(w.size * p.effectRangeMult()));
const duration = Math.max(100, Math.floor(3000 * p.effectTimeMult()));
const damage = w.damage * p.baseDamageMult();
const num = Math.min(4, w.numProjectiles + p.extraProjectiles());
const speed = w.throwSpeed * p.projectileSpeedMult();
const out = [];
for (let i = 0; i < num; i++) {
const ang = randFloat(0, Math.PI * 2);
out.push(makeAttack({
x: p.x, y: p.y, sizeX: size, sizeY: size, type: 'axe', duration, speed,
velocityX: Math.cos(ang) * speed, velocityY: Math.sin(ang) * speed,
rotationSpeed: w.rotationSpeed, damage,
}));
}
return out;
},
levelUp(w) {
w.size = Math.floor(w.size * 1.3); w.throwSpeed += 1; w.damage *= 1.2;
if (w.level % 2 === 1) w.cooldown = Math.max(w.cooldown * 0.95, 1000); else w.numProjectiles += 1;
},
},

/* 石 (Stone): 1個だけ投げる。反射回数が増えるのが特徴（追加弾は反射+1に変換される） */
stone: {
init(w) { w.cooldown = 1500; w.damage = 15; w.speed = 15; w.bounces = 2; w.duration = 5000; w.size = 25;},
attack(w, game) {
if (!canAttack(w, game)) return [];
w.lastAttackMs = game.nowMs;
const p = game.player;
const spd = w.speed * p.projectileSpeedMult();
const ang = randFloat(0, Math.PI * 2);
const size = w.size * p.effectRangeMult();
return [makeAttack({
x: p.x, y: p.y, sizeX: size, sizeY: size, type: 'stone', speed: spd,
duration: w.duration * p.effectTimeMult(), bounces: w.bounces + p.extraProjectiles(),
velocityX: Math.cos(ang) * spd, velocityY: Math.sin(ang) * spd,
damage: w.damage * p.baseDamageMult(),
})];
},
levelUp(w) { w.speed *= 1.3; w.bounces += 1; w.damage *= 1.3; w.size += 2;},
},

/* 回転する本 (RotatingBook): プレイヤー周囲を公転する本。攻撃エンティティは type 'book' */
rotating_book: {
init(w) { w.cooldown = 6000; w.damage = 15; w.orbitRadius = 80; w.rotationSpeed = 0.05; w.numBooks = 1; w.duration = 5000; w.bookW = 24; w.bookH = 24;},
attack(w, game) {
if (!canAttack(w, game)) return [];
w.lastAttackMs = game.nowMs;
const p = game.player;
const radius = Math.max(1, Math.floor(w.orbitRadius * p.effectRangeMult()));
const num = Math.min(6, Math.floor(w.numBooks + p.extraProjectiles()));
const size = Math.min(80, Math.floor(w.bookW * p.effectRangeMult()));
const damage = w.damage + p.baseDamageMult(); // 原作: 加算式
const out = [];
for (let i = 0; i < num; i++) {
const ang = (2 * Math.PI * i) / Math.max(1, num);
const atk = makeAttack({
x: p.x + Math.cos(ang) * radius, y: p.y + Math.sin(ang) * radius,
sizeX: size, sizeY: size, type: 'book',
duration: Math.floor(w.duration * p.effectTimeMult()), followPlayer: true, damage,
});
atk.orbitRadius = radius; atk.orbitAngle = ang; atk.rotationSpeed = w.rotationSpeed;
out.push(atk);
}
return out;
},
levelUp(w) {
w.numBooks += 1;
w.orbitRadius = Math.floor(w.orbitRadius * 1.05);
w.damage = Math.floor(w.damage * 1.15);
w.cooldown = Math.min(Math.floor(w.cooldown * 0.95), 5000); // 原作の min() の癖を再現
w.bookW = Math.min(64, Math.floor(w.bookW * 1.2));
w.bookH = Math.min(64, Math.floor(w.bookH * 1.2));
w.rotationSpeed = Math.min(1.5, w.rotationSpeed * 1.1);
},
},

/* ナイフ (Knife): 移動方向へ並行に複数投擲。基礎攻撃力ボーナスを受けない（原作仕様） */
knife: {
init(w) { w.cooldown = 700; w.damage = 18; w.speed = 12; w.size = 10; w.numKnives = 1; w.spacing = 15;},
attack(w, game) {
if (!canAttack(w, game)) return [];
w.lastAttackMs = game.nowMs;
const p = game.player;
let angle;
if (p.movementDx!== 0 || p.movementDy!== 0) angle = Math.atan2(p.movementDy, p.movementDx);
else angle = p.lastAttackAngle || 0;
p.lastAttackAngle = angle;
const spd = w.speed * p.projectileSpeedMult();
const vx = Math.cos(angle) * spd, vy = Math.sin(angle) * spd;
const perpX = -Math.sin(angle), perpY = Math.cos(angle);
const num = Math.max(1, Math.floor(w.numKnives + p.extraProjectiles()));
const mid = (num - 1) / 2.0;
const out = [];
for (let i = 0; i < num; i++) {
const off = (i - mid) * w.spacing;
const atk = makeAttack({
x: p.x + perpX * off, y: p.y + perpY * off, sizeX: w.size, sizeY: w.size,
type: 'knife', duration: 1500, velocityX: vx, velocityY: vy, damage: w.damage,
});
const delayIdx = Math.ceil(Math.abs(i - mid));
if (delayIdx > 0) { atk.spawnDelay = delayIdx * 100; atk.pending = true;}
out.push(atk);
}
return out;
},
levelUp(w) {
w.numKnives = Math.min(8, w.numKnives + 1);
w.speed = Math.floor(w.speed * 1.1);
w.damage = Math.floor(w.damage * 1.15);
w.cooldown = Math.max(Math.floor(w.cooldown * 0.95), 120);
},
},

/* サンダー (Thunder): 画面内の敵の頭上へ落雷。敵がいなければ周囲のランダム地点 */
thunder: {
init(w) { w.cooldown = 2000; w.damage = 40; w.numStrikes = 1; w.duration = 500; w.heightOffset = 120; w.areaSize = 80;},
attack(w, game) {
if (!canAttack(w, game)) return [];
w.lastAttackMs = game.nowMs;
const p = game.player;
const area = Math.max(8, Math.floor(w.areaSize * p.effectRangeMult()));
const num = Math.max(1, Math.floor(w.numStrikes + p.extraProjectiles()));
const damage = w.damage + p.baseDamageMult(); // 原作: 加算式
const duration = w.duration * p.effectTimeMult();
const cam = game.camera;
let pool = game.enemies.filter(e => e.x >= cam.x && e.x <= cam.x + C.SCREEN_WIDTH && e.y >= cam.y && e.y <= cam.y + C.SCREEN_HEIGHT);
if (!pool.length) pool = game.enemies;
const out = [];
const k = Math.min(pool.length, num);
// ターゲット選定: ボスを最優先し、残りの落雷枠を通常敵からランダムに選ぶ
// （原作コードは全体からランダム抽選。ボス優先は 2026-11-11 浩之様の指定で追加）
const bossTargets = shuffleCopy(pool.filter(e => e.isBoss));
const otherTargets = shuffleCopy(pool.filter(e =>!e.isBoss));
const targets = [...bossTargets, ...otherTargets].slice(0, k);
targets.forEach((t, i) => {
const headOffset = Math.max(0, Math.floor(t.size * 0.9)) + 4;
const atk = makeAttack({
x: t.x, y: t.y - headOffset, sizeX: area, sizeY: area, type: 'thunder',
duration, damage, target: t,
});
atk.headOffset = headOffset;
atk.strikeFromY = (t.y - headOffset) - w.heightOffset;
if (num > 1 && i > 0) { atk.spawnDelay = i * 120; atk.pending = true;}
out.push(atk);
});
if (!targets.length) {
for (let i = 0; i < num; i++) {
const rx = p.x + randInt(-200, 200), ry = p.y + randInt(-200, 200);
const atk = makeAttack({ x: rx, y: ry, sizeX: area, sizeY: area, type: 'thunder', duration: w.duration, damage});
atk.strikeFromY = ry - w.heightOffset;
if (num > 1 && i > 0) { atk.spawnDelay = i * 120; atk.pending = true;}
out.push(atk);
}
}
return out;
},
levelUp(w) {
w.numStrikes = Math.min(4, w.numStrikes + 1);
w.damage = Math.floor(w.damage * 1.15);
w.cooldown = Math.max(Math.floor(w.cooldown * 0.9), 500);
},
},
};

/* 武器の表示順（開始時3x3グリッドの並び = player.py の all_weapons 定義順） */
const WEAPON_ORDER = ['whip', 'holy_water', 'garlic', 'magic_wand', 'axe', 'stone', 'rotating_book', 'knife', 'thunder'];

function createWeapon(key) {
const def = WEAPON_DEFS[key];
if (!def) throw new Error('未知の武器: ' + key);
const w = baseWeapon(key);
def.init(w);
w.lastAttackMs = -w.cooldown; // 生成直後から攻撃可能（base.py の初期化方式）
return w;
}

/* 小物ユーティリティ（他モジュールからも使う） */
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min;}
function randFloat(min, max) { return Math.random() * (max - min) + min;}
function dist2(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy;}
function shuffleCopy(arr) {
const a = arr.slice();
for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]];}
return a;
}
function sample(arr, n) { return shuffleCopy(arr).slice(0, Math.min(n, arr.length));}
if (typeof module!== 'undefined') module.exports = { WEAPON_DEFS, WEAPON_ORDER, createWeapon, makeAttack, updateAttack, isAttackExpired};
