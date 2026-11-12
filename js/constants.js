'use strict';
/* VanSurv JS port — constants ported 1:1 from constants.py (pygame original).
   Where the original code and README disagree, the code wins. */
const C = {
  // 画面サイズは初期値。起動後 Game.applyViewSize が実ウインドウサイズへ
  // 書き換える（解像度＝ウインドウサイズ。縦画面・正方形でもそのまま遊べる）
  SCREEN_WIDTH: 1280,
  SCREEN_HEIGHT: 720,
  // ズーム（ワールド→画面の倍率）。初期値は画面の短辺から算出する
  // （下の PLAYER_SIZE_DIVISOR 参照）。ZOOM_DEFAULT は算出できない時の予備。
  // ゲーム中はホイール／ピンチで変更できる。下限は ZOOM_MIN を静的な値としつつ、
  // 「最も引いた時でも表示範囲の長辺がポップエリア（POP_AREA_TILES マス）を
  // 超えない」よう Game.zoomMin() がウインドウ長辺から動的に引き上げる
  ZOOM_DEFAULT: 0.8,
  ZOOM_MIN: 0.45,
  ZOOM_MAX: 3.0,
  // 敵のポップ有効エリア（マス数）。プレイヤー中心のこの正方形が出現・
  // 上限判定・回収の基準で、カメラやズームには依存しない
  // （ステージ定義 js/stages.js が正本。ここは既定値）
  POP_AREA_TILES: 20,
  // 初期ズームの基準: 画面の縦横のうち短い方 ÷ この値 が、プレイヤーの
  // 画面上サイズになる（2026-11-12 浩之様の指定: 当初は短辺の 1/10、
  // 同日「初期ズームを少し引いて」で 1/12 へ）
  PLAYER_SIZE_DIVISOR: 12,
  FPS: 60,
  SURVIVAL_TIME: 200,               // seconds to survive = game clear（ステージ定義 js/stages.js が正本。ここは既定値）

  WORLD_WIDTH: 1280 * 4,            // 5120
  WORLD_HEIGHT: 720 * 4,            // 2880

  OFFSCREEN_MARGIN: 100,
  DRAWING_MARGIN: 100,
  BOSS_WORLD_MARGIN: 150,

  MAX_WEAPONS: 4,
  MAX_SUBITEMS: 4,
  MAX_WEAPON_LEVEL: 5,
  MAX_SUBITEM_LEVEL: 3,

  TILE_SIZE: 64,                    // TEST_TILE_SIZE
  MAP_TILES_WIDTH: 80,
  MAP_TILES_HEIGHT: 45,
  MAP_FILE: 'map/stage_map.csv',    // ステージ定義（js/stages.js）が無い場合の予備

  INVINCIBLE_MS: 200,               // player invincibility after a hit

  HEAL_ITEM_DROP_RATE: 0.005,
  BOMB_ITEM_DROP_RATE: 0.002,
  MAGNET_ITEM_DROP_RATE: 0.001,

  PARTICLE_LIMIT: 200,
  PARTICLE_TRIM_TO: 300,
  MAX_GEMS_ON_SCREEN: 100,
  MAX_ENEMIES_ON_SCREEN: 1000,      // 負荷確認のため 300→1000 に増量中（2026-11-11 浩之様の指定）
  // 出現ペース（ステージ定義 js/stages.js が正本。ここは既定値）
  SPAWN_INTERVAL_START_FRAMES: 20,  // 出現間隔の初期値（フレーム）
  SPAWN_INTERVAL_MIN_FRAMES: 5,     // 出現間隔の下限（フレーム）
  SPAWN_INTERVAL_STEP_SEC: 10,      // この秒数ごとに間隔を1フレーム短縮
  SPAWN_BATCH_STEP_SEC: 20,         // この秒数ごとに1回あたりの出現数を+1（上限なし）
  // ポップエリア内の敵数上限（難易度レベル＝経過時間帯ごとに増加）: [開始秒, 上限]
  // 180秒で上限500に到達し、200秒（クリア）まで500体を維持する
  POP_CAP_STAGES: [[0, 100], [40, 180], [80, 260], [120, 340], [160, 430], [180, 500]],
  POP_REPOP_MARGIN: 160,            // ポップエリアからこの距離(px)を超えて外れた敵は回収対象
  POP_REPOP_INTERVAL_SEC: 1,        // エリア外敵の回収チェック間隔（秒）

  NATURAL_HEAL_INTERVAL_MS: 2000,
  NATURAL_HEAL_AMOUNT: 0,           // + HP-subitem level per tick (player.py)

  BASE_ATTRACTION_DISTANCE: 100,
  DEFAULT_SFX_VOLUME: 0.1,
  DEFAULT_MUSIC_VOLUME: 0.07, // 浩之の指定（元の0.1は少し大きい）。経由時はグラフ内GainNodeで効く

  GARLIC_HEAL_INTERVAL_MS: 500,
  GARLIC_HEAL_AMOUNT: 1,
  GARLIC_DAMAGE_INTERVAL_MS: 400,
  HOLY_WATER_DAMAGE_INTERVAL_MS: 200,

  HEAL_ITEM_AMOUNT: 0.25,           // fraction of max HP (constants.py; descriptions.json says 30% but code wins)
  MAGNET_EFFECT_DURATION_MS: 3000,
  MAGNET_FORCE_MULTIPLIER: 3.0,

  SCREEN_SHAKE_DURATION_MS: 500,
  SCREEN_SHAKE_INTENSITY: 10,

  LEVELUP_HEAL_AMOUNT: 0,

  // Enemy walk animation (constants.py)
  ENEMY_WALK_BOB_AMPLITUDE: 0.5,
  ENEMY_WALK_BOB_SPEED: 4,
  ENEMY_WALK_SWAY_AMPLITUDE: 0.8,
  ENEMY_WALK_SWAY_SPEED: 6.0,
  ENEMY_WALK_ROTATION_AMPLITUDE: 2.0,   // degrees
  ENEMY_WALK_ROTATION_SPEED: 5.0,
  ENABLE_ENEMY_WALK_ANIMATION: true,

  ENEMY_COLLISION_SEPARATION_FACTOR: 0.5,
  ENEMY_SEPARATION_STRENGTH: 0.6,
  ENEMY_SEPARATION_BOSS_PRIORITY: 1.5,
  ENABLE_ENEMY_SEPARATION: false,   // original default: separation push OFF,
                                    // but the fallback enemy-vs-enemy movement
                                    // blocking in enemy.move() still applies.

  // Money / economy
  MONEY_PER_ENEMY_KILLED: 10,
  MONEY_PER_LEVEL_BONUS: 50,
  MONEY_PER_SURVIVAL_SECOND: 5,
  MONEY_GAME_CLEAR_BONUS: 1000,
  MONEY_CONTINUE_COST: 100,
  MONEY_DROP_RATE: 0.1,
  MONEY_DROP_AMOUNT_MIN: 5,
  MONEY_DROP_AMOUNT_MAX: 25,

  MONEY_TIERS: [ // money1..5: [min, max, rate] for non-box drops
    [1, 10, 0.40], [10, 50, 0.30], [50, 200, 0.20], [200, 1000, 0.08], [1000, 10000, 0.02],
  ],
  // Box money tier tables (cumulative selection done in items code)
  BOX_MONEY_RATES: {
    1: [[1, 0.50], [2, 0.30], [3, 0.15], [4, 0.05]],        // tiers 1-4
    2: [[3, 0.60], [4, 0.30], [5, 0.10]],                    // tiers 3-5
    3: [[4, 0.50], [5, 0.50]],                               // tiers 4-5
  },

  BOX_SPAWN_INTERVAL_MIN: 1000,
  BOX_SPAWN_INTERVAL_MAX: 5000,
  BOX1_SPAWN_RATE: 0.65,
  BOX2_SPAWN_RATE: 0.30,
  BOX3_SPAWN_RATE: 0.05,
  BOX1_COIN_RATE: 1.0, BOX1_COIN_AMOUNT_MIN: 10, BOX1_COIN_AMOUNT_MAX: 30,
  BOX2_COIN_RATE: 0.9, BOX2_COIN_AMOUNT_MIN: 20, BOX2_COIN_AMOUNT_MAX: 50,
  BOX2_HEAL_RATE: 0.033, BOX2_BOMB_RATE: 0.033, BOX2_MAGNET_RATE: 0.034,
  BOX3_MONEY_RATE: 0.25, BOX3_HEAL_RATE: 0.25, BOX3_BOMB_RATE: 0.25, BOX3_MAGNET_RATE: 0.25,
  BOX_HP: { 1: 5, 2: 10, 3: 20, 4: 1 },
  BOX_SIZE: 64,
  BOX_COLLISION_SIZE: 56,

  BORDER_THICKNESS: 18,
  BLOCKER_AREAS_SOLID: [5, 9],
  BLOCKER_AREAS_PASSTHROUGH: [6, 7],
  WEAPONS_AFFECTED_BY_BLOCKERS: ['stone', 'knife', 'axe', 'magic_wand'],
  OBSTACLE_TILES: [5, 7, 8, 9],     // ui/stage.py is_obstacle_at_world_pos

  KNOCKBACK_DURATION: 0.1,          // seconds
  KNOCKBACK_COOLDOWN_DURATION: 0.8, // seconds
  // main.py knockback forces per weapon type
  KNOCKBACK_FORCES: {
    whip: 80.0, magic_wand: 60.0, axe: 120.0, stone: 40.0, knife: 50.0,
    book: 30.0, rotating_book: 30.0, thunder: 100.0, garlic: 20.0, holy_water: 25.0,
  },

  CAMERA_LERP: 0.18,                // main.py

  TILE_COLORS: { // map/map_loader.py tile_colors (RGB)
    0: 0x242424, 1: 0x303030, 2: 0x808080, 3: 0xc0c0c0, 4: 0x402010,
    5: 0x204020, 6: 0x404020, 7: 0x202040, 8: 0x401010, 9: 0x303030,
  },
  TILE_BORDER_COLORS: { 5: 0x102010, 7: 0x101020, 8: 0x200808, 9: 0x181818 },

  SAVE_KEY: 'vansurv_savedata',
};
if (typeof module !== 'undefined') module.exports = C;
