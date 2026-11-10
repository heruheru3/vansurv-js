'use strict';
/* データ読み込みモジュール (data.js)
   役割: CSV / JSON の読み込みと、敵・ボス・出現ルールのデータ保持だけを行う。
   - 元コード対応: core/enemy.py の load_enemy_stats / load_boss_stats、
     core/enemy_spawn_manager.py の EnemySpawnManager。
   - ステージ・セーブ・オーディオはそれぞれ stage.js / save.js / audio.js に分離。
   - 新しい敵を増やすときは data/*.csv に行を追加するだけでよい（コード変更不要）。 */

/* ---------------- CSVパーサ（引用符内のカンマ・改行に対応） ---------------- */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0].trim() !== ''));
}

/* ヘッダ行をキーにしたオブジェクト配列へ変換する */
function csvToObjects(text) {
  const rows = parseCSV(text);
  if (!rows.length) return [];
  const head = rows[0].map(h => h.trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const o = {};
    head.forEach((h, j) => { o[h] = rows[i][j] !== undefined ? rows[i][j].trim() : ''; });
    out.push(o);
  }
  return out;
}

async function fetchText(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error('fetch failed: ' + path + ' (' + res.status + ')');
  return res.text();
}

/* ---------------- ゲームデータ本体 ----------------
   enemyStats : Map<enemy_no, stat>   （data/enemy_stats.csv）
   bossStats  : Map<No, stat>         （data/boss_stats.csv）
   spawnRules : Array<rule>           （data/enemy_spawn_rules.csv）
   descriptions: 武器・サブアイテムの表示名と説明（data/descriptions.json） */
const GameData = {
  enemyStats: new Map(),
  bossStats: new Map(),
  spawnRules: [],
  descriptions: null,
  mapCsvText: null, // ステージCSVの生テキスト（Stageクラスへ渡す）

  async loadAll() {
    const [enemyCsv, bossCsv, rulesCsv, descJson, mapCsv] = await Promise.all([
      fetchText('data/enemy_stats.csv'),
      fetchText('data/boss_stats.csv'),
      fetchText('data/enemy_spawn_rules.csv'),
      fetchText('data/descriptions.json'),
      fetchText(C.MAP_FILE),
    ]);

    for (const r of csvToObjects(enemyCsv)) {
      const no = parseInt(r.enemy_no, 10);
      this.enemyStats.set(no, {
        enemy_no: no,
        type: parseInt(r.type, 10),          // 行動タイプ 1..4（enemies.js の BEHAVIORS が解釈）
        level: parseInt(r.level, 10),
        base_hp: parseFloat(r.base_hp),
        base_speed: parseFloat(r.base_speed),
        base_damage: parseFloat(r.base_damage),
        speed_multiplier: parseFloat(r.speed_multiplier),
        attack_cooldown: parseFloat(r.attack_cooldown), // ms（射撃タイプのみ使用）
        image_file: r.image_file,            // assets/character/enemy/<image_file>.png
        image_size: parseInt(r.image_size, 10),
        projectile_speed: r.projectile_speed ? parseFloat(r.projectile_speed) : 3.0,
        description: r.description,
      });
    }

    for (const r of csvToObjects(bossCsv)) {
      const no = parseInt(r.No, 10);
      this.bossStats.set(no, {
        no,
        type: parseInt(r.type, 10),          // 101..104 → 行動タイプは type-100
        level: parseInt(r.level, 10),
        base_hp: parseFloat(r.base_hp),
        base_speed: parseFloat(r.base_speed),
        base_damage: parseFloat(r.base_damage),
        speed_multiplier: parseFloat(r.speed_multiplier),
        attack_cooldown: parseFloat(r.attack_cooldown),
        spawn_time: parseFloat(r.spawn_time), // 出現時刻（秒）。各行1回だけ出現
        image_file: r.image_file,
        image_size: parseInt(r.image_size, 10),
        projectile_speed: r.projectile_speed ? parseFloat(r.projectile_speed) : 3.0,
        description: r.description,
      });
    }

    for (const r of csvToObjects(rulesCsv)) {
      this.spawnRules.push({
        rule_id: parseInt(r.rule_id, 10),
        start_time: parseInt(r.start_time, 10),
        end_time: r.end_time === '-1' ? -1 : parseInt(r.end_time, 10), // -1 = 無制限
        enemy_no_list: r.enemy_no_list.split(',').map(x => parseInt(x.trim(), 10)),
        spawn_weight: parseFloat(r.spawn_weight),
        spawn_frequency: parseFloat(r.spawn_frequency),
        strength_multiplier: parseFloat(r.strength_multiplier),
        size_multiplier: parseFloat(r.size_multiplier),
        enabled: String(r.enabled).toLowerCase() === 'true',
        description: r.description,
      });
    }

    this.descriptions = JSON.parse(descJson);
    this.mapCsvText = mapCsv;
    return this;
  },

  /* EnemySpawnManager.select_enemy_no の移植。
     現在時刻で有効な全ルールの (enemy_no, rule) ペアから spawn_weight で重み付き抽選し、
     [enemy_no, rule] を返す。倍率の適用は enemies.js 側で行う。 */
  selectEnemyNo(gameTimeSec) {
    const t = Math.floor(gameTimeSec);
    const candidates = [], weights = [];
    for (const rule of this.spawnRules) {
      if (!rule.enabled) continue;
      if (rule.start_time <= t && (rule.end_time === -1 || t <= rule.end_time)) {
        for (const no of rule.enemy_no_list) { candidates.push([no, rule]); weights.push(rule.spawn_weight); }
      }
    }
    if (!candidates.length) throw new Error('有効な出現ルールがありません (t=' + t + ')');
    let total = 0; for (const w of weights) total += w;
    let r = Math.random() * total;
    for (let i = 0; i < candidates.length; i++) { r -= weights[i]; if (r <= 0) return candidates[i]; }
    return candidates[candidates.length - 1];
  },
};
if (typeof module !== 'undefined') module.exports = { parseCSV, csvToObjects, GameData };
