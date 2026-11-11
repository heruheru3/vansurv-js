'use strict';
/* プレイヤーモジュール (player.js)
元コード対応: core/player.py の Player クラス、ui/subitems.py の SubItem 定義。

サブアイテムを足すには SUBITEM_DEFS に1行足すだけ。
効果の「読み出し」は Player のヘルパーメソッド経由に統一してあるので、
新しい効果軸が要る場合のみヘルパーを1つ追加する。 */

/* ---------------- サブアイテムレジストリ (ui/subitems.py) ----------------
value(level) = base + level * perLevel。
isPercent=true の項目は「倍率への加算分」として各ヘルパーが解釈する
（例: base_damage Lv1 = 0.3 → ダメージ倍率 1.3）。 */
const SUBITEM_DEFS = {
hp: { base: 0.0, perLevel: 20.0, isPercent: true}, // 最大HP +20/Lv（自然回復量も = Lv）
base_damage: { base: 0.0, perLevel: 0.3, isPercent: true}, // ダメージ倍率 +0.3/Lv
defense: { base: 0.0, perLevel: 1.0, isPercent: false}, // 被ダメージ -1/Lv
speed: { base: 0.0, perLevel: 0.15, isPercent: true}, // 移動速度 +15%/Lv、回避率にも加算
effect_range: { base: 0.0, perLevel: 0.2, isPercent: true}, // 効果範囲 +20%/Lv
effect_time: { base: 0.0, perLevel: 0.25, isPercent: true}, // 効果時間 +25%/Lv
extra_projectiles:{ base: 0.0, perLevel: 1.0, isPercent: false}, // 弾数 +1/Lv
projectile_speed: { base: 0.0, perLevel: 0.2, isPercent: true}, // 弾速 +20%/Lv（ジェム回収速度も連動）
gem_pickup_range: { base: 0.0, perLevel: 35.0, isPercent: false}, // 引き寄せ範囲 +35px/Lv
};
const SUBITEM_ORDER = Object.keys(SUBITEM_DEFS);
function subitemValue(key, level) {
const d = SUBITEM_DEFS[key];
return d.base + level * d.perLevel;
}

class Player {
constructor(stage) {
// 初期位置はワールド中央→安全な場所へ調整（player.py _adjust_spawn_position）
this.x = C.WORLD_WIDTH / 2;
this.y = C.WORLD_HEIGHT / 2;
this.baseSpeed = 2.5; // px/frame (60fps基準)
this.size = 24;
const [sx, sy] = stage.findSafeSpawnPosition(this.x, this.y, this.size);
this.x = sx; this.y = sy;

this.baseMaxHp = 100;
this.hp = this.baseMaxHp;
this.baseDefense = 1;
this.baseAvoidance = 0.1;
this.exp = 0;
this.level = 1;
this.expToNextLevel = 3; // player.py 初期値

this.weapons = new Map(); // key -> weapon instance (weapons.js)
this.availableWeapons = new Set(WEAPON_ORDER); // 未所持の武器キー
this.subitems = new Map(); // key -> level

// 入力・移動の状態（武器の発射方向決定にも使う）
this.movementDx = 0; this.movementDy = 0;
this.lastDirection = 'right';
this.lastAttackAngle = 0;
this.movementDeadzone = 10;

// 無敵時間（game.nowMs 基準）。通常=被弾後 INVINCIBLE_MS、特別=コンティニュー後など
this.invincibleUntilMs = -1;
this.specialInvincibleUntilMs = -1;

// マグネット効果
this.magnetEndMs = -1;
this.magnetDropRateMultiplier = 1.0; // gem_pickup_range 取得ごとに ×1.3（player.py の癖）

this.lastRegenMs = 0;
this.distanceTraveled = 0;
this.facingRight = false; // 原作スプライトは左向き基準で反転
this.animTick = 0; this.frameIndex = 0;

this.sprite = null; // game.js が生成して設定する
}

/* ---------------- サブアイテム効果の読み出し（player.py の get_* 群） ---------------- */
subLevel(key) { return this.subitems.get(key) || 0;}
subValue(key) { const lv = this.subLevel(key); return lv? subitemValue(key, lv): 0;}

maxHp() { return Math.floor(this.baseMaxHp + this.subValue('hp'));}
baseDamageMult() { return 1.0 + this.subValue('base_damage');} // player.py get_base_damage_bonus
defense() { return this.baseDefense + this.subValue('defense');}
speed() { return this.baseSpeed * (1 + this.subValue('speed'));}
avoidance() { return this.baseAvoidance + this.subValue('speed');} // 回避率は speed の値がそのまま加算される
effectRangeMult() { return 1.0 + this.subValue('effect_range');}
effectTimeMult() { return 1.0 + this.subValue('effect_time');}
extraProjectiles() { return Math.floor(this.subValue('extra_projectiles'));}
projectileSpeedMult() { return 1.0 + this.subValue('projectile_speed');}
gemPickupRange() { return this.subValue('gem_pickup_range');} // 追加引き寄せ距離(px)
gemCollectionSpeed() { return 1.0 + this.subValue('projectile_speed');}
magnetLevel() { return this.subLevel('gem_pickup_range');}
magnetDropRate() { return C.MAGNET_ITEM_DROP_RATE * this.magnetDropRateMultiplier;}

/* ---------------- 回復 (player.py heal) ----------------
type 'item' のとき amount は割合（最大HP比）。実回復量を返す。 */
heal(amount, type) {
const healAmount = type === 'item'? Math.floor(this.maxHp() * amount): amount;
const old = this.hp;
this.hp = Math.min(this.maxHp(), this.hp + healAmount);
return this.hp - old;
}
naturalHealAmount() { return C.NATURAL_HEAL_AMOUNT + this.subLevel('hp');} // 0 + HPレベル
garlicHealAmount() { return C.GARLIC_HEAL_AMOUNT;} // 固定1

/* 自然回復: HPサブアイテム所持時のみ、2秒ごとに (レベル) 回復 */
updateRegen(game) {
if (this.hp <= 0) { this.lastRegenMs = game.nowMs; return;}
if (this.subLevel('hp') > 0 && this.hp < this.maxHp() &&
game.nowMs - this.lastRegenMs >= C.NATURAL_HEAL_INTERVAL_MS) {
const healed = this.heal(this.naturalHealAmount(), 'auto');
if (healed > 0 && game.spawnHealFx) game.spawnHealFx(healed, 'auto'); // 原作 HealEffect/AutoHealEffect
this.lastRegenMs = game.nowMs;
}
}

/* ---------------- 無敵・マグネット・画面揺れ補助 ---------------- */
canTakeDamage(game) {
return game.nowMs >= this.invincibleUntilMs && game.nowMs >= this.specialInvincibleUntilMs;
}
setNormalInvincible(game) { this.invincibleUntilMs = game.nowMs + C.INVINCIBLE_MS;}
setSpecialInvincible(game, seconds) { this.specialInvincibleUntilMs = game.nowMs + seconds * 1000;}
isInvincible(game) { return!this.canTakeDamage(game);}
activateMagnet(game) { this.magnetEndMs = game.nowMs + C.MAGNET_EFFECT_DURATION_MS;}
isMagnetActive(game) { return game.nowMs < this.magnetEndMs;}

/* ---------------- 経験値とレベルアップ (player.py add_exp / level_up) ----------------
戻り値: レベルアップしたら true。原作は add_exp 1回で最大1レベルだけ上がる。 */
addExp(amount) {
this.exp += amount;
if (this.exp >= this.expToNextLevel) {
this.level += 1;
this.exp -= this.expToNextLevel;
if (this.level <= 5) this.expToNextLevel = 3 + this.level * 2;
else if (this.level <= 10) this.expToNextLevel = 10 + this.level * 3;
else this.expToNextLevel = 20 + this.level * 5;
return true;
}
return false;
}

/* レベルアップ時の選択肢プール（player.py upgrade_weapons の移植）
候補は 'weapon:<key>' / 'sub:<key>' 形式の文字列。
- 未所持武器（所持枠に空きがある場合のみ）と所持武器の強化
- 未所持サブアイテム（枠に空きがある場合のみ）と所持サブアイテムの強化
上限（武器Lv5 / サブLv3）に達したものは除外される。 */
buildLevelUpChoices(count = 3) {
const pool = [];
if (this.weapons.size < C.MAX_WEAPONS) {
for (const k of this.availableWeapons) pool.push('weapon:' + k);
}
for (const [k, w] of this.weapons) {
if (w.level < C.MAX_WEAPON_LEVEL) pool.push('weapon:' + k);
}
for (const k of SUBITEM_ORDER) {
if (this.subitems.has(k)) {
if (this.subLevel(k) < C.MAX_SUBITEM_LEVEL) pool.push('sub:' + k);
} else if (this.subitems.size < C.MAX_SUBITEMS) {
pool.push('sub:' + k);
}
}
return sample(pool, Math.min(count, pool.length));
}

/* サブアイテム単独の選択肢（武器候補が尽きたときの原作フォールバック） */
buildSubitemChoice() {
const pool = [];
if (this.subitems.size >= C.MAX_SUBITEMS) {
for (const k of this.subitems.keys()) if (this.subLevel(k) < C.MAX_SUBITEM_LEVEL) pool.push(k);
} else {
for (const k of SUBITEM_ORDER) {
if (!this.subitems.has(k) || this.subLevel(k) < C.MAX_SUBITEM_LEVEL) pool.push(k);
}
}
return pool.length? ['sub:' + pool[Math.floor(Math.random() * pool.length)]]: [];
}

/* 選択の適用（player.py apply_level_choice / apply_subitem_choice）
戻り値は適用したキーの情報 { kind:'weapon'|'sub', key} 。 */
applyChoice(choice) {
const [kind, key] = choice.split(':');
if (kind === 'weapon') {
SaveSystem.recordWeaponSelection(key);
if (this.weapons.has(key)) {
const w = this.weapons.get(key);
const old = w.level;
w.level = old + 1;
WEAPON_DEFS[key].levelUp(w, old);
} else if (this.weapons.size < C.MAX_WEAPONS) {
this.weapons.set(key, createWeapon(key));
this.availableWeapons.delete(key);
} else {
// 枠が満杯で新規武器が選ばれた場合は所持武器をランダム強化（原作挙動）
const keys = [...this.weapons.keys()];
const targetKey = keys[Math.floor(Math.random() * keys.length)];
const w = this.weapons.get(targetKey);
if (w.level < C.MAX_WEAPON_LEVEL) { const old = w.level; w.level = old + 1; WEAPON_DEFS[targetKey].levelUp(w, old);}
}
return { kind, key};
}
// サブアイテム
SaveSystem.recordSubitemSelection(key);
this.applySubitem(key);
return { kind, key};
}

applySubitem(key) {
if (this.subitems.has(key)) {
if (this.subLevel(key) < C.MAX_SUBITEM_LEVEL) this.subitems.set(key, this.subLevel(key) + 1);
} else if (this.subitems.size < C.MAX_SUBITEMS) {
this.subitems.set(key, 1);
} else {
// 枠が満杯で未所持が来た場合は所持品をランダム強化（原作挙動）
const keys = [...this.subitems.keys()];
const k2 = keys[Math.floor(Math.random() * keys.length)];
if (this.subLevel(k2) < C.MAX_SUBITEM_LEVEL) this.subitems.set(k2, this.subLevel(k2) + 1);
return;
}
// HPサブアイテムは最大HP増加分だけ現在HPも増える（player.py の delta 適用）
if (key === 'hp') {
const add = SUBITEM_DEFS.hp.perLevel;
this.hp = Math.min(this.maxHp(), this.hp + Math.round(add));
}
// gem_pickup_range 取得ごとにマグネット出現率倍率 ×1.3（player.py の癖）
if (key === 'gem_pickup_range') {
this.magnetDropRateMultiplier *= 1.3;
}
}

/* ---------------- 移動 (player.py move) ----------------
input: { keys:Set<string>, mouseWorld:{x,y}|null, mouseActive:boolean}
移動は「矢印/WASDキー」+「マウス位置への移動（ボタン押下中のみ原作仕様だが、
本移植ではマウス位置へ常時追随する。PORT_PLAN の操作仕様に準拠）」の合成。
障害物は軸分離で判定し、引っかかった軸だけ止める（原作方式）。 */
move(game, input, dtF) {
let dx = 0, dy = 0;
const k = input.keys;
if (k.has('ArrowLeft') || k.has('KeyA')) dx -= 1;
if (k.has('ArrowRight') || k.has('KeyD')) dx += 1;
if (k.has('ArrowUp') || k.has('KeyW')) dy -= 1;
if (k.has('ArrowDown') || k.has('KeyS')) dy += 1;
const hasKeyboard = dx!== 0 || dy!== 0;

if (input.mouseWorld) {
const mdx = input.mouseWorld.x - this.x;
const mdy = input.mouseWorld.y - this.y;
const dist = Math.hypot(mdx, mdy);
if (dist > this.movementDeadzone) { dx += mdx / dist; dy += mdy / dist;}
}

const len = Math.hypot(dx, dy);
if (len > 0) {
const nx = dx / len, ny = dy / len;
this.movementDx = nx; this.movementDy = ny;
if (Math.abs(nx) > Math.abs(ny)) this.lastDirection = nx > 0? 'right': 'left';
else this.lastDirection = ny > 0? 'down': 'up';
this.facingRight = nx > 0.1? true: (nx < -0.1? false: this.facingRight);

const sp = this.speed();
const stage = game.stage;
const h = Math.floor(this.size / 2);
const testX = this.x + nx * sp * dtF;
if (!stage.cornersBlocked(testX, this.y, h)) this.x = testX;
const testY = this.y + ny * sp * dtF;
if (!stage.cornersBlocked(this.x, testY, h)) this.y = testY;
this.distanceTraveled += Math.hypot(nx * sp * dtF, ny * sp * dtF);
} else {
this.movementDx = 0; this.movementDy = 0;
}
this.x = Math.max(this.size, Math.min(this.x, C.WORLD_WIDTH - this.size));
this.y = Math.max(this.size, Math.min(this.y, C.WORLD_HEIGHT - this.size));
return hasKeyboard;
}
}
if (typeof module!== 'undefined') module.exports = { Player, SUBITEM_DEFS, SUBITEM_ORDER, subitemValue};
