# VanSurv JS移植計画

原作: ~/workspace/vansurv (pygame, main @1c42c0a) — ゲーム本体 約13,065 LOC
移植先: ~/workspace/vansurv-js （このフォルダ）

## 土台（決定済み）
- 描画: PixiJS 7.4.2（vendor/pixi.min.js にローカル同梱、CDN依存なし）
- 言語: 素のJavaScript（ES modulesではなく単一〜複数スクリプト、file:// でも http でも動く構成を優先）
- 解像度: 仮想 1280x720、ワールド 5120x2880、60FPS、生存 180秒（constants.py準拠）
- 素材/データ: assets/（PNG/MP3/WAV/TTF）、data/（enemy_stats.csv, boss_stats.csv, enemy_spawn_rules.csv, descriptions.json, enemy_image_state.json）、map/stage_map.csv を原作からそのままコピー済み
- セーブ: 原作 savedata.json と同じJSON構造を localStorage に保存

## 原作仕様の要点（constants.py / README / 各モジュールから）
- 操作: マウス移動でプレイヤー移動、武器は自動攻撃
- 開始時: 3x3グリッドで9武器から初期武器選択（矢印/WASD/数字/クリック、Enter決定）
- 武器9種: whip, garlic, magic_wand, holy_water, axe, stone, rotating_book, knife, thunder（詳細は weapons/*.py と README の表）
- サブアイテム9種: hp, base_damage, defense, speed, effect_range, effect_time, extra_projectiles, projectile_speed, gem_pickup_range（上限Lv3、武器上限Lv5、所持上限は武器4/サブ4）
- 敵: data/enemy_stats.csv（type/level別）、出現は enemy_spawn_rules.csv（時間帯・重み・頻度・倍率）、ボスは boss_stats.csv（20/40/60/80秒…）
- 敵上限は原作300体。JS版は性能が許す範囲で原作値を維持（目標: 300体で60FPS）
- ドロップ: 経験値ジェム、回復0.5%/ボム0.2%/マグネット0.1%、お金（money1-5、ui/box.py のボックス出現率・HP・中身率も含む）
- マップ: stage_map.csv 80x45タイル（64px）、障害物タイルは移動制限、武器の不可侵領域ルール（BLOCKER_AREAS_SOLID={5,9}, PASSTHROUGH={6,7}、影響武器 stone/knife/axe/magic_wand）
- 被弾後無敵200ms、レベルアップ、ミニマップ、リザルト画面、コンティニュー（100G）
- デバッグ: F3/F4/F5 相当は後回し可

## 段階
1. 土台+コア: Pixi初期化、CSV読込、マップ描画、プレイヤー（マウス移動）、カメラ、敵スポーン/追跡、当たり判定、ジェム/経験値、HUD
2. 武器9種+サブアイテム9種+レベルアップ選択UI+初期武器選択UI
3. ボス、ボックス/お金、特殊アイテム、パーティクル、画面揺れ、ミニマップ、オーディオ（BGM level0/level1、SFX）
4. セーブ（統計）、タイトル/リザルト/ゲームオーバー＆クリア、コンティニュー、仕上げ検証

## 検証
- node --check で全JSの構文確認
- ローカルHTTPサーバー + ヘッドレスブラウザで起動・スクリーンショット・FPS計測（可能な範囲）
- 原作数値との照合は constants.py と data/*.csv を正とする
