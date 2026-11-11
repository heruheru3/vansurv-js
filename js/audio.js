'use strict';
/* オーディオモジュール (audio.js)
   元コード対応: core/audio.py の Audio シングルトン。
   実装は HTMLAudio。pygame版との差:
   - ブラウザの自動再生ポリシーにより、最初のユーザー操作（クリック/キー）で
     unlock() が呼ばれるまでは一切鳴らさない。
   - 音量は constants の DEFAULT_SFX_VOLUME / DEFAULT_MUSIC_VOLUME = 0.1。
   - play_sound には原作と同じ min_interval（デフォルト0.1秒）の連打制限がある。

   SE再生方式の変遷（いずれも iPhone 実機での切り分けに基づく）:
   - 当初は再生のたびに要素を cloneNode していたが、毎回メディアの読み込み
     待ちが発生し、フレームが不定期に止まる原因になった（SE OFFで消失を確認）。
   - 次に WebAudio（AudioContext＋デコード済みバッファ）へ変えたが、iPhone
     実機では SE だけ音が出なかった。同じスペースで BGM（要素再生）は鳴る
     ため、配信と要素再生は正常で、WebAudio の出力経路側の問題と判断した。
   - 現在は「事前に読み込み済みの要素プール」方式。音ごとに複数の要素を
     preload しておき、再生は既存要素の currentTime=0 + play() のみ。
     再生ごとの読み込みは発生せず、実機で鳴る要素再生の経路だけを使う。 */
const SFX_VOICES_PER_SOUND = 4; // 同時再生を確保するための、音ごとの要素数

const AudioSys = {
  voices: {},       // name -> Audio要素の配列（プール）
  rr: {},           // name -> 次に使うプールの位置
  bgm: null,
  bgmName: null,
  lastPlayed: {},   // name -> 最終再生時刻(ms)
  unlocked: false,
  sfxVolume: C.DEFAULT_SFX_VOLUME,
  musicVolume: C.DEFAULT_MUSIC_VOLUME,
  _pendingBgm: null,

  // assets/sfx/ に存在する効果音（core/audio.py が使う名前と同一）
  SFX_NAMES: ['enemy_hurt', 'player_hurt', 'gem_pickup', 'heal', 'bomb', 'powerup', 'box_break'], // item_drop は鳴らさない（2026-11-11 浩之様の指定）

  // SE の ON/OFF（任意設定）。OFF の間 playSound は即座に戻る
  sfxEnabled: true,

  init() {
    try { this.sfxEnabled = localStorage.getItem('vansurv_se') !== '0'; } catch (e) { /* 既定 ON */ }
    for (const n of this.SFX_NAMES) {
      const pool = [];
      for (let i = 0; i < SFX_VOICES_PER_SOUND; i++) {
        const a = new Audio('assets/sfx/' + n + '.wav');
        a.preload = 'auto';
        a.volume = this.sfxVolume;
        pool.push(a);
      }
      this.voices[n] = pool;
      this.rr[n] = 0;
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
    const pool = this.voices[name];
    if (!pool || !pool.length) return;
    const a = pool[this.rr[name] % pool.length];
    this.rr[name]++;
    try {
      a.currentTime = 0;
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
