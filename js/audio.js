'use strict';
/* オーディオモジュール (audio.js)
   元コード対応: core/audio.py の Audio シングルトン。
   音量は constants の DEFAULT_SFX_VOLUME / DEFAULT_MUSIC_VOLUME = 0.1。
   play_sound には原作と同じ min_interval（デフォルト0.1秒）の連打制限がある。

   SE再生方式について（2026-11-12 の調査と iPhone 実機切り分けに基づく）:
   - HTMLAudio 要素の play() は、iPhone では再生開始のたびにメディア再生の
     立ち上げ処理が走り、実測で1回あたり数百ms級のフレーム停止を起こし得る。
     要素プール化しても解消しない（実機で確認）。要素再生は BGM 専用とする。
   - WebAudio が正道だが、iOS では「ページ読み込み時に作った AudioContext を
     操作時に resume するだけ」では不十分で、状態が running でも無音になる。
     Howler.js / @pixi/sound 等の実績ある実装は、操作（touchend/click/keydown/
     pointerup）のハンドラの中で同期的に context を生成し、無音バッファの
     ソースを実際に start して、その onended と state==='running' の両方が
     揃って初めてアンロック完了とみなす。本モジュールもその方式に従う。
   - あわせて Audio Session を 'playback' に寄せ（iOS 16.4+、要検出）、
     バックグラウンド復帰後に無音化する WebKit の既知不具合へは、次の操作で
     context を作り直して復旧する。デコードは OfflineAudioContext で先行し
     （出力のアンロックとは無関係に進められる）、取得は response.ok で
     絞らない。WebAudio が無い環境向けにだけ要素プールを残す。 */
const SFX_VOICES_PER_SOUND = 4;  // フォールバック用プールの、音ごとの要素数
const SFX_MAX_STARTS_PER_SEC = 40; // バッファ再生の開始数上限（暴走防止）

const AudioSys = {
  ctx: null,          // AudioContext（最初のユーザー操作の中で生成する）
  master: null,       // SEのマスター GainNode
  buffers: {},        // name -> AudioBuffer（デコード済み）
  _raw: {},           // name -> ArrayBuffer（再デコード用に保持）
  _decoding: {},      // name -> ライブ context でデコード中か
  _silBuf: null,      // アンロック用の無音バッファ
  _pendingPlay: null, // アンロック完了直後に鳴らす予約（最後の1件のみ）
  seReady: false,     // iOSアンロック完了（無音ソース onended + state running）
  _ctxSuspect: false, // バックグラウンドを挟んだため context の作り直しを検討
  _waSupported: !!(window.AudioContext || window.webkitAudioContext),
  voices: {},         // フォールバック用: name -> Audio要素の配列
  rr: {},             // フォールバック用: name -> 次に使うプールの位置
  bgm: null,
  bgmName: null,
  bgmSource: null,    // BGM要素を WebAudio へ載せる MediaElementAudioSourceNode
  bgmGain: null,      // 経由時のBGM音量はグラフ内の GainNode で制御する
                      // （経由後は要素の volume が効かない実装があるため）
  lastPlayed: {},     // name -> 最終再生時刻(ms)
  unlocked: false,
  sfxVolume: C.DEFAULT_SFX_VOLUME,
  musicVolume: C.DEFAULT_MUSIC_VOLUME,
  _pendingBgm: null,
  _winStartMs: 0,
  _winCount: 0,

  // assets/sfx/ に存在する効果音（core/audio.py が使う名前と同一）
  SFX_NAMES: ['enemy_hurt', 'player_hurt', 'gem_pickup', 'heal', 'bomb', 'powerup', 'box_break'], // item_drop は鳴らさない（2026-11-11 浩之様の指定）

  // SE の ON/OFF（任意設定）。OFF の間 playSound は即座に戻る
  sfxEnabled: true,

  // BGM の ON/OFF（任意設定）。iPhone では BGM（要素再生）が始まると
  // 音声セッションを奪われて SE（WebAudio）が消える現象があるため、
  // 切り分けと回避のために SE だけのモードを用意する
  bgmEnabled: true,
  _bgmRequested: null, // 最後に要求されたBGM名（ONに戻した時の再開用）

  init() {
    try { this.sfxEnabled = localStorage.getItem('vansurv_se') !== '0'; } catch (e) { /* 既定 ON */ }
    try { this.bgmEnabled = localStorage.getItem('vansurv_bgm') !== '0'; } catch (e) { /* 既定 ON */ }
    // フォールバック用プール（WebAudio が無い環境でのみ使う）
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
    // 音源は先に取得し、OfflineAudioContext でデコードまで済ませておく
    for (const n of this.SFX_NAMES) this._fetchAndDecode(n);
    // バックグラウンド復帰後に「running なのに無音」になる WebKit の既知
    // 不具合への備え: 隠れたら印を付け、次の操作で context を作り直す
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.ctx) this._ctxSuspect = true;
    });
    window.addEventListener('pageshow', () => { if (this.ctx) this._ctxSuspect = true; });
  },

  _fetchAndDecode(name) {
    fetch('assets/sfx/' + name + '.wav')
      // response.ok では絞らない（環境によっては正常でも ok にならない）
      .then((r) => r.arrayBuffer())
      .then((ab) => {
        this._raw[name] = ab;
        const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!OC) return;
        try {
          const oc = new OC(1, 1, 44100);
          return oc.decodeAudioData(ab.slice(0)).then((buf) => { this.buffers[name] = buf; }).catch(() => {});
        } catch (e) { /* ライブ context でのデコードに任せる */ }
      })
      .catch(() => { /* 取得失敗時は unlock 時の再試行に任せる */ });
  },

  _decodeWithLive(name) {
    const ab = this._raw[name];
    if (!this.ctx || !ab || this.buffers[name] || this._decoding[name]) return;
    this._decoding[name] = true;
    try {
      const dp = this.ctx.decodeAudioData(ab.slice(0),
        (buf) => { this.buffers[name] = buf; this._decoding[name] = false; },
        () => { this._decoding[name] = false; });
      if (dp && dp.catch) dp.catch(() => {});
    } catch (e) { this._decoding[name] = false; }
  },

  setSfxEnabled(on) {
    this.sfxEnabled = !!on;
    try { localStorage.setItem('vansurv_se', on ? '1' : '0'); } catch (e) { /* 保存失敗は無視 */ }
    return this.sfxEnabled;
  },

  /* ユーザー操作のハンドラから呼ばれる。BGM の解放は初回のみ。
     SE のアンロックは操作のたびに _ensureContext で試み続ける */
  unlock() {
    // 先に SE 側の context を用意してから BGM を解放する
    // （BGM要素を WebAudio 経由に出すため、context が先に要る）
    this._ensureContext();
    if (!this.unlocked) {
      this.unlocked = true;
      if (this._pendingBgm) { const b = this._pendingBgm; this._pendingBgm = null; this.playBgm(b); }
    }
  },

  /* AudioContext の生成と iOS アンロック。必ず操作ハンドラの中で同期的に
     呼ぶこと（await やタイマーを挟むと操作の有効期限が切れる） */
  _ensureContext() {
    if (!this._waSupported) return;
    try {
      // Audio Session を BGM（要素再生）と同じメディア扱いに寄せる。
      // context の生成前に設定する。要フィーチャー検出（iOS 16.4+）
      if (!this.ctx && 'audioSession' in navigator) {
        try { navigator.audioSession.type = 'playback'; } catch (e) {}
      }
      // バックグラウンドを挟んだ context は作り直す（無音化不具合の復旧）。
      // BGM要素は旧 context に載っているため、位置と状態を控えて載せ直す
      let bgmResume = null;
      if (this._ctxSuspect && this.ctx) {
        bgmResume = this._detachBgmForCtxChange();
        try { this.ctx.close(); } catch (e) {}
        this.ctx = null;
        this.master = null;
        this.seReady = false;
      }
      this._ctxSuspect = false;
      if (this.seReady && this.ctx && this.ctx.state === 'running') return;
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.sfxVolume;
        this.master.connect(this.ctx.destination);
        for (const n of this.SFX_NAMES) this._decodeWithLive(n);
        if (bgmResume) this._restoreBgmAfterCtxChange(bgmResume);
      }
      // iOS には interrupted という状態もあるため、running 以外はすべて resume
      if (this.ctx.state !== 'running') {
        const p = this.ctx.resume();
        if (p && p.catch) p.catch(() => {});
      }
      // アンロックの本体: 無音バッファのソースを実際に start し、その
      // onended と running が揃った時点で初めて完了とする
      if (!this.seReady) {
        if (!this._silBuf) this._silBuf = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
        const src = this.ctx.createBufferSource();
        src.buffer = this._silBuf;
        src.connect(this.ctx.destination);
        src.onended = () => {
          if (this.ctx && this.ctx.state === 'running') {
            this.seReady = true;
            const pn = this._pendingPlay;
            this._pendingPlay = null;
            if (pn) this.playSound(pn, 0);
          }
        };
        src.start(0);
      }
    } catch (e) { /* 音が出なくてもゲームは止めない */ }
  },

  playSound(name, minInterval = 0.1) {
    if (!this.unlocked || !this.sfxEnabled) return;
    const now = performance.now();
    if (now - (this.lastPlayed[name] || -1e9) < minInterval * 1000) return;
    if (this._waSupported) {
      // WebAudio 経路。準備ができていない間は要素再生へ落とさず、その回は
      // 鳴らさない（要素の再生開始コストがフレーム停止の原因になるため）。
      // アンロック進行中なら、完了直後に鳴らす予約だけ受け付ける
      if (!this.ctx || !this.seReady || this.ctx.state !== 'running') {
        if (this.ctx) this._pendingPlay = name;
        return;
      }
      const buf = this.buffers[name];
      if (!buf) return;
      if (now - this._winStartMs >= 1000) { this._winStartMs = now; this._winCount = 0; }
      if (++this._winCount > SFX_MAX_STARTS_PER_SEC) return;
      this.lastPlayed[name] = now;
      try {
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.master);
        src.onended = () => { try { src.disconnect(); } catch (e) {} };
        src.start();
      } catch (e) { /* 再生失敗はゲームを止めない */ }
      return;
    }
    // WebAudio が無い環境向けのフォールバック（要素プール）
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

  /* 診断用: 現在の音声まわりの状態を返す */
  debugState() {
    return {
      waSupported: this._waSupported,
      seReady: this.seReady,
      ctxState: this.ctx ? this.ctx.state : null,
      sampleRate: this.ctx ? this.ctx.sampleRate : null,
      audioSessionType: ('audioSession' in navigator) ? navigator.audioSession.type : null,
      buffers: Object.keys(this.buffers).length,
    };
  },

  setBgmEnabled(on) {
    this.bgmEnabled = !!on;
    try { localStorage.setItem('vansurv_bgm', on ? '1' : '0'); } catch (e) { /* 保存失敗は無視 */ }
    if (!on) {
      this._pendingBgm = null;
      this.stopMusic();
    } else if (this.unlocked && this._bgmRequested) {
      this.playBgm(this._bgmRequested);
    }
    return this.bgmEnabled;
  },

  /* name: 'level0'（選択画面）| 'level1'（ゲーム中）。原作 main.py は level1 を再生 */
  playBgm(name) {
    this._bgmRequested = name;
    if (!this.bgmEnabled) return;
    if (!this.unlocked) { this._pendingBgm = name; return; }
    if (this.bgmName === name && this.bgm && !this.bgm.paused) return;
    this.stopMusic();
    const a = new Audio('assets/music/' + name + '.mp3');
    a.loop = true;
    a.volume = this.musicVolume;
    // BGMも WebAudio の context 経由で出す。BGM要素が直接鳴ると iPhone では
    // 音声セッションを握られて SE 側の出力が止まる（実機確認済み）ため、
    // 出口を context の1本に統一する。
    // 経由時の音量はグラフ内の GainNode で制御する: 経由後は要素の volume を
    // 無視する実装があり（実機で 0.02 が効かなかった）、要素側は素通しにする
    this.bgmSource = null;
    this.bgmGain = null;
    if (this.ctx) {
      try {
        const src = this.ctx.createMediaElementSource(a);
        const g = this.ctx.createGain();
        g.gain.value = this.musicVolume;
        src.connect(g);
        g.connect(this.ctx.destination);
        this.bgmSource = src;
        this.bgmGain = g;
        a.volume = 1;
      } catch (e) { this.bgmSource = null; this.bgmGain = null; /* 載せ替え失敗時は要素の直接再生に任せる */ }
    }
    const p = a.play(); if (p && p.catch) p.catch(() => {});
    this.bgm = a; this.bgmName = name;
  },

  /* context 作り直しの前に、BGMの曲・位置・再生状態を控えて要素を外す */
  _detachBgmForCtxChange() {
    if (!this.bgm) return null;
    const st = { name: this.bgmName, time: 0, wasPlaying: false };
    try {
      st.time = this.bgm.currentTime || 0;
      st.wasPlaying = !this.bgm.paused;
      this.bgm.pause();
    } catch (e) {}
    this.bgm = null;
    this.bgmName = null;
    this.bgmSource = null;
    this.bgmGain = null;
    return st;
  },

  /* 新しい context の上で BGM要素を作り直し、控えた位置から再開する */
  _restoreBgmAfterCtxChange(st) {
    if (!st || !st.name || !this.bgmEnabled) return;
    this.playBgm(st.name);
    if (this.bgm) {
      try { this.bgm.currentTime = st.time; } catch (e) {}
      if (!st.wasPlaying) { try { this.bgm.pause(); } catch (e) {} }
    }
  },

  stopMusic() {
    if (this.bgm) { try { this.bgm.pause(); } catch (e) {} this.bgm = null; this.bgmName = null; }
    if (this.bgmSource) { try { this.bgmSource.disconnect(); } catch (e) {} this.bgmSource = null; }
    if (this.bgmGain) { try { this.bgmGain.disconnect(); } catch (e) {} this.bgmGain = null; }
  },
};
if (typeof module !== 'undefined') module.exports = { AudioSys };
