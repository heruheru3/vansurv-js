'use strict';
/* =============================================================================
   マップチップ（ドット絵）生成 — js/mapchips.js

   1タイル = 16×16ドット（表示64px、1ドット=4px）で描く。
   単にタイルを並べるのではなく、8近傍の「同族タイル」判定を見て縁を描く:
   - 水: 陸に接する辺に波打ち際（浅瀬＋白波）を描き、水場の境界がつながる
   - 森: 森同士は樹冠がつながり、外周だけ縁取りと影が付く
   - 道: 道以外に接する辺に土の縁取り
   - 地面: 水に接する辺に砂地の縁
   乱数はタイル座標で種付けする（同じマップでは常に同じ見た目になる）。

   使い方: MapChips.paintTile(ctx, ox, oy, idAt, tx, ty)
     ctx: チャンク用 CanvasRenderingContext2D
     ox, oy: そのタイルの左上ピクセル座標（チャンク内）
     idAt(x, y): タイル座標 -> タイルID（範囲外は -1）
     tx, ty: タイル座標
   ========================================================================== */
const MapChips = (() => {
  const DOTS = 16;   // 1タイルの一辺のドット数
  const SCALE = 4;   // 1ドットの表示ピクセル数（16×4=64px）

  /* タイルID -> 族（隣接判定と描画の分類） */
  function familyOf(id) {
    switch (id) {
      case 7: return 'water';
      case 5: return 'forest';
      case 6: return 'road';
      case 8: return 'danger';
      case 9: return 'rock';
      case 4: return 'soil';
      default: return 'ground'; // 0,1,2,3
    }
  }

  /* 座標ハッシュと決定的乱数（mulberry32） */
  function hash2(x, y, salt) {
    let h = (Math.imul(x + 1, 374761393) + Math.imul(y + 1, 668265263) + Math.imul(salt + 1, 974634211)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  }
  function makeRand(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* パレット */
  const PAL = {
    groundBase: { 0: '#232323', 1: '#2e2e2e', 2: '#7d7d7d', 3: '#3a3a3f' },
    groundSpeck: ['#2b2b2b', '#383838', '#1b1b1b', '#454545'],
    // 石畳（タイル3）: 周囲の地面に合わせた暗いトーンの石と目地
    stoneBase: ['#333338', '#38383e', '#3d3d42', '#313136'], stoneSeam: '#232327', stoneSpeck: ['#2b2b30', '#45454b'],
    sand: '#7d6c45',
    roadBase: '#4c4526', roadLight: '#5d5530', roadDark: '#322e1b', roadStone: '#6e6a55',
    waterBase: '#1c2a52', waterMid: '#27407a', waterLight: '#3d5a99', waterDeep: '#131f3f', foam: '#cfe8ef', shallow: '#2e4d86',
    forestBase: '#17351a', forestCanopy: '#1f4d24', forestLight: '#2f7038', forestHi: '#46a355', forestShadow: '#0b1d0e',
    dangerBase: '#3d1214', dangerCrack: '#160506', dangerEmber: '#7a2d12', dangerEdge: '#20090a',
    rockBase: '#3c3c40', rockLight: '#6d6d74', rockDark: '#222227', rockCrack: '#141417',
    soilBase: '#452a16', soilDark: '#2d1b0c', soilLight: '#5d3a1e', soilStone: '#77644a',
  };

  /* 1タイル分の描画。ctx へ ox,oy を原点に描く */
  function paintTile(ctx, ox, oy, idAt, tx, ty) {
    const id = idAt(tx, ty);
    if (id < 0) return;
    const fam = familyOf(id);
    const same = (dx, dy) => {
      const n = idAt(tx + dx, ty + dy);
      if (n < 0) return true; // マップ外は同族扱い（外周に変な縁を出さない）
      return familyOf(n) === fam;
    };
    const isWater = (dx, dy) => {
      const n = idAt(tx + dx, ty + dy);
      return n >= 0 && familyOf(n) === 'water';
    };
    const nb = {
      n: same(0, -1), s: same(0, 1), w: same(-1, 0), e: same(1, 0),
      nw: same(-1, -1), ne: same(1, -1), sw: same(-1, 1), se: same(1, 1),
    };
    const rand = makeRand(hash2(tx, ty, id * 31 + 7));

    const dot = (dx, dy, color) => {
      ctx.fillStyle = color;
      ctx.fillRect(ox + dx * SCALE, oy + dy * SCALE, SCALE, SCALE);
    };
    const fill = (color) => {
      ctx.fillStyle = color;
      ctx.fillRect(ox, oy, DOTS * SCALE, DOTS * SCALE);
    };
    const speck = (colors, count, sizeMax = 1) => {
      for (let i = 0; i < count; i++) {
        const dx = Math.floor(rand() * DOTS), dy = Math.floor(rand() * DOTS);
        dot(dx, dy, colors[Math.floor(rand() * colors.length)]);
        if (sizeMax > 1 && rand() < 0.3 && dx + 1 < DOTS) dot(dx + 1, dy, colors[Math.floor(rand() * colors.length)]);
      }
    };
    // 指定した辺（陸側）に帯を描く: rows[0]=最外周ドット列の色、rows[1]=その内側
    const edgeBand = (side, rows) => {
      rows.forEach((color, r) => {
        if (color == null) return;
        for (let i = 0; i < DOTS; i++) {
          if (side === 'n') dot(i, r, color);
          else if (side === 's') dot(i, DOTS - 1 - r, color);
          else if (side === 'w') dot(r, i, color);
          else dot(DOTS - 1 - r, i, color);
        }
      });
    };

    switch (fam) {
      case 'water': {
        fill(PAL.waterBase);
        // 内陸（周囲すべて水）なら深みを増す
        if (nb.n && nb.s && nb.w && nb.e && nb.nw && nb.ne && nb.sw && nb.se) {
          for (let i = 0; i < 5; i++) {
            const cx = 3 + Math.floor(rand() * 10), cy = 3 + Math.floor(rand() * 10);
            dot(cx, cy, PAL.waterDeep); dot(cx + 1, cy, PAL.waterDeep);
          }
        }
        // 波のきらめき（横長の短い線）
        for (let i = 0; i < 6; i++) {
          const y = Math.floor(rand() * DOTS), x = Math.floor(rand() * (DOTS - 3));
          const c = rand() < 0.6 ? PAL.waterMid : PAL.waterLight;
          dot(x, y, c); dot(x + 1, y, c);
          if (rand() < 0.5) dot(x + 2, y, c);
        }
        // 岸辺: 陸に接する辺に浅瀬＋白波を描く（水場の輪郭がつながる）
        const shore = (side, open) => {
          if (open) return;
          edgeBand(side, [null, PAL.shallow, PAL.shallow]);
          // 白波は最外周の1ドット内側に、途切れさせながら
          for (let i = 0; i < DOTS; i++) {
            if (rand() < 0.25) continue;
            if (side === 'n') dot(i, 1, PAL.foam);
            else if (side === 's') dot(i, DOTS - 2, PAL.foam);
            else if (side === 'w') dot(1, i, PAL.foam);
            else dot(DOTS - 2, i, PAL.foam);
          }
        };
        shore('n', nb.n); shore('s', nb.s); shore('w', nb.w); shore('e', nb.e);
        // 入り江の角: 斜めだけが陸で、両隣が水のとき角に白波を足す
        const cornerFoam = (diagOpen, c1, c2, dx, dy) => {
          if (diagOpen || !c1 || !c2) return;
          dot(dx, dy, PAL.foam);
          if (rand() < 0.7) dot(dx === 0 ? 1 : DOTS - 2, dy, PAL.shallow);
          if (rand() < 0.7) dot(dx, dy === 0 ? 1 : DOTS - 2, PAL.shallow);
        };
        cornerFoam(nb.nw, nb.n, nb.w, 0, 0);
        cornerFoam(nb.ne, nb.n, nb.e, DOTS - 1, 0);
        cornerFoam(nb.sw, nb.s, nb.w, 0, DOTS - 1);
        cornerFoam(nb.se, nb.s, nb.e, DOTS - 1, DOTS - 1);
        break;
      }
      case 'forest': {
        fill(PAL.forestBase);
        // 樹冠の塊（円形のドット集団）を重ねる
        for (let i = 0; i < 8; i++) {
          const cx = 1 + Math.floor(rand() * 14), cy = 1 + Math.floor(rand() * 14);
          const r = 1 + Math.floor(rand() * 2);
          const c = rand() < 0.7 ? PAL.forestCanopy : PAL.forestLight;
          for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            if (dx * dx + dy * dy > r * r + 1) continue;
            const x = cx + dx, y = cy + dy;
            if (x < 0 || y < 0 || x >= DOTS || y >= DOTS) continue;
            if (rand() < 0.85) dot(x, y, c);
          }
        }
        speck([PAL.forestHi], 5);
        speck([PAL.forestShadow], 8);
        // 外周: 森でない側に明るい縁（葉の張り出し）と、下辺には影
        const fringe = (side, open) => {
          if (open) return;
          for (let i = 0; i < DOTS; i++) {
            if (rand() < 0.35) continue;
            if (side === 'n') dot(i, 0, PAL.forestLight);
            else if (side === 'w') dot(0, i, PAL.forestLight);
            else if (side === 'e') dot(DOTS - 1, i, PAL.forestLight);
            else { dot(i, DOTS - 1, PAL.forestShadow); if (rand() < 0.5) dot(i, DOTS - 2, PAL.forestShadow); }
          }
        };
        fringe('n', nb.n); fringe('w', nb.w); fringe('e', nb.e); fringe('s', nb.s);
        break;
      }
      case 'road': {
        fill(PAL.roadBase);
        speck([PAL.roadLight, PAL.roadStone], 16);
        speck([PAL.roadDark], 10);
        // 道以外に接する辺は土を暗く締める
        if (!nb.n) edgeBand('n', [PAL.roadDark]);
        if (!nb.s) edgeBand('s', [PAL.roadDark]);
        if (!nb.w) edgeBand('w', [PAL.roadDark]);
        if (!nb.e) edgeBand('e', [PAL.roadDark]);
        break;
      }
      case 'danger': {
        fill(PAL.dangerBase);
        // ひび割れ（短い折れ線）
        for (let i = 0; i < 3; i++) {
          let x = Math.floor(rand() * 12), y = Math.floor(rand() * DOTS);
          for (let s = 0; s < 4; s++) {
            dot(x, y, PAL.dangerCrack);
            x += rand() < 0.6 ? 1 : 0;
            y += rand() < 0.5 ? (rand() < 0.5 ? 1 : -1) : 0;
            if (x >= DOTS || y < 0 || y >= DOTS) break;
          }
        }
        speck([PAL.dangerEmber], 3);
        speck(['#551b1e'], 10);
        // 危険地帯でない側にギザギザの黒縁
        const jag = (side, open) => {
          if (open) return;
          for (let i = 0; i < DOTS; i++) {
            if (rand() < 0.2) continue;
            if (side === 'n') dot(i, 0, PAL.dangerEdge);
            else if (side === 's') dot(i, DOTS - 1, PAL.dangerEdge);
            else if (side === 'w') dot(0, i, PAL.dangerEdge);
            else dot(DOTS - 1, i, PAL.dangerEdge);
          }
        };
        jag('n', nb.n); jag('s', nb.s); jag('w', nb.w); jag('e', nb.e);
        break;
      }
      case 'rock': {
        fill(PAL.rockBase);
        // 左上のハイライトと右下の影で岩の立体感
        for (let i = 0; i < 7; i++) dot(1 + Math.floor(rand() * 5), 1 + Math.floor(rand() * 4), PAL.rockLight);
        for (let i = 0; i < 7; i++) dot(10 + Math.floor(rand() * 5), 11 + Math.floor(rand() * 4), PAL.rockDark);
        // ひび
        let x = 3 + Math.floor(rand() * 6), y = 2;
        while (y < DOTS - 2) { dot(x, y, PAL.rockCrack); y += 1; if (rand() < 0.4) x += rand() < 0.5 ? 1 : -1; }
        speck([PAL.rockDark, PAL.rockLight], 8);
        if (!nb.s) edgeBand('s', [PAL.rockDark]);
        break;
      }
      case 'soil': {
        fill(PAL.soilBase);
        speck([PAL.soilDark, PAL.soilLight], 22);
        speck([PAL.soilStone], 3);
        break;
      }
      default: { // ground (0,1,2) と石畳 (3)
        if (id === 3) {
          // 石畳: 目地を入れて舗装と分かるようにしつつ、トーンは周囲の
          // 地面に合わせた暗さに留める（明るすぎると白いダメージ数字や
          // エフェクトが見えにくくなるため。2026-11-12 浩之様の指摘）
          fill(PAL.stoneSeam);
          for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
            const c = PAL.stoneBase[Math.floor(rand() * PAL.stoneBase.length)];
            for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) dot(sx * 8 + 1 + dx, sy * 8 + 1 + dy, c);
          }
          speck(PAL.stoneSpeck, 14);
        } else {
          fill(PAL.groundBase[id] || PAL.groundBase[0]);
          speck(PAL.groundSpeck, id >= 2 ? 10 : 15);
          if (rand() < 0.5) dot(Math.floor(rand() * DOTS), Math.floor(rand() * DOTS), '#4a4a4a'); // 小石
        }
        // 水に接する辺には砂地の縁取り（地面側から岸を作る）
        if (isWater(0, -1)) edgeBand('n', [PAL.sand]);
        if (isWater(0, 1)) edgeBand('s', [PAL.sand]);
        if (isWater(-1, 0)) edgeBand('w', [PAL.sand]);
        if (isWater(1, 0)) edgeBand('e', [PAL.sand]);
        break;
      }
    }
  }

  return { paintTile, familyOf, DOTS, SCALE };
})();

if (typeof module !== 'undefined') module.exports = { MapChips };
