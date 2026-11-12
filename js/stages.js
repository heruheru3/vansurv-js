'use strict';
/* ステージ定義 (stages.js)
   ステージとは「マップ」と「敵呼び出しルール」のセットである（浩之様の定義）。
   このファイルにステージごとの設定を集約し、エンジン側のコードからは
   分離する。新しいステージを足す手順:
     1. マップCSVを用意する（例: map/stage2_map.csv）
     2. 敵呼び出しルールCSVを用意する（例: data/stage2_spawn_rules.csv。
        書式は data/enemy_spawn_rules.csv と同じ）
     3. 下の StageDefs にエントリを1つ追加する
   敵・ボスの能力値そのもの（data/enemy_stats.csv / data/boss_stats.csv）は
   全ステージ共通の図鑑であり、ステージ側は「どの敵を・いつ・どれだけ
   呼ぶか」のルールだけを持つ。

   各エントリの項目:
   - mapFile        : マップCSVのパス
   - spawnRulesFile : 敵呼び出しルールCSVのパス
   - survivalTime   : ステージ時間（秒）。この秒数まで生き残ればクリア
   - bgm            : ゲーム中のBGM名（assets/music/<名前>.mp3）
   - spawn          : 敵の出現ペース（間隔・1回あたりの数・画面内上限）
     - intervalStartFrames: 出現間隔の初期値（フレーム）
     - intervalMinFrames  : 出現間隔の下限（フレーム）
     - intervalStepSec    : この秒数ごとに間隔を1フレーム短縮
     - batchStepSec       : この秒数ごとに1回あたりの出現数を+1
     - capStages          : [開始秒, 画面付近の敵数上限] の段階表
     - maxEnemies         : 全体の敵数ハード上限
   適用は game.js の applyStageDef() が行い、実行時定数 C へ流し込む。
   constants.js 側の同名項目は「定義が無い場合の既定値」である。 */
const StageDefs = {
  /* 現在のステージ（当面はステージ1のみ。選択UIは未実装） */
  current: 'stage1',

  stage1: {
    id: 'stage1',
    name: 'ステージ1',
    mapFile: 'map/stage_map.csv',
    spawnRulesFile: 'data/enemy_spawn_rules.csv',
    survivalTime: 200,
    bgm: 'level1',
    spawn: {
      intervalStartFrames: 20,
      intervalMinFrames: 5,
      intervalStepSec: 10,
      batchStepSec: 20,
      // 180秒で上限500に到達し、200秒のクリアまで維持する
      capStages: [[0, 100], [40, 180], [80, 260], [120, 340], [160, 430], [180, 500]],
      maxEnemies: 1000,
    },
  },
};
if (typeof module !== 'undefined') module.exports = { StageDefs };
