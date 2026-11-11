'use strict';
/* オーディオモジュール (audio.js)
   元コード対応: core/audio.py の Audio シングルトン。
   実装は HTMLAudio。pygame版との差:
   - ブラウザの自動再生ポリシーにより、最初のユーザー操作（クリック/キー）で
     unlock() が呼ばれるまでは一切鳴らさない。
   - 音量は constants の DEFAULT_SFX_VOLUME / DEFAULT_MUSIC_VOLUME = 0.1。
   - play_sound には原作と同じ min_interval（デフォルト0.1秒）の連打制限がある。 */
const AudioSys = {
  sounds: {},       // name -> テンプレートAudio要素（再生時は clone して多重再生）
  bgm: null,
  bgmName: null,
  lastPlayed: {},   // name -> 最終再生時刻(ms)
  unlocked: false,
  sfxVolume: C.DEFAULT_SFX_VOLUME,
  musicVolume: C.DEFAULT_MUSIC_VOLUME,
  _pendingBgm: null,

  // assets/sfx/ に存在する効果音（core/audio.py が使う名前と同一）
  SFX_NAMES: ['enemy_hurt', 'player_hurt', 'gem_pickup', 'heal', 'bomb', 'powerup', 'box_break'], // item_drop は鳴らさない（2026-11-11 浩之様の指定）

  // SE の ON/OFF（診断・任意設定）。OFF の間 playSound は即座に戻る
  // （再生のたびのメディア読み込み待ちが発生しない状態を作れる）
  sfxEnabled: true,

  init() {
    try { this.sfxEnabled = localStorage.getItem('vansurv_se') !== '0'; } catch (e) { /* 既定 ON */ }
    for (const n of this.SFX_NAMES) {
      const a = new Audio('assets/sfx/' + n + '.wav');
      a.preload = 'auto';
      a.volume = this.sfxVolume;
      this.sounds[n] = a;
    }
  },

  setSfxEnabled(on) {
    this.sfxEnabled = !!on;
    try { localStorage.setItem('vansurv_se', on ? '1' : '0'); } catch (e) { /* 保存失敗は無視 */ }
    return this.sfxEnabled;
  },

  /* 最初のユーザー操作から呼ばれる。以後、予約されていたBGMも再生開始する */
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    if (this._pendingBgm) { const b = this._pendingBgm; this._pendingBgm = null; this.playBgm(b); }
  },

  playSound(name, minInterval = 0.1) {
    if (!this.unlocked || !this.sfxEnabled) return;
    const now = performance.now();
    if (now - (this.lastPlayed[name] || -1e9) < minInterval * 1000) return;
    this.lastPlayed[name] = now;
    const tpl = this.sounds[name];
    if (!tpl) return;
    try {
      const a = tpl.cloneNode();
      a.volume = this.sfxVolume;
      const p = a.play(); if (p && p.catch) p.catch(() => {});
    } catch (e) { /* 再生失敗はゲームを止めない */ }
  },

  /* name: 'level0'（選択画面）| 'level1'（ゲーム中）。原作 main.py は level1 を再生 */
  playBgm(name) {
    if (!this.unlocked) { this._pendingBgm = name; return; }
    if (this.bgmName === name && this.bgm && !this.bgm.paused) return;
    this.stopMusic();
    const a = new Audio('assets/music/' + name + '.mp3');
    a.loop = true;
    a.volume = this.musicVolume;
    const p = a.play(); if (p && p.catch) p.catch(() => {});
    this.bgm = a; this.bgmName = name;
  },

  stopMusic() {
    if (this.bgm) { try { this.bgm.pause(); } catch (e) {} this.bgm = null; this.bgmName = null; }
  },
};
if (typeof module !== 'undefined') module.exports = { AudioSys };
