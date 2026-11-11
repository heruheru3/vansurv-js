'use strict';
/* アイテムモジュール (items.js)
元コード対応: effects/items.py（ExperienceGem / GameItem / MoneyItem）、
ui/box.py（ItemBox / BoxManager）、effects/particles.py（各種パーティクル）。


- 新しいドロップアイテム: GameItem の type を増やし、game.js の取得時処理に対応を追加。
- お金の金額帯: constants.js の MONEY_TIERS と BOX_MONEY_RATES が表データ。 */

/* 金額からアイコン種別を決める（items.py _get_money_type_by_amount） */
function moneyTypeByAmount(amount) {
if (amount <= 10) return 'money1';
if (amount <= 50) return 'money2';
if (amount <= 200) return 'money3';
if (amount <= 1000) return 'money4';
return 'money5';
}
/* 通常ドロップ用: MONEY_TIERS の出現率で金額を生成 */
function generateRandomMoneyAmount() {
let r = Math.random(), acc = 0;
for (const [min, max, rate] of C.MONEY_TIERS) {
acc += rate;
if (r < acc) return randInt(min, max);
}
const last = C.MONEY_TIERS[C.MONEY_TIERS.length - 1];
return randInt(last[0], last[1]);
}
/* ボックス用: BOX_MONEY_RATES[boxType] の表で金額帯を選び、その帯の範囲で生成 */
function generateMoneyAmountByBoxType(boxType) {
const table = C.BOX_MONEY_RATES[boxType];
if (!table) return generateRandomMoneyAmount();
let r = Math.random(), acc = 0;
for (const [tier, rate] of table) {
acc += rate;
if (r < acc) { const [min, max] = C.MONEY_TIERS[tier - 1]; return randInt(min, max);}
}
const [tier] = table[table.length - 1];
const [min, max] = C.MONEY_TIERS[tier - 1];
return randInt(min, max);
}

/* ---------------- 経験値ジェム (effects/items.py ExperienceGem) ---------------- */
class Gem {
constructor(x, y, value = 1, nowMs = 0) {
this.x = x; this.y = y;
this.type = 'experience';
this.size = 8;
this.speed = 6; // 引き寄せ速度 px/frame
this.value = Math.max(1, Math.floor(value));
this.beingAttracted = false; // 範囲内に入ると main 側で true になる（原作方式）
this.spawnMs = nowMs;
this.baseLifetime = 30000; // 30秒
this.extendedLifetime = 0; // 回収範囲サブアイテムで延長
this.sprite = null;
}
/* 引き寄せ移動（items.py move_to_player）。マグネット中は全域から×3速 */
moveToPlayer(game) {
const p = game.player;
const dx = p.x - this.x, dy = p.y - this.y;
const distance = Math.hypot(dx, dy);
const extra = p.gemPickupRange();
if (extra > 0 && this.extendedLifetime === 0) {
this.extendedLifetime = Math.floor((extra / 100.0) * 5000);
}
const magnet = p.isMagnetActive(game);
const shouldAttract = this.beingAttracted || magnet;
if (shouldAttract && distance!== 0) {
const speed = this.speed * p.gemCollectionSpeed() * (magnet? C.MAGNET_FORCE_MULTIPLIER: 1.0);
this.x += (dx / distance) * speed;
this.y += (dy / distance) * speed;
}
}
isExpired(game) {
return (game.nowMs - this.spawnMs) > (this.baseLifetime + this.extendedLifetime);
}
/* 色は value で決まる（1=シアン, 2-5=緑, 6+=赤） */
colorKey() { return this.value === 1? 'cyan': (this.value <= 5? 'green': 'red');}
}

/* ---------------- フィールドアイテム (heal / bomb / magnet) ---------------- */
class GameItem {
constructor(x, y, type, nowMs = 0) {
this.x = x; this.y = y;
this.type = type; // 'heal' | 'bomb' | 'magnet'
this.size = 12;
this.speed = 2;
this.beingAttracted = false;
this.spawnMs = nowMs;
this.sprite = null;
}
moveToPlayer(game) {
const p = game.player;
const dx = p.x - this.x, dy = p.y - this.y;
const distance = Math.hypot(dx, dy);
// 特殊アイテムはマグネット効果では引き寄せられない（being_attracted のみ）
if (this.beingAttracted && distance!== 0) {
const speed = this.speed * p.gemCollectionSpeed();
this.x += (dx / distance) * speed;
this.y += (dy / distance) * speed;
}
}
}

/* ---------------- お金アイテム (MoneyItem) ---------------- */
class MoneyItem {
constructor(x, y, opts = {}) {
this.x = x; this.y = y;
this.type = 'money';
this.size = 10;
this.speed = 3;
if (opts.amount!== undefined && opts.amount!== null) this.amount = Math.max(1, Math.floor(opts.amount));
else if (opts.boxType) this.amount = generateMoneyAmountByBoxType(opts.boxType);
else this.amount = generateRandomMoneyAmount();
this.moneyType = moneyTypeByAmount(this.amount);
this.beingAttracted = false;
this.spawnMs = opts.nowMs || 0;
this.animTime = Math.random() * Math.PI * 2;
this.sprite = null; this.label = null;
}
moveToPlayer(game) {
const p = game.player;
const dx = p.x - this.x, dy = p.y - this.y;
const distance = Math.hypot(dx, dy);
const magnet = p.isMagnetActive(game);
const shouldAttract = this.beingAttracted || magnet;
if (shouldAttract && distance!== 0) {
const speed = this.speed * p.gemCollectionSpeed() * (magnet? C.MAGNET_FORCE_MULTIPLIER: 1.0);
this.x += (dx / distance) * speed;
this.y += (dy / distance) * speed;
}
}
}

/* ジェム上限の適用（game_utils.enforce_experience_gems_limit）:
上限超過分は「最も遠いジェム」を削除し、その value を「最も近いジェム」に合算する */
function enforceGemLimit(game) {
const gems = game.gems, p = game.player;
while (gems.length > C.MAX_GEMS_ON_SCREEN) {
let farIdx = 0, farD = -1, nearIdx = 0, nearD = Infinity;
for (let i = 0; i < gems.length; i++) {
const d = dist2(p, gems[i]);
if (!gems[i].beingAttracted && d > farD) { farD = d; farIdx = i;}
if (d < nearD) { nearD = d; nearIdx = i;}
}
const removed = gems.splice(farIdx, 1)[0];
game.releaseGemSprite(removed);
if (gems.length) {
const target = gems[Math.min(nearIdx, gems.length - 1)] || gems[gems.length - 1];
target.value += removed.value;
game.refreshGemSprite(target);
}
}
}

/* ---------------- アイテムボックス (ui/box.py ItemBox) ---------------- */
class ItemBox {
constructor(x, y, boxType = null, nowMs = 0) {
this.x = x;
this.finalY = y;
this.y = y - 80; // 落下アニメーション: 80px上空から
this.size = C.BOX_COLLISION_SIZE;
this.displaySize = C.BOX_SIZE;
if (boxType === null || boxType === undefined) {
const r = Math.random();
this.boxType = r < C.BOX1_SPAWN_RATE? 1: (r < C.BOX1_SPAWN_RATE + C.BOX2_SPAWN_RATE? 2: 3);
} else {
this.boxType = Math.max(1, Math.min(4, Math.floor(boxType)));
}
this.hp = C.BOX_HP[this.boxType];
this.maxHp = this.hp;
this.destroyed = false;
this.isDropping = true;
this.spawnMs = nowMs;
this.dropDuration = 300;
this.itemsDropped = [];
this.floatTime = Math.random() * Math.PI * 2;
this.hitFlashTimer = 0;
this.sprite = null; this.hpBar = null;
}
get settledY() { return this.finalY;}
update(game, dtF) {
if (this.isDropping) {
const t = Math.min(1, (game.nowMs - this.spawnMs) / this.dropDuration);
this.y = (this.finalY - 80) + 80 * t;
if (t >= 1) {
this.isDropping = false; this.y = this.finalY;
// 着地時の砂埃（原作 ui/box.py の DustParticle）
const dustColors = [0x8b795e, 0xa08c73, 0x655543, 0xb8a68b];
for (let i = 0; i < 12; i++) {
game.particles.add(this.x + randFloat(-20, 20), this.finalY + 10 + randFloat(-5, 5),
{ color: dustColors[i % dustColors.length], speed: randFloat(0.5, 1.5), life: randInt(48, 90), size: randInt(2, 4) });
}
}
}
this.floatTime += (dtF / 60) * 2.0;
if (this.hitFlashTimer > 0) this.hitFlashTimer = Math.max(0, this.hitFlashTimer - dtF / 60);
}
/* ダメージを受け、破壊されたら true（box.py take_damage） */
takeDamage(damage, game) {
if (this.destroyed) return false;
this.hp -= damage;
this.hitFlashTimer = 0.3;
if (this.hp <= 0) { this.destroy(game); return true;}
return false;
}
destroy(game) {
if (this.destroyed) return;
this.destroyed = true;
AudioSys.playSound('box_break');
this.dropItems(game);
}
/* 中身の決定（box.py drop_items）。player のマグネットレベルで box2 の確率が変わる */
dropItems(game) {
const p = game.player;
const dropX = this.x, dropY = this.finalY;
let items = [];
if (this.boxType === 1) {
items.push(new MoneyItem(dropX, dropY, { boxType: 1, nowMs: game.nowMs}));
} else if (this.boxType === 2) {
const magnetLevel = p? p.magnetLevel(): 0;
const magnetBonus = magnetLevel > 0? magnetLevel * 0.05: 0.0;
const totalOther = C.BOX2_HEAL_RATE + C.BOX2_BOMB_RATE + C.BOX2_MAGNET_RATE;
const adjHeal = C.BOX2_HEAL_RATE * (1 - (totalOther > 0? magnetBonus / totalOther: 0));
const adjBomb = C.BOX2_BOMB_RATE * (1 - (totalOther > 0? magnetBonus / totalOther: 0));
if (Math.random() < C.BOX2_COIN_RATE) {
items.push(new MoneyItem(dropX, dropY, { boxType: 2, nowMs: game.nowMs}));
} else {
const remaining = 1.0 - C.BOX2_COIN_RATE;
const healTh = adjHeal / remaining;
const bombTh = healTh + adjBomb / remaining;
const r = Math.random();
if (r < healTh) items.push(new GameItem(dropX, dropY, 'heal', game.nowMs));
else if (r < bombTh) items.push(new GameItem(dropX, dropY, 'bomb', game.nowMs));
else items.push(new GameItem(dropX, dropY, 'magnet', game.nowMs));
}
} else if (this.boxType === 3) {
const r = Math.random();
if (r < C.BOX3_MONEY_RATE) items.push(new MoneyItem(dropX, dropY, { boxType: 3, nowMs: game.nowMs}));
else if (r < C.BOX3_MONEY_RATE + C.BOX3_HEAL_RATE) items.push(new GameItem(dropX, dropY, 'heal', game.nowMs));
else if (r < C.BOX3_MONEY_RATE + C.BOX3_HEAL_RATE + C.BOX3_BOMB_RATE) items.push(new GameItem(dropX, dropY, 'bomb', game.nowMs));
else items.push(new GameItem(dropX, dropY, 'magnet', game.nowMs));
} else if (this.boxType === 4) {
// ボス専用のレア箱: 経験値ジェム(value50)×3 + 高額お金 + レアアイテム（box.py の特別処理）
for (let i = 0; i < 3; i++) items.push(new Gem(dropX, dropY, 50, game.nowMs));
items.push(new MoneyItem(dropX, dropY, { amount: randInt(C.MONEY_TIERS[3][0], C.MONEY_TIERS[3][1]), nowMs: game.nowMs}));
items.push(new GameItem(dropX, dropY, ['heal', 'bomb', 'magnet'][randInt(0, 2)], game.nowMs));
}
// 周囲に散らす（20〜50px）
for (const item of items) {
const ang = randFloat(0, Math.PI * 2);
const d = randFloat(20, this.boxType === 4? 50: 40);
item.x += Math.cos(ang) * d;
item.y += Math.sin(ang) * d;
}
this.itemsDropped = items;
}
isFarFromPlayer(p) {
return Math.abs(this.x - p.x) > C.SCREEN_WIDTH / 2 + 800 || Math.abs(this.y - p.y) > C.SCREEN_HEIGHT / 2 + 800;
}
}

/* ---------------- ボックス管理 (ui/box.py BoxManager) ---------------- */
class BoxManager {
constructor(nowMs = 0) {
this.boxes = [];
this.lastSpawnMs = nowMs;
this.nextSpawnInterval = randInt(C.BOX_SPAWN_INTERVAL_MIN, C.BOX_SPAWN_INTERVAL_MAX);
}
update(game, dtF) {
for (const b of this.boxes) b.update(game, dtF);
const kept = [];
for (const b of this.boxes) {
if (b.destroyed || b.isFarFromPlayer(game.player)) {
if (b.sprite) game.releaseBoxSprite(b);
continue;
}
kept.push(b);
}
this.boxes = kept;
if (game.nowMs - this.lastSpawnMs >= this.nextSpawnInterval) {
this.spawnNearPlayer(game);
this.lastSpawnMs = game.nowMs;
this.nextSpawnInterval = randInt(C.BOX_SPAWN_INTERVAL_MIN, C.BOX_SPAWN_INTERVAL_MAX);
}
}
spawnNearPlayer(game) {
const p = game.player;
for (let tries = 0; tries < 20; tries++) {
const ang = randFloat(0, Math.PI * 2);
const dist = randFloat(200, 400);
const x = Math.max(50, Math.min(C.WORLD_WIDTH - 50, p.x + Math.cos(ang) * dist));
const y = Math.max(50, Math.min(C.WORLD_HEIGHT - 50, p.y + Math.sin(ang) * dist));
if (game.stage.cornersBlocked(x, y, Math.floor(C.BOX_COLLISION_SIZE / 2))) continue;
let tooClose = false;
for (const b of this.boxes) {
const dx = x - b.x, dy = y - b.finalY;
if (dx * dx + dy * dy < 100 * 100) { tooClose = true; break;}
}
if (tooClose) continue;
const box = new ItemBox(x, y, null, game.nowMs);
this.boxes.push(box);
game.attachBoxSprite(box);
break;
}
}
getActiveBoxes() { return this.boxes.filter(b =>!b.destroyed &&!b.isDropping);}
/* 破壊済みボックスからの中身を回収する（box.py get_all_dropped_items） */
collectDroppedItems() {
const out = [];
for (const b of this.boxes) {
if (b.destroyed && b.itemsDropped.length) { out.push(...b.itemsDropped); b.itemsDropped = [];}
}
return out;
}
}

/* ---------------- パーティクル (effects/particles.py の簡易統合版) ----------------
描画は1つの PIXI.Graphics への一括描画で行う（高速化）。
種類: 死亡破片・スポーン・回復・被弾フラッシュ・回避などを色と大きさで表現。 */
class Particles {
constructor(container) {
this.list = [];
this.graphics = new PIXI.Graphics();
container.addChild(this.graphics);
}
add(x, y, opts = {}) {
if (this.list.length > C.PARTICLE_LIMIT) this.list = this.list.slice(-C.PARTICLE_TRIM_TO);
const ang = randFloat(0, Math.PI * 2);
const speed = opts.speed!== undefined? opts.speed: randFloat(0.5, 2.5);
this.list.push({
x, y,
vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
life: 0, maxLife: opts.life || randInt(20, 40), // frames
color: opts.color!== undefined? opts.color: 0xffffff,
size: opts.size || 3,
});
}
burst(x, y, color, count, size = 3) { for (let i = 0; i < count; i++) this.add(x, y, { color, size});}
deathBurst(x, y, color) { this.burst(x, y, color, 4);} // main.py は死亡時4個
spawnBurst(x, y, color = 0xffffff, count = 1) { this.burst(x, y, color, count, 2);}
update(dtF) {
const kept = [];
for (const pt of this.list) {
pt.life += dtF;
pt.x += pt.vx * dtF; pt.y += pt.vy * dtF;
if (pt.life < pt.maxLife) kept.push(pt);
}
this.list = kept;
}
draw() {
const g = this.graphics;
g.clear();
for (const pt of this.list) {
const a = 1 - pt.life / pt.maxLife;
g.beginFill(pt.color, a);
g.drawCircle(pt.x, pt.y, pt.size * a + 0.5);
g.endFill();
}
}
}

/* ---------------- ダメージ数字 (effects/particles.py DamageNumber) ----------------
PIXI.Text のプールで再利用する。色は main.py の規則:
10以下=白、それ以上は白→赤へグラデーション。 */
class DamageNumbers {
constructor(container) {
this.container = container;
this.pool = [];
this.active = [];
}
spawn(x, y, value) {
let t = this.pool.pop();
if (!t) {
if (this.active.length >= 48) return;
t = new PIXI.Text('', { fontFamily: 'NotoSansJP, sans-serif', fontSize: 16, fill: 0xffffff, fontWeight: 'bold'});
t.anchor.set(0.5, 1);
this.container.addChild(t);
}
const v = Math.floor(value);
t.text = String(v);
if (v <= 10) t.tint = 0xffffff;
else {
const tt = Math.min(1, Math.max(0, (v - 10) / 40));
const gg = Math.round(255 - 215 * tt);
t.tint = (255 << 16) | (gg << 8) | gg;
}
t.position.set(x + randFloat(-6, 6), y);
t.alpha = 1; t.visible = true;
this.active.push({ t, life: 0, maxLife: 45});
}
update(dtF) {
const kept = [];
for (const d of this.active) {
d.life += dtF;
d.t.position.y -= 0.7 * dtF;
d.t.alpha = 1 - d.life / d.maxLife;
if (d.life < d.maxLife) kept.push(d);
else { d.t.visible = false; this.pool.push(d.t);}
}
this.active = kept;
}
}
if (typeof module!== 'undefined') module.exports = { Gem, GameItem, MoneyItem, ItemBox, BoxManager, Particles, DamageNumbers, enforceGemLimit, moneyTypeByAmount};
