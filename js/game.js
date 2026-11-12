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
  playerSilhouettes: [],// プレイヤー各フレームの白シルエット（被弾/回避フラッシュ用）
  icons: new Map(),     // key -> Texture（武器/サブアイテム/アイテム/ボックス）
  weaponSprites: new Map(), // 'axe' | 'rotating_book'
  gems: {},             // colorKey -> Texture（生成）
  circle: null,         // 白円テクスチャ（tintで色付けして使い回す）
};
function loadImageTexture(src) {
  // 配信側が src を実URLへ差し替える前に 1x1 の透明ピクセルを一時設定する
  // 環境（スペース）では、その load で確定させると実画像が二度と読めない。
  // 実寸（naturalWidth/Height > 1）になるまで確定させず、load イベントと
  // ポーリングの両方で監視し、一過性の error では確定させない（上限10秒で
  // null にフォールバックし、起動は止めない）。通常環境では即時に完了する。
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    let iv = null;
    let to = null;
    const finish = (tex) => {
      if (done) return;
      done = true;
      if (iv) clearInterval(iv);
      if (to) clearTimeout(to);
      img.onload = null;
      resolve(tex);
    };
    const check = () => {
      if (img.naturalWidth > 1 && img.naturalHeight > 1) finish(PIXI.Texture.from(img));
    };
    img.onload = check;
    img.onerror = () => { /* 差し替え中の一過性 error では確定しない */ };
    iv = setInterval(check, 250);
    to = setTimeout(() => finish(null), 10000);
    img.src = src;
    check(); // キャッシュ済みで即時完了している場合
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
    // 被弾/回避フラッシュ用の白シルエット。元ドットの不透明ピクセルだけを
    // 白で塗りつぶすので、tint してもドットの外へ色がはみ出さない。
    const src = chip.baseTexture.resource.source;
    for (let i = 0; i < 4; i++) {
      const cv = document.createElement('canvas');
      cv.width = 16; cv.height = 16;
      const ctx = cv.getContext('2d');
      ctx.drawImage(src, i * 16, 0, 16, 16, 0, 0, 16, 16);
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 16, 16);
      const t = PIXI.Texture.from(cv);
      t.baseTexture.scaleMode = PIXI.SCALE_MODES.NEAREST;
      Tex.playerSilhouettes.push(t);
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
      // 原作 ExperienceGem.draw の構成（24x24, 中心12, ひし形半径 r=4）:
      // 同心円グロー（外側ほど薄く）＋本体＋上部ハイライト＋暗い輪郭
      const bright = (amt) => {
        const r = Math.min(255, ((col >> 16) & 255) + amt), gg = Math.min(255, ((col >> 8) & 255) + amt), b = Math.min(255, (col & 255) + amt);
        return (r << 16) | (gg << 8) | b;
      };
      for (let i = 12; i >= 1; i--) {
        const t = i / 12;
        g.beginFill(col, (10 + (1 - t) * 180) / 255);
        g.drawCircle(12, 12, t * 8.8);
        g.endFill();
      }
      g.beginFill(col, 240 / 255);
      g.drawPolygon([12, 8, 16, 12, 12, 16, 8, 12]); // 本体ひし形
      g.endFill();
      g.beginFill(bright(80), 140 / 255);
      g.drawPolygon([12, 8, 14, 11.2, 12, 12.8, 10, 11.2]); // ハイライト（上面）
      g.endFill();
      g.lineStyle(1, 0x000000, 100 / 255);
      g.drawPolygon([12, 8, 16, 12, 12, 16, 8, 12]); // 輪郭
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
    UI.syncSeButton(); // 保存済みの SE ON/OFF をボタン表示へ反映
    UI.syncBgmButton(); // 保存済みの BGM ON/OFF をボタン表示へ反映
    const unlock = () => AudioSys.unlock();
    // iOS Safari でユーザー操作として認められるのは touchend/click/keydown/
    // pointerup（touchstart/pointerdown だけでは音声のアンロックが完了しない）。
    // AudioSys.unlock は呼ばれるたびにアンロック完了まで試み続ける
    for (const ev of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
      window.addEventListener(ev, unlock);
    }

    // ドット絵の輪郭を保持する: テクスチャ拡大縮小は全て NEAREST（補間なし）にする
    PIXI.settings.SCALE_MODE = PIXI.SCALE_MODES.NEAREST;
    this.app = new PIXI.Application({ width: window.innerWidth, height: window.innerHeight, backgroundColor: 0x000000, antialias: false });
    document.getElementById('stage').prepend(this.app.view);
    this.zoom = this.initialZoom(); // 初期ズームは画面の短辺基準で算出
    this.applyViewSize();
    window.addEventListener('resize', () => this.applyViewSize());
    window.addEventListener('orientationchange', () => this.applyViewSize());
    if (window.visualViewport) window.visualViewport.addEventListener('resize', () => this.applyViewSize());
    this.initInput();

    // ステージ定義（js/stages.js）: ステージ = マップ + 敵呼び出しルールのセット
    this.stageDef = StageDefs[StageDefs.current] || StageDefs.stage1;
    this.applyStageDef();

    try {
      await GameData.loadAll(this.stageDef);
      await loadTextures();
      // 初登場の瞬間にテクスチャ転送でフレームが止まらないよう、敵・ボス画像は
      // 起動時にまとめてGPUへ載せておく（従来は初登場時に1枚ずつ転送されていた）
      try { for (const t of Tex.enemies.values()) this.app.renderer.texture.updateTexture(t); } catch (e) { /* 失敗しても従来動作 */ }
    } catch (e) {
      UI.showError('データの読み込みに失敗しました。<br>このゲームはHTTPサーバー経由で開く必要があります（file:// では動作しません）。<br><br>例: <code>python3 -m http.server 8000</code> で起動し、<br>http://localhost:8000/ を開いてください。<br><br>' + e.message);
      return;
    }
    generateShapeTextures(this.app.renderer);
    this.stage = Stage.fromCSV(GameData.mapCsvText);
    // ワールド寸法はマップ（ステージ）から決まる
    C.WORLD_WIDTH = this.stage.width * C.TILE_SIZE;
    C.WORLD_HEIGHT = this.stage.height * C.TILE_SIZE;

    // レイヤー構成（奥→手前）: マップ / ジェム・アイテム / ボックス / 敵 / 攻撃 / プレイヤー / 演出
    this.world = new PIXI.Container();
    this.world.scale.set(this.zoom);
    this.app.stage.addChild(this.world);
    this.mapLayer = this.stage.buildGraphics(this.app.renderer);
    this.world.addChild(this.mapLayer);
    this.itemLayer = new PIXI.Container(); this.world.addChild(this.itemLayer);
    this.boxLayer = new PIXI.Container(); this.world.addChild(this.boxLayer);
    this.enemyLayer = new PIXI.Container(); this.world.addChild(this.enemyLayer);
    this.attackLayer = new PIXI.Container(); this.world.addChild(this.attackLayer);
    this.fxGraphics = new PIXI.Graphics(); this.world.addChild(this.fxGraphics);   // 攻撃・ボスHPバー等の図形描画
    this.playerLayer = new PIXI.Container(); this.world.addChild(this.playerLayer);
    // プレイヤー足元の影（プレイヤーだけに付ける）。プレイヤースプライトより先に
    // 追加して、必ずドットの下へ描かれるようにする。
    this.playerShadow = new PIXI.Graphics();
    this.playerShadow.beginFill(0x000000, 0.25);
    this.playerShadow.drawEllipse(0, 0, PLAYER_SPRITE_SIZE * 0.30, PLAYER_SPRITE_SIZE * 0.085);
    this.playerShadow.endFill();
    this.playerLayer.addChild(this.playerShadow);
    this.particles = new Particles(this.world);
    this.damageNumbers = new DamageNumbers(this.world);
    this.avoidFx = []; // 回避演出（フラッシュ＋テキスト）の進行中リスト
    this.avoidTextPool = [];
    this.playerFlashFx = []; // 被弾/回避のプレイヤーシルエットフラッシュ
    this.ringFx = []; // 汎用リングフラッシュ（被弾・ボス撃破）の進行中リスト
    this.textFx = []; // 汎用フローティングテキスト（回復・レベルアップ）の進行中リスト
    this.textPools = new Map();

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

  /* 画面解像度＝ウインドウサイズ（2026-11-11 浩之様の指定）:
     縦画面なら縦画面、正方形なら正方形、そのままの形で遊べる。
     C.SCREEN_WIDTH/HEIGHT を実サイズへ更新すると、カメラ・ミニマップ枠
     など表示系のロジックが追従する（敵の出現範囲はポップエリア基準で、
     表示範囲には追従しない）。 */

  /* ステージ定義（js/stages.js）を実行時定数 C へ流し込む。
     ステージ時間・出現ペース・画面内上限はステージ側の設定であり、
     エンジン側は従来どおり C を参照する（ステージ切替時はここで差し替わる） */
  applyStageDef() {
    const def = this.stageDef;
    if (!def) return;
    if (def.survivalTime) C.SURVIVAL_TIME = def.survivalTime;
    const s = def.spawn || {};
    if (s.intervalStartFrames) C.SPAWN_INTERVAL_START_FRAMES = s.intervalStartFrames;
    if (s.intervalMinFrames) C.SPAWN_INTERVAL_MIN_FRAMES = s.intervalMinFrames;
    if (s.intervalStepSec) C.SPAWN_INTERVAL_STEP_SEC = s.intervalStepSec;
    if (s.batchStepSec) C.SPAWN_BATCH_STEP_SEC = s.batchStepSec;
    if (s.capStages) C.POP_CAP_STAGES = s.capStages;
    if (s.maxEnemies) C.MAX_ENEMIES_ON_SCREEN = s.maxEnemies;
    if (s.popAreaTiles) C.POP_AREA_TILES = s.popAreaTiles;
  },

  /* ズームの下限: 静的な ZOOM_MIN と「表示範囲の長辺がポップエリア
     （POP_AREA_TILES マス）を超えない」条件の、大きい方。
     最もカメラを引いても長辺が 64 マスを超えて見えることはない */
  zoomMin() {
    const vv = window.visualViewport;
    const w = vv ? vv.width : window.innerWidth;
    const h = vv ? vv.height : window.innerHeight;
    const longSide = Math.max(w || 0, h || 0);
    if (!longSide) return C.ZOOM_MIN;
    return Math.max(C.ZOOM_MIN, longSide / (C.POP_AREA_TILES * C.TILE_SIZE));
  },

  /* 敵のポップ有効エリア（ワールド座標の矩形）: プレイヤー中心の
     POP_AREA_TILES × POP_AREA_TILES マス。出現・上限判定・回収は
     すべてこの矩形が基準で、カメラやズームには依存しない */
  popAreaRect() {
    const half = C.POP_AREA_TILES * C.TILE_SIZE / 2;
    const p = this.player;
    return { left: p.x - half, top: p.y - half, right: p.x + half, bottom: p.y + half };
  },

  /* 初期ズーム: 画面の短辺の 1/PLAYER_SIZE_DIVISOR がプレイヤーの画面上
     サイズ（PLAYER_SPRITE_SIZE × zoom）になる倍率。リサイズでは再計算
     しない（初期状態のバランス付けが目的で、途中の画角は保つ） */
  initialZoom() {
    const vv = window.visualViewport;
    const w = vv ? vv.width : window.innerWidth;
    const h = vv ? vv.height : window.innerHeight;
    const short = Math.min(w || 0, h || 0);
    if (!short) return C.ZOOM_DEFAULT;
    const z = short / (PLAYER_SPRITE_SIZE * C.PLAYER_SIZE_DIVISOR);
    return Math.max(this.zoomMin(), Math.min(C.ZOOM_MAX, z));
  },

  applyViewSize() {
    // iPhone Safari のツールバー表示/非表示で実際に見える範囲が変わるため、
    // visualViewport（見えている領域そのもの）を優先する
    const vv = window.visualViewport;
    const w = Math.round(vv ? vv.width : window.innerWidth);
    const h = Math.round(vv ? vv.height : window.innerHeight);
    // ウインドウが広がって下限が上がった場合は、ズームもそこまで引き上げる
    if (this.zoom && this.zoom < this.zoomMin()) this.zoom = this.zoomMin();
    const z = this.zoom || C.ZOOM_DEFAULT;
    // C.SCREEN_* は「見えているワールド範囲（ワールド座標単位）」。
    // ズームを掛けると同じウインドウでより広い／狭い範囲が見える
    C.SCREEN_WIDTH = Math.round(w / z); C.SCREEN_HEIGHT = Math.round(h / z);
    if (this.app) this.app.renderer.resize(w, h);
    if (this.world) this.world.scale.set(z);
    if (typeof UI !== 'undefined' && UI.layoutResultStage) UI.layoutResultStage();
  },

  /* ズーム変更（PC: ホイール / スマホ: ピンチ）。カメラはプレイヤー中心に
     追従するので、拡縮は自然にプレイヤーを中心に行われる */
  setZoom(z) {
    const nz = Math.max(this.zoomMin(), Math.min(C.ZOOM_MAX, z));
    if (nz === this.zoom) return;
    // ズームの軸を画面中心に保つ: 変更前の表示中心（ワールド座標）を控え、
    // 新しい表示範囲でも同じ点が中心に来るようカメラを即座に移す。
    // 追従 lerp に任せると、左上へ飛んでから中心へ戻るブレが出る
    const hasCam = !!this.camera;
    const cx = hasCam ? this.camera.x + C.SCREEN_WIDTH / 2 : 0;
    const cy = hasCam ? this.camera.y + C.SCREEN_HEIGHT / 2 : 0;
    this.zoom = nz;
    this.applyViewSize();
    if (hasCam) {
      this.camera.x = clamp(cx - C.SCREEN_WIDTH / 2, 0, C.WORLD_WIDTH - C.SCREEN_WIDTH);
      this.camera.y = clamp(cy - C.SCREEN_HEIGHT / 2, 0, C.WORLD_HEIGHT - C.SCREEN_HEIGHT);
    }
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
    // ズーム（PC）: プレイ中のホイールで拡大・縮小
    window.addEventListener('wheel', (e) => {
      if (this.state !== 'playing' || (typeof UI !== 'undefined' && UI.menu)) return;
      this.setZoom((this.zoom || C.ZOOM_DEFAULT) * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
      e.preventDefault();
    }, { passive: false });
    this.initTouchControls();
  },

  /* タッチ操作: 1本指=バーチャルパッド（触れた位置を中心にパッドが出て、
     ドラッグした方向へ移動できるフローティング式）、2本指=ピンチでズーム。
     メニュー等のオーバーレイ表示中はそちらがタッチを受けるので干渉しない。 */
  initTouchControls() {
    this.padId = null; this.padOx = 0; this.padOy = 0; this.padVec = null;
    this.touches = new Map(); // identifier -> {x, y}
    this.pinchDist = 0;
    this.vpadEl = document.getElementById('vpad');
    this.vpadKnob = document.getElementById('vpad-knob');
    const view = this.app.view;
    const hidePad = () => { this.padId = null; this.padVec = null; this.vpadEl.style.display = 'none'; };
    this._hidePad = hidePad;
    view.addEventListener('touchstart', (e) => {
      for (const t of e.changedTouches) this.touches.set(t.identifier, { x: t.clientX, y: t.clientY });
      if (this.state !== 'playing') return;
      this.touchUsed = true; // 以後はマウス追随を無効化（タッチ端末では意味がないため）
      if (this.touches.size === 2) {
        // 2本目が触れたらピンチ開始: パッドは解除する
        hidePad();
        const [a, b] = [...this.touches.values()];
        this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      } else if (this.touches.size === 1 && this.padId === null) {
        const t = e.changedTouches[0];
        this.padId = t.identifier; this.padOx = t.clientX; this.padOy = t.clientY;
        this.padVec = null;
        this.vpadEl.style.left = t.clientX + 'px';
        this.vpadEl.style.top = t.clientY + 'px';
        this.vpadKnob.style.transform = 'translate(0px, 0px)';
        this.vpadEl.style.display = 'block';
      }
      e.preventDefault();
    }, { passive: false });
    view.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (this.touches.has(t.identifier)) this.touches.set(t.identifier, { x: t.clientX, y: t.clientY });
      }
      if (this.touches.size === 2 && this.pinchDist > 0) {
        const [a, b] = [...this.touches.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 0) { this.setZoom((this.zoom || C.ZOOM_DEFAULT) * (d / this.pinchDist)); this.pinchDist = d; }
        e.preventDefault();
        return;
      }
      if (this.padId === null) return;
      for (const t of e.changedTouches) {
        if (t.identifier !== this.padId) continue;
        const vx = t.clientX - this.padOx, vy = t.clientY - this.padOy;
        const len = Math.hypot(vx, vy);
        const cl = Math.min(len, 40);
        this.vpadKnob.style.transform = 'translate(' + (len ? vx / len * cl : 0) + 'px, ' + (len ? vy / len * cl : 0) + 'px)';
        this.padVec = len > 10 ? { x: vx / len, y: vy / len } : null;
        e.preventDefault();
      }
    }, { passive: false });
    const endTouch = (e) => {
      for (const t of e.changedTouches) {
        this.touches.delete(t.identifier);
        if (t.identifier === this.padId) hidePad();
      }
      if (this.touches.size < 2) this.pinchDist = 0;
      e.preventDefault();
    };
    view.addEventListener('touchend', endTouch, { passive: false });
    view.addEventListener('touchcancel', endTouch, { passive: false });
  },
  mouseWorld() {
    return { x: this.mouseScreen.x + this.camera.x, y: this.mouseScreen.y + this.camera.y };
  },
  handleKeyDown(e) {
    // ESC: プレイ中はポーズ、ポーズ中は再開（原作 main.py の ESC 強制終了相当）
    if (e.code === 'Escape' || e.key === 'Escape') {
      if (this.state === 'playing' && !UI.menu && !UI.endState) { this.pauseGame(); return; }
      if (this.state === 'paused') { this.resumeGame(); return; }
    }
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
    // 進行中のプレイヤーシルエットフラッシュを破棄（前のプレイヤー位置に残さない）
    if (this.playerFlashFx) {
      for (const fx of this.playerFlashFx) {
        if (fx.s.parent) fx.s.parent.removeChild(fx.s);
        fx.s.destroy();
      }
      this.playerFlashFx.length = 0;
    }
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
    this.applyStageDef(); // 出現ペースはステージ定義から（ディレクター生成前に適用）
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
      AudioSys.playBgm(this.stageDef.bgm || 'level1'); // BGMはステージ定義から
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
    // 出現した瞬間からプレイヤーの方を向く（2026-11-11 浩之様の指定。
    // 以前は初期値の右向き固定で、動き出すまで逆を向いていることがあった）
    if (this.player) e.facingRight = this.player.x >= e.x;
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
    p.move(this, { keys: this.keys, mouseWorld: this.touchUsed ? null : this.mouseWorld(), padVec: this.padVec }, dtF);
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
    this.collideAttacksWithProjectiles();
    // 7) 敵の更新（移動・射撃・弾）
    for (const e of [...this.enemies]) {
      e.update(this, dtF);
      if (e.isBoss) { if (e.isBossOffScreen()) e.respawnNearPlayer(this); }
      else if (e.isOffScreen()) this.removeEnemy(e);
    }
    // 7.5) 画面外の敵の回収・リポップ（一定間隔ごと）
    this.repopTimerSec = (this.repopTimerSec || 0) + dtF / 60;
    if (this.repopTimerSec >= C.POP_REPOP_INTERVAL_SEC) { this.repopTimerSec = 0; this.sweepRepop(); }
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
    this.updateAvoidanceFx(dtF);
    this.updatePlayerFlashFx(dtF);
    this.updateRingFx(dtF);
    this.updateTextFx(dtF);
    this.damageNumbers.update(dtF);
    if (this.nowMs > this.shakeEndMs) this.shakeIntensity = 0;
    // 12) カメラ（プレイヤーへ lerp 追随）
    const tx = clamp(p.x - C.SCREEN_WIDTH / 2, 0, C.WORLD_WIDTH - C.SCREEN_WIDTH);
    const ty = clamp(p.y - C.SCREEN_HEIGHT / 2, 0, C.WORLD_HEIGHT - C.SCREEN_HEIGHT);
    this.camera.x += (tx - this.camera.x) * C.CAMERA_LERP;
    this.camera.y += (ty - this.camera.y) * C.CAMERA_LERP;
  },

  /* 現在の難易度レベル（経過時間帯）でのポップエリア内の敵数上限 */
  popCap() {
    let cap = C.POP_CAP_STAGES[0][1];
    for (const [t, c] of C.POP_CAP_STAGES) if (this.gameTime >= t) cap = c;
    return cap;
  },
  /* ポップエリア＋マージン内にいる通常敵の数（出現上限の判定用） */
  popPopulation() {
    const m = C.POP_REPOP_MARGIN, a = this.popAreaRect();
    let n = 0;
    for (const e of this.enemies) {
      if (e.isBoss) continue;
      if (e.x >= a.left - m && e.x <= a.right + m && e.y >= a.top - m && e.y <= a.bottom + m) n++;
    }
    return n;
  },
  /* ポップエリア外に取り残された敵を回収し、上限に余裕があれば同じ種類をエリア端へ再出現させる。
     エリア外で固まった敵が溜まり続けるのを防ぐ（2026-11-11 浩之様の指定）。 */
  sweepRepop() {
    const m = C.POP_REPOP_MARGIN, a = this.popAreaRect();
    const inArea = (e) => e.x >= a.left - m && e.x <= a.right + m && e.y >= a.top - m && e.y <= a.bottom + m;
    let pop = this.popPopulation();
    const cap = this.popCap();
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

  /* 攻撃 vs 敵弾（main.py の迎撃判定）: 通常敵の弾はプレイヤーの攻撃に当たると
     黄色いエフェクトと共に消える（攻撃自体は消えない）。ボスの弾は相殺不可。 */
  collideAttacksWithProjectiles() {
    if (!this.attacks.length) return;
    for (const e of this.enemies) {
      if (!e.projectiles.length) continue;
      for (const pr of [...e.projectiles]) {
        if (pr.isBossBullet) continue; // ボス弾は消せない
        const prHalf = Math.floor(pr.size / 2);
        for (const atk of this.attacks) {
          if (atk.pending) continue;
          const atkHalf = Math.floor(atk.size / 2);
          if (Math.abs(atk.x - pr.x) < atkHalf + prHalf && Math.abs(atk.y - pr.y) < atkHalf + prHalf) {
            e.projectiles.splice(e.projectiles.indexOf(pr), 1);
            this.releaseProjectileSprite(pr);
            this.particles.burst(pr.x, pr.y, 0xffff64, 4); // 迎撃エフェクト（原作 DeathParticle 黄）
            break;
          }
        }
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
          if (healed > 0) { AudioSys.playSound('heal'); this.spawnHealFx(healed, 'garlic'); }
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
      // 原作 BossDeathEffect（紫の粒子がリング状に拡散、寿命60〜120f）＋
      // BossDeathFlash（黄色い円が半径130→220へ拡大しながら消える）
      for (let i = 0; i < 44; i++) {
        const a = (Math.PI * 2 * i) / 44, d = randFloat(10, 50);
        this.particles.add(e.x + Math.cos(a) * d, e.y + Math.sin(a) * d,
          { color: 0x7814ff, speed: randFloat(1, 3), life: randInt(60, 120), size: randInt(2, 4) });
      }
      this.spawnRingFx(e.x, e.y, 0xc8c800, 16, 130, 220, 90 / 255);
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
      if (roll < C.HEAL_ITEM_DROP_RATE) { this.addItem(new GameItem(e.x, e.y, 'heal', this.nowMs)); } // ドロップ音は鳴らさない（2026-11-11 浩之様の指定）
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

  /* 回避成功時の演出（原作 effects/particles.py の AvoidanceParticle + LuckyText）:
     プレイヤーのドット絵シルエットを青く光らせ（18フレーム、α最大150）、
     頭上にシアンの「Lukey!」が20フレーム上昇表示（フェードイン4f／フェードアウト6f） */
  spawnAvoidanceFx() {
    const p = this.player;
    this.spawnPlayerFlashFx(0x0000ff, 18, 150 / 255);
    let t = this.avoidTextPool.pop();
    if (!t) {
      t = new PIXI.Text('Lukey!', { fontFamily: 'NotoSansJP, sans-serif', fontSize: 14, fill: 0x00ffff, fontWeight: 'bold' });
      t.anchor.set(0.5, 1);
      this.world.addChild(t);
    }
    t.position.set(p.x, p.y - p.size - 6);
    t.alpha = 0; t.visible = true;
    this.avoidFx.push({ t, life: 0 });
  },
  updateAvoidanceFx(dtF) {
    const kept = [];
    for (const fx of this.avoidFx) {
      fx.life += dtF;
      if (fx.life >= 20) {
        fx.t.visible = false;
        this.avoidTextPool.push(fx.t);
      } else {
        fx.t.position.y -= 0.5 * dtF;
        const remain = 20 - fx.life;
        fx.t.alpha = fx.life < 4 ? fx.life / 4 : (remain < 6 ? remain / 6 : 1);
        kept.push(fx);
      }
    }
    this.avoidFx = kept;
  },

  /* 被弾/回避フラッシュ: プレイヤーの現在フレームと同じ白シルエットを tint して
     ドットの形のまま重ねる（円スプライトは使わない）。ドットの透明部分には
     色が乗らないため、シルエットの外へ赤/青がはみ出さない。
     プレイヤーに追従し、αだけをフレーム数に応じてフェードアウトする。 */
  spawnPlayerFlashFx(color, durationFrames, alpha0) {
    if (!Tex.playerSilhouettes.length) return;
    const p = this.player;
    const s = new PIXI.Sprite(Tex.playerSilhouettes[p.frameIndex] || Tex.playerSilhouettes[0]);
    s.anchor.set(0.5);
    s.tint = color;
    s.alpha = alpha0;
    s.position.set(p.x, p.y);
    const fw = (s.texture.frame && s.texture.frame.width) || 16;
    const mag = PLAYER_SPRITE_SIZE / fw;
    s.scale.x = (p.facingRight ? -1 : 1) * mag;
    s.scale.y = mag;
    this.playerLayer.addChild(s);
    this.playerFlashFx.push({ s, life: 0, dur: durationFrames, a0: alpha0 });
  },
  updatePlayerFlashFx(dtF) {
    if (!this.playerFlashFx.length) return;
    const p = this.player;
    const kept = [];
    for (const fx of this.playerFlashFx) {
      fx.life += dtF;
      const fr = fx.life / fx.dur;
      if (!p || fr >= 1) {
        if (fx.s.parent) fx.s.parent.removeChild(fx.s);
        fx.s.destroy();
        continue;
      }
      const tex = Tex.playerSilhouettes[p.frameIndex] || Tex.playerSilhouettes[0];
      if (tex && fx.s.texture !== tex) fx.s.texture = tex;
      fx.s.position.set(p.x, p.y);
      const fw = (fx.s.texture.frame && fx.s.texture.frame.width) || 16;
      const mag = PLAYER_SPRITE_SIZE / fw;
      fx.s.scale.x = (p.facingRight ? -1 : 1) * mag;
      fx.s.scale.y = mag;
      fx.s.alpha = fx.a0 * (1 - fr);
      kept.push(fx);
    }
    this.playerFlashFx = kept;
  },

  /* 汎用リングフラッシュ（原作 HurtFlash=被弾時の赤円 / BossDeathFlash=拡大する黄円）:
     半径 rFrom→rTo へ変化しながら alpha0 からフェードアウトする */
  spawnRingFx(x, y, color, durationFrames, radiusFrom, radiusTo, alpha0) {
    const s = new PIXI.Sprite(Tex.circle);
    s.anchor.set(0.5); s.tint = color; s.position.set(x, y); s.alpha = alpha0;
    const d = radiusFrom * 2 * (32 / 30); // Tex.circle の実描画径30pxに対する換算
    s.width = d; s.height = d;
    this.world.addChild(s);
    this.ringFx.push({ s, life: 0, dur: durationFrames, rFrom: radiusFrom, rTo: radiusTo, a0: alpha0 });
  },
  updateRingFx(dtF) {
    const kept = [];
    for (const fx of this.ringFx) {
      fx.life += dtF;
      const fr = fx.life / fx.dur;
      if (fr >= 1) { this.world.removeChild(fx.s); fx.s.destroy(); continue; }
      const r = fx.rFrom + (fx.rTo - fx.rFrom) * fr;
      const d = r * 2 * (32 / 30);
      fx.s.width = d; fx.s.height = d;
      fx.s.alpha = fx.a0 * (1 - fr);
      kept.push(fx);
    }
    this.ringFx = kept;
  },

  /* 汎用フローティングテキスト（原作 HealEffect / LevelUpEffect 用、プール再利用） */
  spawnTextFx(text, x, y, opts = {}) {
    const { color = 0xffffff, fontSize = 16, dur = 40, vy = 0, fadeIn = 0, fadeOut = 8, shadow = false } = opts;
    const key = color + '|' + fontSize + '|' + (shadow ? 1 : 0);
    let pool = this.textPools.get(key);
    if (!pool) { pool = []; this.textPools.set(key, pool); }
    let t = pool.pop();
    if (!t) {
      const style = { fontFamily: 'NotoSansJP, sans-serif', fontSize, fill: color, fontWeight: 'bold' };
      if (shadow) { style.dropShadow = true; style.dropShadowColor = 0x000000; style.dropShadowAlpha = 0.6; style.dropShadowDistance = 1; style.dropShadowAngle = Math.PI / 2; }
      t = new PIXI.Text('', style);
      t.anchor.set(0.5, 1);
      this.world.addChild(t);
    }
    t.text = text;
    t.position.set(x, y);
    t.alpha = fadeIn > 0 ? 0 : 1; t.visible = true;
    this.textFx.push({ t, pool, life: 0, dur, vy, fadeIn, fadeOut });
  },
  updateTextFx(dtF) {
    const kept = [];
    for (const fx of this.textFx) {
      fx.life += dtF;
      if (fx.life >= fx.dur) { fx.t.visible = false; fx.pool.push(fx.t); continue; }
      fx.t.position.y += fx.vy * dtF;
      const remain = fx.dur - fx.life;
      fx.t.alpha = fx.life < fx.fadeIn ? fx.life / fx.fadeIn : (remain < fx.fadeOut ? remain / fx.fadeOut : 1);
      kept.push(fx);
    }
    this.textFx = kept;
  },

  /* 回復表示（原作 HealEffect + AutoHealEffect）: 緑の「+N HP」が上昇表示。
     auto（自然回復）/ garlic 系は周囲に緑の粒子も出す */
  spawnHealFx(amount, type) {
    const p = this.player;
    this.spawnTextFx('+' + Math.floor(amount) + ' HP', p.x, p.y - p.size - 4,
      { color: 0x32ff32, fontSize: 18, dur: 80, vy: -0.8, fadeIn: 0, fadeOut: 80, shadow: true });
    if (type === 'auto' || type === 'garlic') {
      for (let i = 0; i < 10; i++) {
        this.particles.add(p.x + randFloat(-10, 10), p.y + randFloat(-10, 10),
          { color: 0x64ff96, speed: randFloat(0.5, 1.5), life: randInt(30, 45), size: 2 });
      }
    }
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
          this.spawnAvoidanceFx();
          continue;
        }
        p.hp -= Math.max(1, Math.floor(e.damage - p.defense()));
        this.spawnPlayerFlashFx(0xff0000, 12, 150 / 255); // 原作 HurtFlash（プレイヤーシルエット）
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
          if (Math.random() < p.avoidance()) { this.spawnAvoidanceFx(); continue; }
          p.hp -= Math.max(1, Math.floor(pr.damage - p.defense()));
          this.spawnPlayerFlashFx(0xff0000, 12, 150 / 255); // 原作 HurtFlash（プレイヤーシルエット）
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
        // 出現アニメーション（原作 GameItem.spawn_scale: 300msで 0→1、1.2倍速で到達）
        if (item.type !== 'money' && item.spawnMs !== undefined) {
          const f = Math.min(1, Math.max(0, (this.nowMs - item.spawnMs) / 300) * 1.2);
          item.sprite.width = 48 * f; item.sprite.height = 48 * f;
        }
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
          if (healed > 0) { AudioSys.playSound('heal'); this.particles.burst(p.x, p.y, 0x40ff40, 6); this.spawnHealFx(healed, 'item'); }
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
    // 原作 LevelUpEffect: 頭上に金色の「LEVEL UP!」（48フレーム、フェードイン8/アウト12）
    this.spawnTextFx('LEVEL UP!', this.player.x, this.player.y - this.player.size - 10,
      { color: 0xffdc78, fontSize: 22, dur: 48, vy: 0, fadeIn: 8, fadeOut: 12 });
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
    // リザルト画面（原作 ui/ui.py）が必要とする生データを渡す。
    // damageStats: { 攻撃タイプ: ダメージ } / enemyKills: { enemy_no: 撃破数 }
    // bossKills: { ボスNo: 撃破数 }（enemyKillStats の 'bossN' キーを分離）
    const enemyKills = {};
    const bossKills = {};
    for (const [k, n] of Object.entries(this.enemyKillStats)) {
      if (k.startsWith('boss')) bossKills[parseInt(k.slice(4), 10)] = n;
      else enemyKills[parseInt(k, 10)] = n;
    }
    return {
      clear, gameTime: this.gameTime, timeSec: Math.floor(this.gameTime),
      level: this.player.level, kills: this.kills,
      sessionMoney: this.sessionMoney, survivalBonus: Math.floor(this.gameTime) * C.MONEY_PER_SURVIVAL_SECOND,
      clearBonus, damageStats: { ...this.damageStats }, enemyKills, bossKills,
    };
  },
  /* ---------- ポーズ ----------
     原作 main.py の ESC は「GAME PAUSED」表示付きの強制終了だったが、
     この移植版ではゲームを止める本物のポーズとして扱う。
     Continue で無料再開、Restart でセッションを確定して終了する。 */
  pauseGame() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    UI.openEndScreen(this.endStats(false, 0), (action) => {
      if (action === 'continue') {
        // ポーズ再開: コンティニュー料金や回復はなし（現在の状態のまま続行）
        this.state = 'playing';
      } else {
        // ポーズから終了: ここまでの報酬を保存して初期武器選択へ戻る
        this.bankAndRecord(0);
        this.resetGame();
      }
    }, { paused: true });
  },
  resumeGame() {
    if (this.state !== 'paused') return;
    UI.closeEndScreen();
    this.state = 'playing';
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
    // ワールドコンテナは scale=ズーム のため、位置はカメラ×ズームで引く
    const z = this.zoom || 1;
    this.world.position.set(-Math.round((this.camera.x + shX) * z), -Math.round((this.camera.y + shY) * z));

    // プレイヤー（歩行フレーム切替・無敵点滅・向き反転）
    const spr = p.sprite;
    spr.position.set(p.x, p.y);
    // 足元の影（プレイヤーのみ）。ドットの下端付近に薄く落とす
    if (this.playerShadow) {
      this.playerShadow.position.set(p.x, p.y + PLAYER_SPRITE_SIZE / 2 - 3);
    }
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
