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
      'menu-hint', 'endscreen', 'end-title', 'end-stats', 'end-buttons', 'banner', 'loading'];
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
    const maxHp = p.maxHp();
    const hpRatio = Math.max(0, p.hp / maxHp);
    this.els['hp-bar'].style.width = (hpRatio * 100).toFixed(1) + '%';
    this.els['hp-bar'].style.background = hpRatio > 0.3 ? '#3ecf5a' : '#e33';
    this.els['hp-text'].textContent = 'HP ' + Math.ceil(p.hp) + ' / ' + maxHp;
    const xpRatio = Math.max(0, Math.min(1, p.exp / p.expToNextLevel));
    this.els['xp-bar'].style.width = (xpRatio * 100).toFixed(1) + '%';
    this.els['lv-text'].textContent = 'Lv ' + p.level;
    const remain = Math.max(0, C.SURVIVAL_TIME - game.gameTime);
    const mm = Math.floor(remain / 60), ss = Math.floor(remain % 60);
    this.els['timer-text'].textContent = mm + ':' + String(ss).padStart(2, '0');
    this.els['kills-text'].textContent = '撃破 ' + game.kills;
    this.els['money-text'].textContent = game.sessionMoney + ' G';
    this.els['fps-text'].textContent = Math.round(game.fps) + ' FPS / 敵 ' + game.enemies.length;

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
     stats: { clear, timeSec, level, kills, sessionMoney, survivalBonus, damageRows:[[名前,ダメージ],...] } */
  openEndScreen(stats, onAction) {
    this.endState = { clear: stats.clear, selected: 0, onAction, canContinue: !stats.clear };
    this.els['end-title'].textContent = stats.clear ? 'GAME CLEAR!' : 'GAME OVER';
    this.els['end-title'].style.color = stats.clear ? '#ffd700' : '#e33';
    const mm = Math.floor(stats.timeSec / 60), ss = Math.floor(stats.timeSec % 60);
    let html = '<table>' +
      '<tr><td>生存時間</td><td>' + mm + ':' + String(ss).padStart(2, '0') + '</td></tr>' +
      '<tr><td>レベル</td><td>' + stats.level + '</td></tr>' +
      '<tr><td>撃破数</td><td>' + stats.kills + '</td></tr>' +
      '<tr><td>獲得ゴールド</td><td>' + (stats.sessionMoney + stats.survivalBonus) + ' G' +
      '（撃破等 ' + stats.sessionMoney + ' + 生存 ' + stats.survivalBonus + (stats.clearBonus ? ' + クリア ' + stats.clearBonus : '') + '）</td></tr>' +
      '<tr><td>所持金（累計）</td><td>' + SaveSystem.getMoney() + ' G</td></tr></table>';
    if (stats.damageRows && stats.damageRows.length) {
      html += '<div class="dmg-title">武器別ダメージ</div><table>';
      for (const [name, dmg] of stats.damageRows) {
        html += '<tr><td>' + name + '</td><td>' + Math.floor(dmg) + '</td></tr>';
      }
      html += '</table>';
    }
    if (stats.killRows && stats.killRows.length) {
      html += '<div class="dmg-title">敵別撃破数</div><table>';
      for (const [name, n] of stats.killRows) {
        html += '<tr><td>' + name + '</td><td>' + n + ' 体</td></tr>';
      }
      html += '</table>';
    }
    this.els['end-stats'].innerHTML = html;
    this.renderEndButtons();
    this.els.endscreen.style.display = 'flex';
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
    if (this.endState.canContinue) mk('Continue (' + C.MONEY_CONTINUE_COST + 'G)', 1, 'continue');
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
    this.els.endscreen.style.display = 'none';
  },
};
if (typeof module !== 'undefined') module.exports = { UI };
