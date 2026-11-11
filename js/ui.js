'use strict';
/* UIモジュール (ui.js)
   元コード対応: ui/ui.py（HUD・ミニマップ・選択画面・エンド画面）。
   本移植では HUD とメニューを DOM で描く（テキスト描画が確実で高速なため）。
   ゲーム本体の描画は Pixi（game.js）が担当し、UIは状態を受け取って表示するだけ。

   画面構成（index.html 側の要素）:
     #hud        … HP/XPバー、レベル、タイマー、撃破数、お金、所持品アイコン、FPS
     #minimap    … 右上のミニマップ (canvas 2D)
     #menu       … 武器選択 / レベルアップ選択のオーバーレイ
     #endscreen  … ゲームオーバー / クリアの結果画面
     #banner     … ボス出現などの一時表示
*/
const UI = {
  els: {},
  menu: null,      // { mode:'initial'|'levelup', choices:[...], selected:int }
  endState: null,  // { clear:boolean, selected:int, canContinue:boolean }

  init() {
    const ids = ['hud', 'hp-bar', 'hp-text', 'xp-bar', 'lv-text', 'timer-text', 'kills-text',
      'money-text', 'fps-text', 'items-row', 'minimap', 'menu', 'menu-title', 'menu-grid',
      'menu-hint', 'endscreen', 'end-title', 'end-time', 'result-weapon-rows',
      'result-total-damage', 'result-total-dps', 'result-enemy-grid', 'result-boss-row',
      'end-buttons', 'banner', 'loading'];
    for (const id of ids) this.els[id] = document.getElementById(id);
    this.minimapCtx = this.els.minimap.getContext('2d');
    this._lastMinimapMs = 0;
  },

  hideLoading() { if (this.els.loading) this.els.loading.style.display = 'none'; },
  showError(msg) {
    if (this.els.loading) {
      this.els.loading.style.display = 'flex';
      this.els.loading.innerHTML = '<div class="load-error">' + msg + '</div>';
    }
  },
  showBanner(text, ms = 2000) {
    const b = this.els.banner;
    b.textContent = text;
    b.style.opacity = '1';
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => { b.style.opacity = '0'; }, ms);
  },

  /* ---------------- HUD ---------------- */
  updateHUD(game) {
    const p = game.player;
    if (!p) return;
    // DOM書き込みは「値が変わった時だけ」にする（毎フレームの再描画は
    // モバイルでレイアウト再計算を誘発し、ガタつきの一因になるため）
    const hc = this._hudCache || (this._hudCache = {});
    const put = (key, el, prop, val) => { if (hc[key] !== val) { hc[key] = val; el[prop] = val; } };
    const putStyle = (key, el, prop, val) => { if (hc[key] !== val) { hc[key] = val; el.style[prop] = val; } };
    const maxHp = p.maxHp();
    const hpRatio = Math.max(0, p.hp / maxHp);
    putStyle('hpw', this.els['hp-bar'], 'width', (hpRatio * 100).toFixed(1) + '%');
    putStyle('hpbg', this.els['hp-bar'], 'background', hpRatio > 0.3 ? '#3ecf5a' : '#e33');
    put('hpt', this.els['hp-text'], 'textContent', 'HP ' + Math.ceil(p.hp) + ' / ' + maxHp);
    const xpRatio = Math.max(0, Math.min(1, p.exp / p.expToNextLevel));
    putStyle('xpw', this.els['xp-bar'], 'width', (xpRatio * 100).toFixed(1) + '%');
    put('lvt', this.els['lv-text'], 'textContent', 'Lv ' + p.level);
    const remain = Math.max(0, C.SURVIVAL_TIME - game.gameTime);
    const mm = Math.floor(remain / 60), ss = Math.floor(remain % 60);
    put('tmt', this.els['timer-text'], 'textContent', mm + ':' + String(ss).padStart(2, '0'));
    put('klt', this.els['kills-text'], 'textContent', '撃破 ' + game.kills);
    put('mnt', this.els['money-text'], 'textContent', game.sessionMoney + ' G');
    const nowMs = performance.now();
    if (nowMs - (hc.fpsMs || 0) >= 250) {
      hc.fpsMs = nowMs;
      put('fst', this.els['fps-text'], 'textContent', Math.round(game.fps) + ' FPS / 敵 ' + game.enemies.length);
    }

    // 所持品アイコン列（武器=金枠、サブアイテム=青枠、レベル付き）
    if (game._hudItemsDirty) {
      game._hudItemsDirty = false;
      let html = '';
      for (const [key, w] of p.weapons) {
        html += '<div class="inv-icon weapon" title="' + key + '"><img src="assets/icons/' + key + '.png" alt=""><span>Lv' + w.level + '</span></div>';
      }
      for (const [key, lv] of p.subitems) {
        html += '<div class="inv-icon sub" title="' + key + '"><img src="assets/icons/' + key + '.png" alt=""><span>Lv' + lv + '</span></div>';
      }
      this.els['items-row'].innerHTML = html;
    }
    this.drawMinimap(game);
  },

  /* ミニマップ（ui/ui.py draw_minimap）: ワールド全体を縮小し敵=赤、ジェム=シアン、
     アイテム=黄、ボス=ピンク大、プレイヤー=緑、カメラ範囲=白枠で描く */
  drawMinimap(game) {
    if (performance.now() - this._lastMinimapMs < 100) return; // 10fpsで十分
    this._lastMinimapMs = performance.now();
    const cv = this.els.minimap, ctx = this.minimapCtx;
    const W = cv.width, H = cv.height;
    const scale = Math.min(W / C.WORLD_WIDTH, H / C.WORLD_HEIGHT);
    const mw = C.WORLD_WIDTH * scale, mh = C.WORLD_HEIGHT * scale;
    const ox = (W - mw) / 2, oy = (H - mh) / 2;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(10,10,10,0.55)';
    ctx.fillRect(ox, oy, mw, mh);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    ctx.strokeRect(ox, oy, mw, mh);
    const px = (x) => ox + x * scale, py = (y) => oy + y * scale;
    ctx.fillStyle = '#c83c3c';
    for (const e of game.enemies) {
      if (e.isBoss) continue;
      ctx.fillRect(px(e.x), py(e.y), 2, 2);
    }
    ctx.fillStyle = '#ff69b4';
    for (const e of game.enemies) if (e.isBoss) ctx.fillRect(px(e.x) - 1, py(e.y) - 1, 4, 4);
    ctx.fillStyle = '#0ff';
    for (const g of game.gems) ctx.fillRect(px(g.x), py(g.y), 2, 2);
    ctx.fillStyle = '#ff0';
    for (const it of game.items) ctx.fillRect(px(it.x), py(it.y), 2, 2);
    const p = game.player;
    ctx.fillStyle = '#0f0';
    ctx.beginPath(); ctx.arc(px(p.x), py(p.y), 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.strokeRect(px(game.camera.x), py(game.camera.y), C.SCREEN_WIDTH * scale, C.SCREEN_HEIGHT * scale);
  },

  /* ---------------- 選択メニュー ----------------
     mode 'initial': 開始時の武器選択（3x3グリッド、全9武器）
     mode 'levelup': レベルアップ選択（最大3枚の横並びカード）
     choices の要素は { value:'weapon:whip' 等, title, desc, badge } */
  openMenu(mode, title, choices, onChoose) {
    this.menu = { mode, choices, selected: 0, onChoose };
    this.els['menu-title'].textContent = title;
    this.els['menu-hint'].textContent = mode === 'initial'
      ? '矢印キー / WASD / 1-9 / クリックで選択、Enter / Space で決定'
      : '←→ / A・D / クリックで選択、Enter / Space で決定';
    this.renderMenu();
    this.els.menu.style.display = 'flex';
  },
  closeMenu() {
    this.menu = null;
    this.els.menu.style.display = 'none';
  },
  renderMenu() {
    if (!this.menu) return;
    const grid = this.els['menu-grid'];
    grid.className = this.menu.mode === 'initial' ? 'grid3x3' : 'rowcards';
    grid.innerHTML = '';
    this.menu.choices.forEach((ch, i) => {
      const card = document.createElement('div');
      card.className = 'card' + (i === this.menu.selected ? ' selected' : '');
      card.innerHTML =
        (ch.icon ? '<img src="assets/icons/' + ch.icon + '.png" alt="">' : '') +
        '<div class="card-title">' + ch.title + '</div>' +
        (ch.badge ? '<div class="card-badge">' + ch.badge + '</div>' : '') +
        '<div class="card-desc">' + ch.desc + '</div>';
      card.addEventListener('click', () => {
        if (!this.menu) return;
        this.menu.selected = i;
        this.renderMenu();
        this.confirmMenu();
      });
      grid.appendChild(card);
    });
  },
  moveSelection(dx, dy) {
    if (!this.menu) return;
    const n = this.menu.choices.length;
    const cols = this.menu.mode === 'initial' ? 3 : n;
    let s = this.menu.selected + dx + dy * cols;
    s = ((s % n) + n) % n;
    this.menu.selected = s;
    this.renderMenu();
  },
  selectIndex(i) {
    if (!this.menu) return;
    if (i >= 0 && i < this.menu.choices.length) { this.menu.selected = i; this.renderMenu(); }
  },
  confirmMenu() {
    if (!this.menu) return;
    const ch = this.menu.choices[this.menu.selected];
    const cb = this.menu.onChoose;
    this.closeMenu();
    if (cb) cb(ch.value);
  },

  /* ---------------- エンド画面 ----------------
     原作 ui/ui.py の draw_ui（リザルト部）と draw_end_buttons を再現する。
     内容:
       - タイトル + Survival Time
       - 武器別ダメージ表（アイコン / 武器名 / Total Damage / DPS）
       - Enemies Defeated（敵20体のアイコンを 10列×2段で表示）
       - Boss Defeated（ボス8体のアイコン + 撃破チェック）
       - 画面下部の Restart / Continue ボタン
     stats: { clear, gameTime, timeSec, damageStats:{type:dmg}, enemyKills:{no:count}, bossKills:{no:count} }
     opts.paused: ESC ポーズ（原作 force_ended の GAME PAUSED 表示） */
  /* リザルト画面（1280x720基準の絶対配置）をウインドウに収まるよう
     内側ステージごと拡縮・センタリングする。リサイズ時にも呼ばれる */
  layoutResultStage() {
    const st = document.getElementById('result-stage');
    if (!st) return;
    const s = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
    st.style.left = ((window.innerWidth - 1280 * s) / 2) + 'px';
    st.style.top = ((window.innerHeight - 720 * s) / 2) + 'px';
    st.style.transform = 'scale(' + s + ')';
  },

  openEndScreen(stats, onAction, opts) {
    this.layoutResultStage();
    const clear = !!stats.clear;
    const paused = !!(opts && opts.paused);
    // ポーズ中は Restart より Continue（再開）を初期選択にして誤終了を防ぐ
    this.endState = { clear, paused, selected: paused ? 1 : 0, onAction, canContinue: !clear };
    this.els.endscreen.classList.toggle('clear', clear);
    this.els.endscreen.classList.toggle('paused', paused);
    const hasDamage = !!stats.damageStats && Object.keys(stats.damageStats).length > 0;
    this.els.endscreen.classList.toggle('no-damage', !hasDamage);
    this.els['end-title'].textContent = paused ? 'GAME PAUSED' : (clear ? 'GAME CLEAR!' : 'GAME OVER');
    const seconds = Math.floor(stats.gameTime !== undefined ? stats.gameTime : stats.timeSec);
    this.els['end-time'].textContent = (paused ? 'Current Time: ' : 'Survival Time: ') + seconds + 's';
    this.renderWeaponStats(stats);
    this.renderEnemyStats(stats.enemyKills || {});
    this.renderBossStats(stats.bossKills || {});
    this.renderEndButtons();
    // 原作 draw_ui はゲーム終了/ポーズ中に残り時間を描かない（タイトルとの重なり防止）
    this.els['timer-text'].style.visibility = 'hidden';
    this.els.endscreen.style.display = 'block';
  },

  /* 攻撃タイプ -> アイコン/説明文の武器キー（本の攻撃タイプは 'book'） */
  weaponIconKey(type) { return type === 'book' ? 'rotating_book' : type; },
  weaponDisplayName(type) {
    const key = this.weaponIconKey(type);
    const d = GameData.descriptions && GameData.descriptions.weapons && GameData.descriptions.weapons[key];
    if (d && d.name) return d.name;
    const s = key.replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  },

  /* 武器別ダメージ表（原作 draw_ui の "Weapon / Total Damage / DPS"） */
  renderWeaponStats(stats) {
    const raw = stats.damageStats || {};
    // 原作は並び順（ダメージ降順）で最大5行まで表示する
    const entries = Object.entries(raw).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const rowsEl = this.els['result-weapon-rows'];
    rowsEl.innerHTML = '';
    const totalTime = Math.max(1, stats.gameTime !== undefined ? stats.gameTime : (stats.timeSec || 1));
    for (const [type, dmg] of entries) {
      const row = document.createElement('div');
      row.className = 'result-row';
      const nameCell = document.createElement('span');
      nameCell.className = 'col-weapon';
      const img = document.createElement('img');
      img.className = 'result-icon';
      img.src = 'assets/icons/' + this.weaponIconKey(type) + '.png';
      img.alt = '';
      img.onerror = () => { img.style.visibility = 'hidden'; };
      const name = document.createElement('span');
      name.textContent = this.weaponDisplayName(type);
      nameCell.append(img, name);
      const dmgCell = document.createElement('span');
      dmgCell.className = 'col-damage';
      dmgCell.textContent = String(Math.floor(dmg));
      const dpsCell = document.createElement('span');
      dpsCell.className = 'col-dps';
      dpsCell.textContent = (dmg / totalTime).toFixed(1);
      row.append(nameCell, dmgCell, dpsCell);
      rowsEl.appendChild(row);
    }
    const total = Object.values(raw).reduce((a, b) => a + b, 0);
    this.els['result-total-damage'].textContent = String(Math.floor(total));
    this.els['result-total-dps'].textContent = (total / totalTime).toFixed(1);
  },

  /* 敵別撃破数（原作 draw_enemy_kill_stats）: 全20種を常に表示し、
     未撃破は半透明＋グレーの「0」。 */
  renderEnemyStats(enemyKills) {
    const grid = this.els['result-enemy-grid'];
    grid.innerHTML = '';
    const list = [...GameData.enemyStats.values()]
      .sort((a, b) => a.enemy_no - b.enemy_no)
      .slice(0, 20);
    for (const st of list) {
      const count = enemyKills[st.enemy_no] || 0;
      const cell = document.createElement('div');
      cell.className = 'enemy-cell';
      cell.title = (st.description || ('敵' + st.enemy_no)) + ': ' + count + ' 体';
      const img = document.createElement('img');
      img.src = 'assets/character/enemy/' + st.image_file + '.png';
      img.alt = '';
      if (count === 0) img.style.opacity = '0.4';
      const num = document.createElement('span');
      num.className = 'enemy-count' + (count === 0 ? ' zero' : '');
      num.textContent = String(count);
      cell.append(img, num);
      grid.appendChild(cell);
    }
  },

  /* ボス撃破状況（原作 draw_boss_kill_stats）: 全ボスを横並びで表示し、
     撃破済みはチェックマーク、未撃破は半透明。 */
  renderBossStats(bossKills) {
    const row = this.els['result-boss-row'];
    row.innerHTML = '';
    const list = [...GameData.bossStats.values()].sort((a, b) => a.no - b.no);
    for (const st of list) {
      const defeated = (bossKills[st.no] || 0) > 0;
      const cell = document.createElement('div');
      cell.className = 'boss-cell';
      cell.title = (st.description || ('ボス' + st.no)) + (defeated ? ' 撃破' : ' 未撃破');
      const img = document.createElement('img');
      img.src = 'assets/character/enemy/' + st.image_file + '.png';
      img.alt = '';
      if (!defeated) img.style.opacity = '0.4';
      cell.appendChild(img);
      if (defeated) {
        const check = document.createElement('span');
        check.className = 'boss-check';
        check.textContent = '✓';
        cell.appendChild(check);
      }
      row.appendChild(cell);
    }
  },

  renderEndButtons() {
    if (!this.endState) return;
    const wrap = this.els['end-buttons'];
    wrap.innerHTML = '';
    const mk = (label, idx, cls) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = 'end-btn ' + cls + (this.endState.selected === idx ? ' selected' : '');
      b.addEventListener('click', () => { this.endState.selected = idx; this.confirmEnd(); });
      wrap.appendChild(b);
    };
    mk('Restart', 0, 'restart');
    if (this.endState.canContinue) {
      // ポーズの再開は無料。ゲームオーバーのコンティニューだけ 100G を徴収する
      const label = this.endState.paused ? 'Continue' : 'Continue (' + C.MONEY_CONTINUE_COST + 'G)';
      mk(label, 1, 'continue');
    }
  },
  moveEndSelection(dx) {
    if (!this.endState) return;
    const n = this.endState.canContinue ? 2 : 1;
    this.endState.selected = ((this.endState.selected + dx) % n + n) % n;
    this.renderEndButtons();
  },
  confirmEnd() {
    if (!this.endState) return;
    const action = this.endState.selected === 1 && this.endState.canContinue ? 'continue' : 'restart';
    const cb = this.endState.onAction;
    this.closeEndScreen();
    if (cb) cb(action);
  },
  closeEndScreen() {
    this.endState = null;
    this.els.endscreen.classList.remove('paused');
    this.els['timer-text'].style.visibility = '';
    this.els.endscreen.style.display = 'none';
  },
};
if (typeof module !== 'undefined') module.exports = { UI };
