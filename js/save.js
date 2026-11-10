'use strict';
/* セーブシステム (save.js)
   元コード対応: systems/save_system.py の SaveSystem。
   保存先がファイル(savedata.json)から localStorage に変わるだけで、
   JSONの構造は原作と同一に保つ（将来の相互運用のため）。 */
const SaveSystem = {
  data: null,

  /* 原作 _get_default_data と同じ形 */
  defaultData() {
    const now = new Date().toISOString();
    return {
      version: '1.0', created_at: now, last_updated: now,
      player_stats: {
        total_money: 0,        // 総所持金
        money_earned_total: 0, // 累計獲得金額
        games_played: 0,
        total_playtime: 0,     // 秒
        best_survival_time: 0,
        total_enemies_killed: 0,
        total_experience_gained: 0,
        max_level_reached: 1,
      },
      weapon_stats: { whip: 0, holy_water: 0, garlic: 0, magic_wand: 0, axe: 0, stone: 0, rotating_book: 0, knife: 0, thunder: 0 },
      // 注意: 原作の辞書には gem_pickup_range が無い（そのまま再現）
      subitem_stats: { hp: 0, speed: 0, base_damage: 0, effect_range: 0, effect_time: 0, extra_projectiles: 0, projectile_speed: 0, defense: 0 },
      weapon_usage_stats: {},  // { 武器名: { total_damage, games_used } }
      achievements: { first_clear: false, weapon_master: false, millionaire: false, survivor: false },
    };
  },

  load() {
    let loaded = null;
    try {
      const raw = localStorage.getItem(C.SAVE_KEY);
      if (raw) loaded = JSON.parse(raw);
    } catch (e) { loaded = null; }
    const def = this.defaultData();
    if (loaded && typeof loaded === 'object') {
      // 原作 _merge_data: デフォルト側にあるキーだけを、保存値で上書きしながら補完
      const merge = (d, l) => {
        if (typeof d !== 'object' || d === null || Array.isArray(d)) return (l !== undefined ? l : d);
        const out = {};
        for (const k of Object.keys(d)) out[k] = merge(d[k], l ? l[k] : undefined);
        return out;
      };
      this.data = merge(def, loaded);
    } else {
      this.data = def;
    }
    return this.data;
  },

  save() {
    this.data.last_updated = new Date().toISOString();
    try { localStorage.setItem(C.SAVE_KEY, JSON.stringify(this.data)); } catch (e) { /* 保存不可環境では無視 */ }
  },

  getMoney() { return this.data.player_stats.total_money; },

  addMoney(amount) {
    amount = Math.trunc(amount);
    this.data.player_stats.total_money += amount;
    if (amount > 0) this.data.player_stats.money_earned_total += amount;
  },

  /* 戻り値: 支払えたら true（原作 spend_money と同じ） */
  spendMoney(amount) {
    if (this.data.player_stats.total_money >= amount) {
      this.data.player_stats.total_money -= amount;
      return true;
    }
    return false;
  },

  recordGameEnd(survivalTime, level, enemiesKilled, expGained) {
    const s = this.data.player_stats;
    s.games_played += 1;
    s.total_playtime += survivalTime;
    s.best_survival_time = Math.max(s.best_survival_time, survivalTime);
    s.total_enemies_killed += enemiesKilled;
    s.total_experience_gained += expGained;
    s.max_level_reached = Math.max(s.max_level_reached, level);
  },

  recordWeaponSelection(name) {
    if (name in this.data.weapon_stats) this.data.weapon_stats[name] += 1;
  },
  recordSubitemSelection(name) {
    if (name in this.data.subitem_stats) this.data.subitem_stats[name] += 1;
  },

  recordWeaponUsage(damageStats) {
    if (!this.data.weapon_usage_stats) this.data.weapon_usage_stats = {};
    for (const [name, dmg] of Object.entries(damageStats)) {
      if (!this.data.weapon_usage_stats[name]) {
        this.data.weapon_usage_stats[name] = { total_damage: 0, games_used: 0 };
      }
      this.data.weapon_usage_stats[name].total_damage += dmg;
      this.data.weapon_usage_stats[name].games_used += 1;
    }
  },

  unlockAchievement(name) {
    if (name in this.data.achievements && !this.data.achievements[name]) {
      this.data.achievements[name] = true;
      return true;
    }
    return false;
  },

  /* 原作 check_achievements（閾値もそのまま） */
  checkAchievements() {
    const s = this.data.player_stats;
    if (s.best_survival_time >= 900) this.unlockAchievement('first_clear');       // 15分生存
    if (s.total_money >= 1000000) this.unlockAchievement('millionaire');          // 100万G
    if (Object.values(this.data.weapon_stats).every(v => v >= 5)) this.unlockAchievement('weapon_master');
    if (s.best_survival_time >= 1800) this.unlockAchievement('survivor');         // 30分生存
  },
};
if (typeof module !== 'undefined') module.exports = { SaveSystem };
