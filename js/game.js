'use strict';
/* ゲームエンジン (game.js)
   元コード対応: main.py のメインループ + core/game_utils.py の初期化。
   役割は「各モジュールを束ねて1フレームを進める」ことだけに絞り、
   個別システムのロジックは player.js / enemies.js / weapons.js /
   items.js / stage.js / ui.js 側に置く（原作 main.py の肥大化への反省）。

   状態遷移: loading → select（初期武器選択）→ playing ⇄ levelup → over / clear
   時計: game.nowMs は playing 中だけ進むゲーム内時計（クールダウン等の基準）。
   位置の単位は px、速度は px/frame（60fps基準。dtF で換算）。 */

/* ---------------- テクスチャ管理 ---------------- */
const Tex = {
  enemies: new Map(),   // image_file -> Texture
  playerFrames: [],     // 16x16 x4フレーム
  icons: new Map(),     // key -> Texture（武器/サブアイテム/アイテム/ボックス）
  weaponSprites: new Map(), // 'axe' | 'rotating_book'
  gems: {},             // colorKey -> Texture（生成）
  circle: null,         // 白円テクスチャ（tintで色付けして使い回す）
};
function loadImageTexture(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(PIXI.Texture.from(img));
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
async function loadTextures() {
  // 敵・ボス画像（CSVに載っている image_file を全部）
  const files = new Set();
  for (const s of GameData.enemyStats.values()) files.add(s.image_file);
  for (const s of GameData.bossStats.values()) files.add(s.image_file);
  await Promise.all([...files].map(async (f) => {
    const t = await loadImageTexture('assets/character/enemy/' + f + '.png');
    if (t) Tex.enemies.set(f, t);
  }));
  // プレイヤー（player_chip.png: 16px幅の4フレーム横並びシート）
  const chip = await loadImageTexture('assets/character/player_chip.png');
  if (chip) {
    for (let i = 0; i < 4; i++) {
      Tex.playerFrames.push(new PIXI.Texture(chip.baseTexture, new PIXI.Rectangle(i * 16, 0, 16, 16)));
    }
  }
  // アイコン類
  const iconNames = [...WEAPON_ORDER, ...SUBITEM_ORDER, 'heal', 'bomb', 'magnet',
    'money1', 'money2', 'money3', 'money4', 'money5', 'box1', 'box2', 'box3', 'box4', 'box5'];
  await Promise.all(iconNames.map(async (n) => {
    const t = await loadImageTexture('assets/icons/' + n + '.png');
    if (t) Tex.icons.set(n, t);
  }));
  for (const n of ['axe', 'rotating_book']) {
    const t = await loadImageTexture('assets/weapons/' + n + '.png');
    if (t) Tex.weaponSprites.set(n, t);
  }
}
/* 図形テクスチャの生成（ジェム・円） */
function generateShapeTextures(renderer) {
  const mk = (draw, w, h) => {
    const g = new PIXI.Graphics();
    draw(g, w, h);
    const t = renderer.generateTexture(g, { region: new PIXI.Rectangle(0, 0, w, h) });
    g.destroy();
    return t;
  };
  Tex.circle = mk((g) => { g.beginFill(0xffffff); g.drawCircle(16, 16, 15); g.endFill(); }, 32, 32);
  const gemColors = { cyan: 0x00ffff, green: 0x00ff00, red: 0xff0000 };
  for (const [key, col] of Object.entries(gemColors)) {
    Tex.gems[key] = mk((g) => {
      g.beginFill(col, 0.95);
      g.drawPolygon([12, 1, 23, 12, 12, 23, 1, 12]); // ひし形
      g.endFill();
    }, 24, 24);
  }
  // 敵弾テクスチャ（原作 EnemyProjectile.draw の多層エフェクトを再現し、色ごとにキャッシュ）
  const addC = (col, amt) => {
    const r = Math.min(255, ((col >> 16) & 255) + amt), g = Math.min(255, ((col >> 8) & 255) + amt), b = Math.min(255, (col & 255) + amt);
    return (r << 16) | (g << 8) | b;
  };
  const mulC = (col, f) => {
    const r = Math.min(255, Math.round(((col >> 16) & 255) * f)), g = Math.min(255, Math.round(((col >> 8) & 255) * f)), b = Math.min(255, Math.round((col & 255) * f));
    return (r << 16) | (g << 8) | b;
  };
  const mkBullet = (col, isBoss) => mk((g) => {
    if (!isBoss) { // 通常弾: 白輪郭＋発光＋本体＋コア＋ハイライト（直径22）
      g.lineStyle(3, 0xffffff, 80 / 255); g.drawCircle(11, 11, 9.5); g.lineStyle(0);
      g.beginFill(addC(col, 80), 80 / 255); g.drawCircle(11, 11, 10); g.endFill();
      g.beginFill(col, 200 / 255); g.drawCircle(11, 11, 9); g.endFill();
      g.beginFill(addC(col, 40), 1); g.drawCircle(11, 11, 5); g.endFill();
      g.beginFill(0xffffff, 200 / 255); g.drawCircle(11, 11, 3); g.endFill();
    } else { // ボス弾: 光輪＋コア＋中心（原作は半径=size で描くため直径48）
      g.beginFill(mulC(col, 0.5), 60 / 255); g.drawCircle(24, 24, 24); g.endFill();
      g.beginFill(col, 180 / 255); g.drawCircle(24, 24, 12); g.endFill();
      g.beginFill(mulC(col, 1.2), 220 / 255); g.drawCircle(24, 24, 8); g.endFill();
    }
  }, isBoss ? 48 : 22, isBoss ? 48 : 22);
  Tex.bullets = new Map();
  for (let type = 1; type <= 4; type++) for (let lv = 1; lv <= 5; lv++) {
    const col = bulletColor(type, lv);
    Tex.bullets.set(col + '|0', mkBullet(col, false));
  }
  Tex.bullets.set(0xffd700 + '|1', mkBullet(0xffd700, true));
}

/* プレイヤーの表示サイズ(px)。当たり判定（Player.size）とは独立。
   2026-11-11 一時 96 にしたが、実描画が 16px だった分と合わせて大きく
   なりすぎたため、浩之様の指定で本来の設定値 48 に戻した。 */
const PLAYER_SPRITE_SIZE = 48;

/* ---------------- ゲーム本体 ---------------- */
const Game = {
  state: 'loading',
  nowMs: 0,            // ゲーム内時計（ms）
  gameTime: 0,         // 経過秒
  fps: 60,
  camera: { x: 0, y: 0 },
  shakeEndMs: -1, shakeIntensity: 0,
  enemies: [], gems: [], items: [], attacks: [],
  enemyGrid: new Map(),
  kills: 0, sessionMoney: 0, totalExpGained: 0,
  damageStats: {},     // 攻撃タイプ別ダメージ（原作 damage_stats）
  enemyKillStats: {},
  pendingLevels: 0,
  _hudItemsDirty: true,

  /* ---------- 初期化 ---------- */
  async boot() {
    UI.init();
    SaveSystem.load();
    AudioSys.init();
    const unlock = () => AudioSys.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    // ドット絵の輪郭を保持する: テクスチャ拡大縮小は全て NEAREST（補間なし）にする
    PIXI.settings.SCALE_MODE = PIXI.SCALE_MODES.NEAREST;
    this.app = new PIXI.Application({ width: C.SCREEN_WIDTH, height: C.SCREEN_HEIGHT, backgroundColor: 0x000000, antialias: false });
    document.getElementById('stage').prepend(this.app.view);
    this.fitToWindow();
    window.addEventListener('resize', () => this.fitToWindow());
    this.initInput();

    try {
      await GameData.loadAll();
      await loadTextures();
    } catch (e) {
      UI.showError('データの読み込みに失敗しました。<br>このゲームはHTTPサーバー経由で開く必要があります（file:// では動作しません）。<br><br>例: <code>python3 -m http.server 8000</code> で起動し、<br>http://localhost:8000/ を開いてください。<br><br>' + e.message);
      return;
    }
    generateShapeTextures(this.app.renderer);
    this.stage = Stage.fromCSV(GameData.mapCsvText);

    // レイヤー構成（奥→手前）: マップ / ジェム・アイテム / ボックス / 敵 / 攻撃 / プレイヤー / 演出
    this.world = new PIXI.Container();
    this.app.stage.addChild(this.world);
    this.mapLayer = this.stage.buildGraphics(this.app.renderer);
    this.world.addChild(this.mapLayer);
    this.itemLayer = new PIXI.Container(); this.world.addChild(this.itemLayer);
    this.boxLayer = new PIXI.Container(); this.world.addChild(this.boxLayer);
    this.enemyLayer = new PIXI.Container(); this.world.addChild(this.enemyLayer);
    this.attackLayer = new PIXI.Container(); this.world.addChild(this.attackLayer);
    this.fxGraphics = new PIXI.Graphics(); this.world.addChild(this.fxGraphics);   // 攻撃・ボスHPバー等の図形描画
    this.playerLayer = new PIXI.Container(); this.world.addChild(this.playerLayer);
    this.particles = new Particles(this.world);
    this.damageNumbers = new DamageNumbers(this.world);

    this.resetGame();
    UI.hideLoading();
    AudioSys.playBgm('level0'); // 選択画面BGM（unlock後に再生開始）
    // 注意: Pixi 7 の Ticker はコールバックへ deltaTime（数値）を渡す。
    // deltaMS はティッカー本体から読むこと（引数を ticker と誤認すると NaN になる）。
    const ticker = this.app.ticker;
    ticker.maxFPS = C.FPS; // フレームレート上限は 60fps（constants の FPS）
    ticker.add(() => this.frame(ticker.deltaMS));
    // デバッグ/検証用フック
    window.__vansurv = this;
  },

  fitToWindow() {
    const s = Math.min(window.innerWidth / C.SCREEN_WIDTH, window.innerHeight / C.SCREEN_HEIGHT);
    document.getElementById('stage').style.transform = 'scale(' + s + ')';
  },

  /* ---------- 入力 ---------- */
  initInput() {
    this.keys = new Set();
    this.mouseScreen = { x: C.SCREEN_WIDTH / 2, y: C.SCREEN_HEIGHT / 2 };
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      this.handleKeyDown(e);
      if (e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('mousemove', (e) => {
      const rect = document.getElementById('stage').getBoundingClientRect();
      this.mouseScreen.x = (e.clientX - rect.left) / rect.width * C.SCREEN_WIDTH;
      this.mouseScreen.y = (e.clientY - rect.top) / rect.height * C.SCREEN_HEIGHT;
    });
  },
  mouseWorld() {
    return { x: this.mouseScreen.x + this.camera.x, y: this.mouseScreen.y + this.camera.y };
  },
  handleKeyDown(e) {
    // メニュー操作（ui/ui.py のキー処理相当）
    if (UI.menu) {
      const mode = UI.menu.mode;
      const cols = mode === 'initial' ? 3 : UI.menu.choices.length;
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') UI.moveSelection(-1, 0);
      else if (e.code === 'ArrowRight' || e.code === 'KeyD') UI.moveSelection(1, 0);
      else if (e.code === 'ArrowUp' || e.code === 'KeyW') UI.moveSelection(0, -1);
      else if (e.code === 'ArrowDown' || e.code === 'KeyS') UI.moveSelection(0, 1);
      else if (e.code === 'Enter' || e.code === 'Space') UI.confirmMenu();
      else if (/^Digit[1-9]$/.test(e.code)) UI.selectIndex(parseInt(e.code.slice(5), 10) - 1);
      return;
    }
    if (UI.endState) {
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') UI.moveEndSelection(-1);
      else if (e.code === 'ArrowRight' || e.code === 'KeyD') UI.moveEndSelection(1);
      else if (e.code === 'Enter') UI.confirmEnd();
    }
  },

  /* ---------- ゲームの開始・リセット ---------- */
  resetGame() {
    // 既存スプライトの破棄
    for (const e of [...this.enemies]) this.removeEnemy(e);
    for (const g of [...this.gems]) this.releaseGemSprite(g);
    for (const it of [...this.items]) this.releaseItemSprite(it);
    for (const a of [...this.attacks]) this.releaseAttackSprite(a);
    if (this.boxManager) for (const b of [...this.boxManager.boxes]) this.releaseBoxSprite(b);
    if (this.player && this.player.sprite) { this.playerLayer.removeChild(this.player.sprite); this.player.sprite.destroy(); }

    this.player = new Player(this.stage);
    this.player.sprite = this.makePlayerSprite();
    this.playerLayer.addChild(this.player.sprite);
    this.enemies = []; this.gems = []; this.items = []; this.attacks = [];
    this.boxManager = new BoxManager(0);
    this.director = new SpawnDirector();
    this.nowMs = 0; this.gameTime = 0;
    this.kills = 0; this.sessionMoney = 0; this.totalExpGained = 0;
    this.damageStats = {}; this.enemyKillStats = {};
    this.pendingLevels = 0;
    this.camera.x = clamp(this.player.x - C.SCREEN_WIDTH / 2, 0, C.WORLD_WIDTH - C.SCREEN_WIDTH);
    this.camera.y = clamp(this.player.y - C.SCREEN_HEIGHT / 2, 0, C.WORLD_HEIGHT - C.SCREEN_HEIGHT);
    this._hudItemsDirty = true;
    this.openInitialWeaponSelect();
  },

  openInitialWeaponSelect() {
    this.state = 'select';
    const choices = WEAPON_ORDER.map((key) => ({
      value: 'weapon:' + key, icon: key,
      title: descName('weapons', key), desc: descText('weapons', key), badge: '',
    }));
    UI.openMenu('initial', '初期武器を選択してください', choices, (value) => {
      this.player.applyChoice(value);
      this._hudItemsDirty = true;
      this.state = 'playing';
      AudioSys.playBgm('level1'); // 原作 main.py は level1 を再生
    });
  },

  /* ---------- スプライト生成・回収 ---------- */
  makePlayerSprite() {
    let spr;
    if (Tex.playerFrames.length) {
      spr = new PIXI.Sprite(Tex.playerFrames[0]);
    } else {
      spr = new PIXI.Sprite(Tex.circle);
      spr.tint = 0x32c850;
    }
    // 表示サイズは PLAYER_SPRITE_SIZE px。倍率は syncSprites で毎フレーム設定する
    // （width 一括指定だと向き反転の scale 上書きで倍率が消えるため）
    spr.width = PLAYER_SPRITE_SIZE; spr.height = PLAYER_SPRITE_SIZE;
    spr.anchor.set(0.5);
    return spr;
  },
  addEnemy(e) {
    const tex = Tex.enemies.get(e.imageFile);
    let spr;
    if (tex) { spr = new PIXI.Sprite(tex); spr.width = e.imageSize; spr.height = e.imageSize; }
    else { spr = new PIXI.Sprite(Tex.circle); spr.width = e.imageSize; spr.height = e.imageSize; spr.tint = e.color; }
    spr.anchor.set(0.5);
    spr.position.set(e.x, e.y);
    e.sprite = spr;
    this.enemyLayer.addChild(spr);
    this.enemies.push(e);
  },
  removeEnemy(e) {
    const i = this.enemies.indexOf(e);
    if (i >= 0) this.enemies.splice(i, 1);
    for (const pr of e.projectiles) this.releaseProjectileSprite(pr);
    for (const pr of e.deadProjectiles || []) this.releaseProjectileSprite(pr);
    if (e.sprite) { this.enemyLayer.removeChild(e.sprite); e.sprite.destroy(); e.sprite = null; }
  },
  releaseProjectileSprite(pr) {
    if (pr.sprite) { this.enemyLayer.removeChild(pr.sprite); pr.sprite.destroy(); pr.sprite = null; }
  },
  spawnGem(x, y, value) {
    const gem = new Gem(x, y, value, this.nowMs);
    this.attachGemSprite(gem);
    this.gems.push(gem);
    enforceGemLimit(this);
    return gem;
  },
  attachGemSprite(gem) {
    const spr = new PIXI.Sprite(Tex.gems[gem.colorKey()]);
    spr.anchor.set(0.5); spr.position.set(gem.x, gem.y);
    gem.sprite = spr;
    this.itemLayer.addChild(spr);
  },
  refreshGemSprite(gem) { if (gem.sprite) gem.sprite.texture = Tex.gems[gem.colorKey()]; },
  releaseGemSprite(gem) {
    if (gem.sprite) { this.itemLayer.removeChild(gem.sprite); gem.sprite.destroy(); gem.sprite = null; }
  },
  addItem(item) {
    if (item instanceof Gem) { this.attachGemSprite(item); this.gems.push(item); enforceGemLimit(this); return; }
    const texName = item.type === 'money' ? item.moneyType : item.type;
    const tex = Tex.icons.get(texName);
    const spr = new PIXI.Sprite(tex || Tex.circle);
    spr.anchor.set(0.5);
    const dispSize = item.type === 'money' ? 32 : 48;
    if (tex) { spr.width = dispSize; spr.height = dispSize; } else { spr.width = 24; spr.height = 24; spr.tint = 0xffff00; }
    spr.position.set(item.x, item.y);
    item.sprite = spr;
    this.itemLayer.addChild(spr);
    if (item.type === 'money') {
      const label = new PIXI.Text(item.amount + 'G', { fontFamily: 'NotoSansJP, sans-serif', fontSize: 12, fill: 0xffd700 });
      label.anchor.set(0.5, 0); label.position.set(item.x, item.y + 16);
      item.label = label;
      this.itemLayer.addChild(label);
    }
    this.items.push(item);
  },
  releaseItemSprite(item) {
    if (item.sprite) { this.itemLayer.removeChild(item.sprite); item.sprite.destroy(); item.sprite = null; }
    if (item.label) { this.itemLayer.removeChild(item.label); item.label.destroy(); item.label = null; }
  },
  attachBoxSprite(box) {
    const tex = Tex.icons.get('box' + box.boxType);
    const spr = new PIXI.Sprite(tex || Tex.circle);
    spr.anchor.set(0.5);
    if (tex) { spr.width = C.BOX_SIZE; spr.height = C.BOX_SIZE; } else { spr.width = C.BOX_SIZE; spr.height = C.BOX_SIZE; spr.tint = 0x8b4513; }
    spr.position.set(box.x, box.y);
    box.sprite = spr;
    this.boxLayer.addChild(spr);
  },
  releaseBoxSprite(box) {
    if (box.sprite) { this.boxLayer.removeChild(box.sprite); box.sprite.destroy(); box.sprite = null; }
  },
  releaseAttackSprite(atk) {
    if (atk.sprite) { this.attackLayer.removeChild(atk.sprite); atk.sprite.destroy(); atk.sprite = null; }
  },
  addAttacks(list) {
    for (const atk of list) {
      atk.spawnedMs = this.nowMs;
      atk.createdMs = this.nowMs;
      // 斧と回転する本は画像スプライトで描く
      if (atk.type === 'axe' || atk.type === 'book') {
        const tex = Tex.weaponSprites.get(atk.type === 'axe' ? 'axe' : 'rotating_book');
        if (tex) {
          const spr = new PIXI.Sprite(tex);
          spr.anchor.set(0.5); spr.width = atk.sizeX; spr.height = atk.sizeY;
          spr.position.set(atk.x, atk.y);
          atk.sprite = spr;
          this.attackLayer.addChild(spr);
        }
      }
      this.attacks.push(atk);
    }
  },

  /* ---------- メインフレーム ---------- */
  frame(deltaMS) {
    const dtMs = Math.min(deltaMS, 50);       // DELTA_TIME_CAP 相当
    const dtF = dtMs / (1000 / 60);            // 60fps基準のフレーム換算
    this.fps = this.fps * 0.95 + (1000 / Math.max(deltaMS, 0.01)) * 0.05;
    if (this.state === 'playing') {
      this.nowMs += dtMs;
      this.gameTime += dtMs / 1000;
      this.update(dtF);
      if (this.gameTime >= C.SURVIVAL_TIME && this.state === 'playing') this.onGameClear();
    }
    this.syncSprites(dtF);
    UI.updateHUD(this);
  },

  update(dtF) {
    const p = this.player;
    // 1) 敵の出現
    this.director.update(this, dtF);
    // 2) プレイヤー移動・自然回復
    p.move(this, { keys: this.keys, mouseWorld: this.mouseWorld() }, dtF);
    p.updateRegen(this);
    // 3) 武器の自動攻撃
    for (const [, w] of p.weapons) {
      const def = WEAPON_DEFS[w.key];
      const news = def.attack(w, this);
      if (news && news.length) this.addAttacks(news);
    }
    // 4) 攻撃の移動と消滅
    for (const atk of [...this.attacks]) {
      updateAttack(atk, this, dtF);
      if (isAttackExpired(atk, this)) { this.releaseAttackSprite(atk); this.attacks.splice(this.attacks.indexOf(atk), 1); }
    }
    // 5) 空間グリッド再構築（敵同士・攻撃判定用）
    this.rebuildGrid();
    // 6) 攻撃の命中判定（ボックス→敵の順。原作 main.py と同じ）
    this.collideAttacksWithBoxes();
    this.collideAttacksWithEnemies();
    // 7) 敵の更新（移動・射撃・弾）
    for (const e of [...this.enemies]) {
      e.update(this, dtF);
      if (e.isBoss) { if (e.isBossOffScreen()) e.respawnNearPlayer(this); }
      else if (e.isOffScreen()) this.removeEnemy(e);
    }
    // 7.5) 画面外の敵の回収・リポップ（一定間隔ごと）
    this.repopTimerSec = (this.repopTimerSec || 0) + dtF / 60;
    if (this.repopTimerSec >= C.OFFSCREEN_REPOP_INTERVAL_SEC) { this.repopTimerSec = 0; this.sweepRepop(); }
    // 8) プレイヤー被弾（接触・敵弾）
    this.collidePlayer();
    if (p.hp <= 0 && this.state === 'playing') { this.onGameOver(); return; }
    // 9) ジェム・アイテム
    this.updatePickups(dtF);
    // 10) ボックス
    this.boxManager.update(this, dtF);
    for (const dropped of this.boxManager.collectDroppedItems()) this.addItem(dropped);
    // 11) 演出
    this.particles.update(dtF);
    this.damageNumbers.update(dtF);
    if (this.nowMs > this.shakeEndMs) this.shakeIntensity = 0;
    // 12) カメラ（プレイヤーへ lerp 追随）
    const tx = clamp(p.x - C.SCREEN_WIDTH / 2, 0, C.WORLD_WIDTH - C.SCREEN_WIDTH);
    const ty = clamp(p.y - C.SCREEN_HEIGHT / 2, 0, C.WORLD_HEIGHT - C.SCREEN_HEIGHT);
    this.camera.x += (tx - this.camera.x) * C.CAMERA_LERP;
    this.camera.y += (ty - this.camera.y) * C.CAMERA_LERP;
  },

  /* 現在の難易度レベル（経過時間帯）での画面付近の敵数上限 */
  onscreenCap() {
    let cap = C.ONSCREEN_CAP_STAGES[0][1];
    for (const [t, c] of C.ONSCREEN_CAP_STAGES) if (this.gameTime >= t) cap = c;
    return cap;
  },
  /* 画面＋マージン内にいる通常敵の数（出現上限の判定用） */
  screenPopulation() {
    const m = C.OFFSCREEN_REPOP_MARGIN, cam = this.camera;
    let n = 0;
    for (const e of this.enemies) {
      if (e.isBoss) continue;
      if (e.x >= cam.x - m && e.x <= cam.x + C.SCREEN_WIDTH + m && e.y >= cam.y - m && e.y <= cam.y + C.SCREEN_HEIGHT + m) n++;
    }
    return n;
  },
  /* 画面外に取り残された敵を回収し、上限に余裕があれば同じ種類を画面端へ再出現させる。
     画面外で固まった敵が溜まり続けるのを防ぐ（2026-11-11 浩之様の指定）。 */
  sweepRepop() {
    const m = C.OFFSCREEN_REPOP_MARGIN, cam = this.camera;
    const inArea = (e) => e.x >= cam.x - m && e.x <= cam.x + C.SCREEN_WIDTH + m && e.y >= cam.y - m && e.y <= cam.y + C.SCREEN_HEIGHT + m;
    let pop = this.screenPopulation();
    const cap = this.onscreenCap();
    for (const e of [...this.enemies]) {
      if (e.isBoss || inArea(e)) continue;
      const no = e.enemyNo;
      this.removeEnemy(e);
      if (no != null && pop < cap) { this.director.respawnAtEdge(this, no); pop++; }
    }
  },

  rebuildGrid() {
    this.enemyGrid.clear();
    const cell = 64;
    for (const e of this.enemies) {
      const key = Math.floor(e.x / cell) + ',' + Math.floor(e.y / cell);
      let arr = this.enemyGrid.get(key);
      if (!arr) { arr = []; this.enemyGrid.set(key, arr); }
      arr.push(e);
    }
  },
  /* グリッドから (x,y) 周辺 radius 内の敵を集める */
  queryEnemies(x, y, radius) {
    const cell = 64, out = [];
    const x0 = Math.floor((x - radius) / cell), x1 = Math.floor((x + radius) / cell);
    const y0 = Math.floor((y - radius) / cell), y1 = Math.floor((y + radius) / cell);
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
      const arr = this.enemyGrid.get(gx + ',' + gy);
      if (arr) out.push(...arr);
    }
    return out;
  },

  /* ---------- 命中判定 ---------- */
  /* 攻撃 vs ボックス（main.py のボックス判定）: 矩形の簡易判定、
     非持続は攻撃ごとに1回、持続（garlic/holy_water）は0.3秒間隔 */
  collideAttacksWithBoxes() {
    const boxes = this.boxManager.getActiveBoxes();
    if (!boxes.length) return;
    for (const atk of [...this.attacks]) {
      if (atk.pending) continue;
      for (const box of boxes) {
        if (box.destroyed) continue;
        const total = atk.size + Math.floor(box.size / 2);
        if (Math.abs(box.x - atk.x) >= total || Math.abs(box.settledY - atk.y) >= total) continue;
        const isPersistent = atk.type === 'garlic' || atk.type === 'holy_water';
        if (!isPersistent) { if (atk.hitBoxes.has(box)) continue; }
        else {
          const last = atk.lastBoxHitTimes.get(box);
          if (last !== undefined && this.gameTime - last < 0.3) continue;
        }
        const destroyed = box.takeDamage(atk.damage || 0, this);
        if (isPersistent) atk.lastBoxHitTimes.set(box, this.gameTime); else atk.hitBoxes.add(box);
        this.particles.burst(box.x, box.settledY, 0xffffff, 1);
        if (destroyed) {
          this.particles.burst(box.x, box.settledY, 0x8b4513, 6);
          for (const dropped of box.itemsDropped.splice(0)) this.addItem(dropped);
        }
        if (atk.type === 'magic_wand') { this.releaseAttackSprite(atk); this.attacks.splice(this.attacks.indexOf(atk), 1); }
        if (atk.type !== 'stone' && atk.type !== 'magic_wand') break;
        if (atk.type === 'magic_wand') break;
      }
    }
  },

  /* 攻撃 vs 敵（main.py の敵判定）: 矩形判定 dx<r かつ dy<r（r=攻撃半径+敵サイズ）。
     ダメージは ±10% のランダム、ノックバック、持続攻撃は間隔管理。
     magic_wand はヒットで消滅、stone は貫通、その他は攻撃ごとに敵1体まで。 */
  collideAttacksWithEnemies() {
    for (const atk of [...this.attacks]) {
      if (atk.pending) continue;
      const candidates = this.queryEnemies(atk.x, atk.y, atk.size + 64);
      for (const e of candidates) {
        if (!this.enemies.includes(e)) continue; // 既に倒された敵
        const r = atk.size + e.size;
        if (Math.abs(e.x - atk.x) >= r || Math.abs(e.y - atk.y) >= r) continue;
        const isPersistent = atk.type === 'garlic' || atk.type === 'holy_water';
        if (!isPersistent) { if (atk.hitTargets.has(e)) continue; }
        else {
          const interval = atk.type === 'garlic' ? C.GARLIC_DAMAGE_INTERVAL_MS / 1000 : C.HOLY_WATER_DAMAGE_INTERVAL_MS / 1000;
          const last = atk.lastHitTimes.get(e);
          if (last !== undefined && this.gameTime - last < interval) continue;
        }
        // ダメージ適用（±10%）
        const dmg = Math.max(0, atk.damage * randFloat(0.9, 1.1));
        e.hp -= dmg;
        AudioSys.playSound('enemy_hurt');
        e.applyKnockback(atk.x, atk.y, C.KNOCKBACK_FORCES[atk.type] || 50.0);
        if (isPersistent) atk.lastHitTimes.set(e, this.gameTime); else atk.hitTargets.add(e);
        this.damageStats[atk.type] = (this.damageStats[atk.type] || 0) + dmg;
        this.damageNumbers.spawn(e.x, e.y - e.size - 6, dmg);
        this.particles.burst(e.x, e.y, e.color, 2);
        e.onHit();
        // ガーリックの吸収回復（攻撃ごとに500ms間隔で1回復）
        if (atk.type === 'garlic' && this.nowMs - atk.lastGarlicHealTime >= C.GARLIC_HEAL_INTERVAL_MS) {
          const healed = this.player.heal(this.player.garlicHealAmount(), 'garlic');
          if (healed > 0) AudioSys.playSound('heal');
          atk.lastGarlicHealTime = this.nowMs;
        }
        if (e.hp <= 0) this.killEnemy(e, false);
        if (atk.type === 'magic_wand') {
          this.releaseAttackSprite(atk);
          this.attacks.splice(this.attacks.indexOf(atk), 1);
          break;
        }
        if (atk.type !== 'stone') break; // stone のみ貫通して次へ
      }
    }
  },

  /* 敵の死亡処理（game_logic.handle_enemy_death）:
     ドロップ抽選 heal 0.5% / bomb 0.2% / magnet（プレイヤー倍率）/ それ以外はジェム。
     ボスは追加で box4 を落とし、画面揺れが発生する。 */
  killEnemy(e, byBomb) {
    this.particles.deathBurst(e.x, e.y, e.color);
    if (!byBomb) {
      this.kills += 1;
      this.sessionMoney += C.MONEY_PER_ENEMY_KILLED;
      const nk = e.isBoss ? ('boss' + e.bossNo) : String(e.enemyNo);
      this.enemyKillStats[nk] = (this.enemyKillStats[nk] || 0) + 1;
    }
    if (e.isBoss) {
      this.activateShake();
      AudioSys.playSound('bomb');
      const box = new ItemBox(e.x, e.y, 4, this.nowMs);
      this.boxManager.boxes.push(box);
      this.attachBoxSprite(box);
      this.particles.spawnBurst(e.x, e.y, 0xff6464, 12);
      UI.showBanner('ボス撃破！');
    }
    if (byBomb) {
      this.spawnGem(e.x, e.y, 1);
    } else {
      const roll = Math.random();
      if (roll < C.HEAL_ITEM_DROP_RATE) { this.addItem(new GameItem(e.x, e.y, 'heal', this.nowMs)); AudioSys.playSound('item_drop'); }
      else if (roll < C.HEAL_ITEM_DROP_RATE + C.BOMB_ITEM_DROP_RATE) this.addItem(new GameItem(e.x, e.y, 'bomb', this.nowMs));
      else if (roll < C.HEAL_ITEM_DROP_RATE + C.BOMB_ITEM_DROP_RATE + this.player.magnetDropRate()) this.addItem(new GameItem(e.x, e.y, 'magnet', this.nowMs));
      else this.spawnGem(e.x, e.y, 1);
    }
    this.removeEnemy(e);
  },

  /* ボム取得時の効果（game_logic.handle_bomb_item_effect）: 全敵へ100ダメージ。
     ボムで倒した敵はジェムのみ（撃破数・お金の加算なし＝原作の同関数の挙動） */
  bombEffect() {
    this.activateShake();
    AudioSys.playSound('bomb');
    for (const e of [...this.enemies]) {
      e.hp -= 100;
      if (e.hp <= 0) this.killEnemy(e, true);
    }
  },
  activateShake() {
    this.shakeEndMs = this.nowMs + C.SCREEN_SHAKE_DURATION_MS;
    this.shakeIntensity = C.SCREEN_SHAKE_INTENSITY;
  },

  /* プレイヤー vs 敵・敵弾（main.py の接触判定）: 矩形判定、回避抽選、
     ダメージ = max(1, int(敵ダメージ - 防御))、被弾で通常無敵を付与 */
  collidePlayer() {
    const p = this.player;
    const pHalf = Math.floor(p.size / 2);
    // 接触
    for (const e of this.queryEnemies(p.x, p.y, 96)) {
      const eHalf = Math.floor(e.size / 2);
      if (Math.abs(p.x - e.x) < pHalf + eHalf && Math.abs(p.y - e.y) < pHalf + eHalf) {
        if (!p.canTakeDamage(this)) continue;
        if (Math.random() < p.avoidance()) {
          this.particles.burst(p.x, p.y, 0x00ffff, 3);
          continue;
        }
        p.hp -= Math.max(1, Math.floor(e.damage - p.defense()));
        p.setNormalInvincible(this);
        AudioSys.playSound('player_hurt');
        this.particles.burst(p.x, p.y, 0xff4040, 4);
        break; // 1フレーム1回まで
      }
    }
    // 敵弾
    for (const e of this.enemies) {
      for (const pr of [...e.projectiles]) {
        const prHalf = Math.floor(pr.size / 2);
        if (Math.abs(p.x - pr.x) < pHalf + prHalf && Math.abs(p.y - pr.y) < pHalf + prHalf) {
          const idx = e.projectiles.indexOf(pr);
          if (idx >= 0) e.projectiles.splice(idx, 1);
          this.releaseProjectileSprite(pr);
          if (!p.canTakeDamage(this)) continue;
          if (Math.random() < p.avoidance()) { this.particles.burst(p.x, p.y, 0x00ffff, 3); continue; }
          p.hp -= Math.max(1, Math.floor(pr.damage - p.defense()));
          p.setNormalInvincible(this);
          AudioSys.playSound('player_hurt');
          this.particles.burst(p.x, p.y, 0xff4040, 4);
        }
      }
    }
  },

  /* ジェム・アイテムの更新と取得（main.py の取得処理）
     引き寄せ開始距離 = BASE_ATTRACTION_DISTANCE + 回収範囲。
     取得距離 = プレイヤー半径 + アイテム半径。 */
  updatePickups(dtF) {
    const p = this.player;
    const pHalf = Math.floor(p.size / 2);
    const attractRange = C.BASE_ATTRACTION_DISTANCE + p.gemPickupRange();
    const attract2 = attractRange * attractRange;
    let collectedGems = 0;

    for (const gem of [...this.gems]) {
      if (gem.isExpired(this) && !gem.beingAttracted) { this.releaseGemSprite(gem); this.gems.splice(this.gems.indexOf(gem), 1); continue; }
      gem.moveToPlayer(this);
      if (gem.sprite) gem.sprite.position.set(gem.x, gem.y);
      const d2 = dist2(p, gem);
      if (d2 < attract2) gem.beingAttracted = true;
      const pickup = pHalf + Math.floor(gem.size / 2);
      if (d2 < pickup * pickup) {
        this.releaseGemSprite(gem);
        this.gems.splice(this.gems.indexOf(gem), 1);
        collectedGems++;
        this.totalExpGained += gem.value;
        const leveled = p.addExp(gem.value);
        if (leveled) {
          this.sessionMoney += C.MONEY_PER_LEVEL_BONUS;
          this.pendingLevels += 1;
          this.particles.burst(p.x, p.y, 0x00ffff, 12);
        }
      }
    }
    if (collectedGems > 0) AudioSys.playSound('gem_pickup', 0.1);

    for (const item of [...this.items]) {
      item.moveToPlayer(this);
      if (item.sprite) {
        const bob = item.type === 'money' ? Math.sin((item.animTime = (item.animTime || 0) + 0.1 * dtF)) * 2 : 0;
        item.sprite.position.set(item.x, item.y + bob);
        if (item.label) item.label.position.set(item.x, item.y + bob + 16);
      }
      const d2 = dist2(p, item);
      if (d2 < attract2) item.beingAttracted = true;
      const pickup = pHalf + Math.floor(item.size / 2);
      if (d2 < pickup * pickup) {
        this.releaseItemSprite(item);
        this.items.splice(this.items.indexOf(item), 1);
        if (item.type === 'heal') {
          const healed = p.heal(C.HEAL_ITEM_AMOUNT, 'item');
          if (healed > 0) { AudioSys.playSound('heal'); this.particles.burst(p.x, p.y, 0x40ff40, 6); }
        } else if (item.type === 'bomb') this.bombEffect();
        else if (item.type === 'magnet') { p.activateMagnet(this); AudioSys.playSound('powerup'); }
        else if (item.type === 'money') {
          this.sessionMoney += item.amount;
          this.particles.burst(item.x, item.y, 0xffd700, 3);
        }
      }
    }

    // レベルアップ選択へ（ゲームを止めてメニューを開く）
    if (this.pendingLevels > 0 && this.state === 'playing') {
      this.pendingLevels -= 1;
      this.openLevelUpMenu();
    }
  },

  openLevelUpMenu() {
    this.state = 'levelup';
    AudioSys.playSound('powerup');
    let choices = this.player.buildLevelUpChoices(3);
    if (!choices.length) choices = this.player.buildSubitemChoice();
    if (!choices.length) { this.state = 'playing'; return; }
    const cards = choices.map((value) => {
      const [kind, key] = value.split(':');
      if (kind === 'weapon') {
        const owned = this.player.weapons.get(key);
        return {
          value, icon: key, title: descName('weapons', key), desc: descText('weapons', key),
          badge: owned ? 'Lv' + owned.level + ' → Lv' + (owned.level + 1) : 'NEW!',
        };
      }
      const lv = this.player.subLevel(key);
      return {
        value, icon: key, title: descName('subitems', key), desc: descText('subitems', key),
        badge: lv ? 'Lv' + lv + ' → Lv' + (lv + 1) : 'NEW!',
      };
    });
    UI.openMenu('levelup', 'レベルアップ！', cards, (value) => {
      this.player.applyChoice(value);
      this._hudItemsDirty = true;
      this.state = 'playing';
      if (this.pendingLevels > 0) { this.pendingLevels -= 1; this.openLevelUpMenu(); }
    });
  },

  /* ---------- 終了処理 ---------- */
  bankAndRecord(clearBonus) {
    // 原作: 終了時に「セッション獲得 + 生存秒×5（+クリアボーナス1000）」を加算して保存
    this.sessionMoney += clearBonus;
    SaveSystem.addMoney(this.sessionMoney + Math.floor(this.gameTime) * C.MONEY_PER_SURVIVAL_SECOND);
    SaveSystem.recordGameEnd(this.gameTime, this.player.level, this.kills, this.player.exp);
    SaveSystem.recordWeaponUsage(this.damageStats);
    SaveSystem.checkAchievements();
    SaveSystem.save();
  },
  endStats(clear, clearBonus) {
    const nameOf = (t) => descName('weapons', t === 'book' ? 'rotating_book' : t);
    const rows = Object.entries(this.damageStats).sort((a, b) => b[1] - a[1]).map(([t, d]) => [nameOf(t), d]);
    return {
      clear, timeSec: Math.floor(this.gameTime), level: this.player.level, kills: this.kills,
      sessionMoney: this.sessionMoney, survivalBonus: Math.floor(this.gameTime) * C.MONEY_PER_SURVIVAL_SECOND,
      clearBonus, damageRows: rows,
    };
  },
  onGameOver() {
    this.state = 'over';
    AudioSys.playSound('player_hurt');
    UI.openEndScreen(this.endStats(false, 0), (action) => {
      if (action === 'continue') {
        // コンティニュー: 100Gを支払い、全回復＋3秒無敵で再開（MONEY_CONTINUE_COST）
        let cost = C.MONEY_CONTINUE_COST;
        const fromSession = Math.min(cost, this.sessionMoney);
        this.sessionMoney -= fromSession; cost -= fromSession;
        if (cost > 0) SaveSystem.spendMoney(cost);
        this.player.hp = this.player.maxHp();
        this.player.setSpecialInvincible(this, 3.0);
        this.state = 'playing';
      } else {
        this.bankAndRecord(0);
        this.resetGame();
      }
    });
  },
  onGameClear() {
    this.state = 'clear';
    UI.showBanner('GAME CLEAR!');
    UI.openEndScreen(this.endStats(true, C.MONEY_GAME_CLEAR_BONUS), () => {
      this.bankAndRecord(C.MONEY_GAME_CLEAR_BONUS);
      this.resetGame();
    });
  },

  /* ---------- 描画同期 ---------- */
  syncSprites(dtF) {
    const p = this.player;
    if (!p || !p.sprite) return;
    // ワールドの平行移動（カメラ＋画面揺れ）
    let shX = 0, shY = 0;
    if (this.shakeIntensity > 0) {
      const remain = Math.max(0, this.shakeEndMs - this.nowMs);
      const ratio = remain / C.SCREEN_SHAKE_DURATION_MS;
      const inten = this.shakeIntensity * ratio;
      shX = randFloat(-inten, inten); shY = randFloat(-inten, inten);
    }
    this.world.position.set(-Math.round(this.camera.x + shX), -Math.round(this.camera.y + shY));

    // プレイヤー（歩行フレーム切替・無敵点滅・向き反転）
    const spr = p.sprite;
    spr.position.set(p.x, p.y);
    if (Tex.playerFrames.length) {
      const moving = p.movementDx !== 0 || p.movementDy !== 0;
      if (moving && this.state === 'playing') {
        p.animTick += dtF;
        if (p.animTick >= 6) { p.animTick = 0; p.frameIndex = (p.frameIndex + 1) % Tex.playerFrames.length; }
      } else p.frameIndex = 0;
      spr.texture = Tex.playerFrames[p.frameIndex];
    }
    // 倍率と向きは毎フレームここで決める（width 指定だけだと反転で倍率が消える）。
    // 向きは原作準拠: 基準フレームは左向きで、右移動時に水平反転する。
    const frameW = (spr.texture.frame && spr.texture.frame.width) || 16;
    const mag = PLAYER_SPRITE_SIZE / frameW;
    spr.scale.x = (p.facingRight ? -1 : 1) * mag;
    spr.scale.y = mag;
    spr.visible = !(p.isInvincible(this) && this.state === 'playing' && Math.floor(this.nowMs / 200) % 2 === 0);

    // 消滅した敵弾のスプライト解放（敵の可視状態に依らず毎フレーム処理する）
    for (const e of this.enemies) {
      if (!e.deadProjectiles.length) continue;
      for (const pr of e.deadProjectiles) this.releaseProjectileSprite(pr);
      e.deadProjectiles.length = 0;
    }

    // 敵（歩行アニメ: 上下±1px・左右スウェイ・回転。原作 constants の値）
    const camL = this.camera.x - C.DRAWING_MARGIN, camR = this.camera.x + C.SCREEN_WIDTH + C.DRAWING_MARGIN;
    const camT = this.camera.y - C.DRAWING_MARGIN, camB = this.camera.y + C.SCREEN_HEIGHT + C.DRAWING_MARGIN;
    for (const e of this.enemies) {
      if (!e.sprite) continue;
      const visible = e.x >= camL && e.x <= camR && e.y >= camT && e.y <= camB;
      e.sprite.visible = visible;
      if (!visible) continue;
      let bobY = 0, swayX = 0, rot = 0;
      if (C.ENABLE_ENEMY_WALK_ANIMATION && e.isMoving) {
        bobY = Math.sin(e.animationTime * C.ENEMY_WALK_BOB_SPEED) > 0 ? 1 : -1;
        swayX = Math.sin(e.animationTime * C.ENEMY_WALK_SWAY_SPEED) * C.ENEMY_WALK_SWAY_AMPLITUDE;
        rot = Math.sin(e.animationTime * C.ENEMY_WALK_ROTATION_SPEED) * C.ENEMY_WALK_ROTATION_AMPLITUDE * Math.PI / 180;
      }
      e.sprite.position.set(e.x + swayX, e.y + bobY);
      e.sprite.rotation = rot;
      const baseScaleX = e.imageSize / (e.sprite.texture.width || e.imageSize);
      // 向きは原作準拠: 基準画像は左向き（'left'）で、右移動時は反転画像（'right'）を使う。
      // 符号が逆だと移動方向と逆を向く（2026-11-11 浩之様の指摘で修正）。
      e.sprite.scale.x = (e.facingRight ? -1 : 1) * Math.abs(baseScaleX);
      e.sprite.blendMode = e.hitFlashTimer > 0 ? PIXI.BLEND_MODES.ADD : PIXI.BLEND_MODES.NORMAL;
      // 敵の弾
      for (const pr of e.projectiles) {
        if (!pr.sprite) {
          const tex = (Tex.bullets && Tex.bullets.get(pr.color + '|' + (pr.isBossBullet ? 1 : 0))) || Tex.circle;
          const s = new PIXI.Sprite(tex);
          s.anchor.set(0.5); s.width = pr.drawSize; s.height = pr.drawSize;
          pr.sprite = s;
          this.enemyLayer.addChild(s);
          if (pr.createdMs < 0) pr.createdMs = this.nowMs;
        }
        pr.sprite.position.set(pr.x, pr.y);
      }
    }
    // ボックス
    if (this.boxManager) {
      for (const b of this.boxManager.boxes) {
        if (!b.sprite) continue;
        const floatY = b.isDropping ? 0 : Math.sin(b.floatTime) * 3;
        b.sprite.position.set(b.x, b.y + floatY);
        b.sprite.blendMode = b.hitFlashTimer > 0 ? PIXI.BLEND_MODES.ADD : PIXI.BLEND_MODES.NORMAL;
      }
    }
    this.drawAttackFx();
    this.particles.draw();
  },

  /* 攻撃の図形描画（斧・本以外）とボスHPバー */
  drawAttackFx() {
    const g = this.fxGraphics;
    g.clear();
    for (const atk of this.attacks) {
      if (atk.pending) continue;
      if (atk.sprite) { // 斧・本
        atk.sprite.position.set(atk.x, atk.y);
        if (atk.type === 'axe') atk.sprite.rotation = atk.angle;
        continue;
      }
      switch (atk.type) {
        case 'whip': {
          const pts = atk.renderPoints;
          if (pts && pts.length > 1) {
            g.lineStyle(Math.max(2, atk.width || 6), 0x8b4513, 0.9);
            g.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
            g.lineStyle(Math.max(1, Math.floor((atk.width || 6) / 3)), 0xdeb887, 0.9);
            g.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
            g.lineStyle(0);
          }
          break;
        }
        case 'garlic':
          g.beginFill(0xff3030, 0.18); g.drawCircle(atk.x, atk.y, atk.sizeX / 2); g.endFill();
          g.lineStyle(2, 0xff6060, 0.6); g.drawCircle(atk.x, atk.y, atk.sizeX / 2); g.lineStyle(0);
          break;
        case 'holy_water':
          g.beginFill(0x1e8cc8, 0.4); g.drawCircle(atk.x, atk.y, atk.size); g.endFill();
          g.lineStyle(2, 0x50b4e6, 0.5); g.drawCircle(atk.x, atk.y, atk.size * 0.7); g.lineStyle(0);
          break;
        case 'magic_wand':
          if (atk.trail) {
            for (const [tx, ty] of atk.trail) { g.beginFill(0xb060ff, 0.35); g.drawCircle(tx, ty, 4); g.endFill(); }
          }
          g.beginFill(0xd090ff, 0.95); g.drawCircle(atk.x, atk.y, 6); g.endFill();
          break;
        case 'stone':
          if (atk.trail) {
            for (const [tx, ty] of atk.trail) { g.beginFill(0xaaaaaa, 0.3); g.drawCircle(tx, ty, 5); g.endFill(); }
          }
          g.beginFill(0x999999, 1); g.drawCircle(atk.x, atk.y, atk.sizeX / 2); g.endFill();
          g.lineStyle(1, 0x555555, 1); g.drawCircle(atk.x, atk.y, atk.sizeX / 2); g.lineStyle(0);
          break;
        case 'knife': {
          const ang = Math.atan2(atk.velocityY || 0, atk.velocityX || 1);
          const len = 14, wid = 4;
          const cos = Math.cos(ang), sin = Math.sin(ang);
          g.beginFill(0xf0f0f0, 1);
          g.drawPolygon([
            atk.x + cos * len, atk.y + sin * len,
            atk.x - sin * wid - cos * 4, atk.y + cos * wid - sin * 4,
            atk.x + sin * wid - cos * 4, atk.y - cos * wid - sin * 4,
          ]);
          g.endFill();
          break;
        }
        case 'thunder': {
          if (!atk.struck) {
            g.lineStyle(3, 0xffe95e, 0.8);
            g.moveTo(atk.x, atk.strikeFromY !== null && atk.strikeFromY !== undefined ? atk.strikeFromY : atk.y - 120);
            g.lineTo(atk.x, atk.y);
            g.lineStyle(0);
          } else {
            g.beginFill(0xffe95e, 0.3); g.drawCircle(atk.x, atk.y, atk.size); g.endFill();
            g.lineStyle(4, 0xfff6a0, 0.95);
            let lx = atk.x, ly = atk.y - atk.size - 60;
            g.moveTo(lx, ly);
            for (let i = 0; i < 4; i++) { lx = atk.x + randFloat(-8, 8); ly += (atk.size + 60) / 4; g.lineTo(lx, ly); }
            g.lineStyle(0);
          }
          break;
        }
      }
    }
    // ボスHPバー（敵の頭上）
    for (const e of this.enemies) {
      if (!e.isBoss || !e.sprite || !e.sprite.visible) continue;
      const w = Math.max(48, e.imageSize), h = 6;
      const x = e.x - w / 2, y = e.y - e.imageSize / 2 - 14;
      g.beginFill(0xc80000); g.drawRect(x, y, w, h); g.endFill();
      g.beginFill(0x00c800); g.drawRect(x, y, w * Math.max(0, e.hp / e.maxHp), h); g.endFill();
      g.lineStyle(1, 0xffffff, 0.9); g.drawRect(x, y, w, h); g.lineStyle(0);
      // ボスの赤オーラ
      g.lineStyle(3, 0xff3232, 0.45); g.drawCircle(e.x, e.y, e.size + 6); g.lineStyle(0);
    }
    // ボックスHPバー（ダメージ時のみ）
    if (this.boxManager) {
      for (const b of this.boxManager.boxes) {
        if (b.destroyed || b.hp >= b.maxHp) continue;
        const w = 48, h = 5, x = b.x - w / 2, y = b.y - C.BOX_SIZE / 2 - 10;
        g.beginFill(0xc80000); g.drawRect(x, y, w, h); g.endFill();
        g.beginFill(0x00c800); g.drawRect(x, y, w * Math.max(0, b.hp / b.maxHp), h); g.endFill();
      }
    }
  },
};

/* 補助 */
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function descName(section, key) {
  const d = GameData.descriptions;
  return (d && d[section] && d[section][key] && d[section][key].name) || key;
}
function descText(section, key) {
  const d = GameData.descriptions;
  return (d && d[section] && d[section][key] && d[section][key].description) || '';
}

window.addEventListener('DOMContentLoaded', () => Game.boot());
if (typeof module !== 'undefined') module.exports = { Game, Tex };
