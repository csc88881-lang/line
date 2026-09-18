/**
 * Sticker Studio PRO - LINE 貼圖智慧綠幕去背 & 5x4 自動對齊分割工作站
 * 融合 CODEX 核心演算法：
 * 1. 3D 歐氏色距綠幕判定 + 連續容差滑桿
 * 2. 雙重去背模式：保護主體內部綠色 (Outer BFS 邊緣泛洪) vs 全域清除封閉洞 (All)
 * 3. 邊緣 2px 亞像素級去溢色與 Alpha 重建平滑還原 (Decontamination / Despill)
 * 4. 投影直方圖尋谷自動格線對齊演算法 (findLines Valley Seam Search)
 * 5. 智慧輪廓分割與動態規劃接縫裁切避讓 (splitContours Seam Carving)
 * 6. 可拖曳格線微調畫布 (#sheetCanvas)
 * 7. LINE 官方規格安全框 (370x320, 10px padding) 幾何等比縮放與 Clamp 約束平移 (geom & output)
 * 8. 單張微調工作台：平移、橡皮擦、還原筆刷、點選去背魔術棒、復原/重做、置中、重設、本張縮放
 * 9. 原生純 JS 二進位 ZIP 打包 (內建 CRC32，零外部庫依賴)
 * 10. 可編輯專案檔 (.json) 儲存與開啟
 * 11. 保留 Main (240x240) 與 Tab (96x74) 專用指派與 LINE 聊天室即時模擬預覽
 */

(function () {
  'use strict';

  // --- Helper Shortcuts ---
  const $ = (id) => document.getElementById(id);
  const C = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });

  // --- Application State ---
  const state = {
    source: null,               // HTMLImageElement
    sourceData: '',             // Image URL / DataURL
    sourceMask: null,           // Uint8Array of w * h

    // Grid divider pixel coordinates on source image
    xs: [],                     // [0, x1, x2, x3, x4, w] (length 6 for 5 cols)
    ys: [],                     // [0, y1, y2, y3, h] (length 5 for 4 rows)
    cols: 5,
    rows: 4,

    // Slicing & background removal modes
    splitMode: 'contour',       // 'contour' (智慧分區避讓分割) or 'grid' (依格線裁切)
    bgRemovalMode: 'outer',     // 'outer' (保護主體綠色) or 'all' (移除所有相近綠色含封閉洞)
    tolerance: 80,              // 20 ~ 160

    // Output specs (LINE Standard)
    outW: 370,
    outH: 320,
    padding: 10,

    // Sticker Items List
    // Each item: { id, filename, canvas, original, scale, dx, dy, undo: [], redo: [], edge: bool, empty: bool }
    items: [],
    selected: 0,                // 0 ~ 19

    // Special Assets
    mainIndex: 0,               // Main 封面 index
    tabIndex: 0,                // Tab 頁籤 index

    // Single Sticker Editor Tool: 'move' | 'erase' | 'restore' | 'magic'
    activeTool: 'move',
    brushSize: 18,

    // Background preview: 'checker' | 'white' | 'dark' | 'line' | 'pink'
    previewBg: 'checker',

    // View mode: 'grid' (格線裁切視圖) | 'sheet' (原圖拖曳格線) | 'processed' (全圖去背) | 'split' (即時對比)
    viewMode: 'grid',

    // Flags
    dirty: false,
    busy: false
  };

  // --- Toast Notification ---
  function showToast(msg, isSuccess = true) {
    const toast = $('toast');
    const toastMsg = $('toastMsg');
    if (!toast || !toastMsg) return;
    toastMsg.textContent = msg;
    const icon = toast.querySelector('i');
    if (icon) {
      icon.className = isSuccess ? 'fa-solid fa-circle-check text-emerald-400' : 'fa-solid fa-triangle-exclamation text-amber-400';
    }
    toast.classList.remove('translate-y-20', 'opacity-0');
    setTimeout(() => {
      toast.classList.add('translate-y-20', 'opacity-0');
    }, 2600);
  }

  function setStatus(s) {
    const statusEl = $('statusText');
    if (statusEl) statusEl.textContent = s;
  }

  function showProcessing(show, text = '處理中...') {
    const badge = $('loadingBadge');
    const badgeText = $('loadingText');
    if (!badge) return;
    if (show) {
      if (badgeText) badgeText.textContent = text;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  // --- Image & File Utilities ---
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('圖片無法載入，請確認檔案格式'));
      img.src = url;
    });
  }

  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  const tick = () => new Promise((r) => setTimeout(r, 20));

  // --- 1. CODEX Euclidean Chroma Key & Decontamination Engine ---

  /**
   * 歐氏距離綠幕色彩檢測
   * 1. g > 110: 綠色通道有基礎亮度
   * 2. g - max(r,b) > 28: 綠色通道具備明顯主導優勢
   * 3. Math.hypot(r, 255 - g, b) < t: 與純綠色 (0, 255, 0) 在 3D RGB 色空間的幾何距離小於容差 t
   */
  function isKeyGreen(r, g, b, t) {
    return g > 110 && (g - Math.max(r, b)) > 28 && Math.hypot(r, 255 - g, b) < t;
  }

  /**
   * 雙模式遮罩生成：
   * - outer (保護主體綠色)：從 4 個外邊界注入種子做 BFS 擴散，保護內部封閉的綠色物件 (如 K 線圖、鈔票、發財樹、雷達)
   * - all (移除所有相近綠色)：清除全圖所有相近綠色，包含四肢封閉綠洞
   */
  function generateMask(data, w, h, all, t) {
    const mask = new Uint8Array(w * h);
    const q = new Int32Array(w * h);
    let start = 0, end = 0;

    const add = (i) => {
      if (!mask[i] && isKeyGreen(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], t)) {
        mask[i] = 1;
        q[end++] = i;
      }
    };

    if (all) {
      for (let i = 0; i < w * h; i++) {
        if (isKeyGreen(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], t)) {
          mask[i] = 1;
        }
      }
      return mask;
    }

    // Outer 邊界種子泛洪
    for (let x = 0; x < w; x++) {
      add(x);
      add((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
      add(y * w);
      add(y * w + w - 1);
    }

    while (start < end) {
      const i = q[start++];
      const x = i % w;
      if (x > 0) add(i - 1);
      if (x < w - 1) add(i + 1);
      if (i >= w) add(i - w);
      if (i < w * (h - 1)) add(i + w);
    }
    return mask;
  }

  /**
   * 去背核心與 2-pixel 亞像素去溢光平滑還原 (Cleaned Canvas with Despill)
   */
  function getCleanedSourceCanvas() {
    if (!state.source) return null;
    const w = state.source.width;
    const h = state.source.height;
    const c = C(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(state.source, 0, 0);

    const im = ctx.getImageData(0, 0, w, h);
    const d = im.data;
    const isAll = state.bgRemovalMode === 'all';
    const tol = Number(state.tolerance) || 80;

    const m = generateMask(d, w, h, isAll, tol);
    state.sourceMask = m;

    for (let i = 0; i < m.length; i++) {
      const k = i * 4;
      if (m[i]) {
        d[k] = d[k + 1] = d[k + 2] = d[k + 3] = 0;
        continue;
      }

      // 只對緊鄰被清除背景 2 個像素內的邊界邊緣做溢光消除 (Decontamination)
      const x = i % w;
      const y = (i / w) | 0;
      let near = false;
      for (let yy = Math.max(0, y - 2); yy <= Math.min(h - 1, y + 2) && !near; yy++) {
        for (let xx = Math.max(0, x - 2); xx <= Math.min(w - 1, x + 2); xx++) {
          if (m[yy * w + xx]) {
            near = true;
            break;
          }
        }
      }

      if (near && d[k + 1] > Math.max(d[k], d[k + 2]) + 8) {
        let a = 1 - (d[k + 1] - Math.max(d[k], d[k + 2])) / 255;
        a = Math.max(0, Math.min(1, a));
        if (a < 0.08) {
          d[k + 3] = 0;
        } else {
          d[k] = Math.min(255, d[k] / a);
          d[k + 2] = Math.min(255, d[k + 2] / a);
          d[k + 1] = Math.max(d[k], d[k + 2]);
          d[k + 3] = Math.round(d[k + 3] * a);
        }
      }
    }

    ctx.putImageData(im, 0, 0);
    return c;
  }

  // --- 2. CODEX 投影直方圖尋谷演算法 (findLines) ---

  /**
   * 計算非透明度投影直方圖並自動吸附到貼圖間的空白深谷 (Valley Seam)
   */
  function findGridLines(cleanedCanvas) {
    if (!cleanedCanvas) return;
    const w = cleanedCanvas.width;
    const h = cleanedCanvas.height;
    const d = cleanedCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;

    function axisSeams(n, other, count, vertical) {
      const sums = new Float64Array(n);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          sums[vertical ? x : y] += d[(y * w + x) * 4 + 3] / 255;
        }
      }

      const arr = [0];
      for (let j = 1; j < count; j++) {
        const target = n * j / count;
        const range = n / count * 0.2;
        let best = Math.round(target);
        let score = Infinity;
        const minK = Math.max(1, Math.floor(target - range));
        const maxK = Math.min(n - 1, Math.ceil(target + range));

        for (let k = minK; k < maxK; k++) {
          const s = (sums[k - 1] + sums[k] + sums[k + 1]) / 3 + Math.abs(k - target) / n * other * 0.03;
          if (s < score) {
            score = s;
            best = k;
          }
        }
        arr.push(best);
      }
      arr.push(n);
      return arr;
    }

    state.xs = axisSeams(w, h, state.cols, true);
    state.ys = axisSeams(h, w, state.rows, false);
  }

  // --- 3. CODEX 輪廓連通分割與 Seam Carving 動態規劃避讓 (splitContours) ---

  function splitByContours(c) {
    const w = c.width;
    const h = c.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const im = ctx.getImageData(0, 0, w, h);
    const d = im.data;
    const totalCells = state.cols * state.rows;
    const labels = new Int32Array(w * h);
    const queue = new Int32Array(w * h);
    const comps = [null];
    let id = 0;

    for (let start = 0; start < w * h; start++) {
      if (labels[start] || d[start * 4 + 3] < 8) continue;
      id++;
      let head = 0, tail = 1;
      queue[0] = start;
      labels[start] = id;
      let minX = w, minY = h, maxX = 0, maxY = 0;
      let sumX = 0, sumY = 0;
      const occupancy = new Uint32Array(totalCells);

      while (head < tail) {
        const i = queue[head++];
        const x = i % w;
        const y = (i / w) | 0;
        sumX += x;
        sumY += y;

        const cc = state.xs.findIndex((v, k) => k && v > x) - 1;
        const rr = state.ys.findIndex((v, k) => k && v > y) - 1;
        if (cc >= 0 && rr >= 0) {
          const cw = state.xs[cc + 1] - state.xs[cc];
          const ch = state.ys[rr + 1] - state.ys[rr];
          if (x > state.xs[cc] + cw * 0.18 && x < state.xs[cc + 1] - cw * 0.18 &&
              y > state.ys[rr] + ch * 0.18 && y < state.ys[rr + 1] - ch * 0.18) {
            occupancy[rr * state.cols + cc]++;
          }
        }

        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
          for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
            const j = yy * w + xx;
            if (!labels[j] && d[j * 4 + 3] >= 8) {
              labels[j] = id;
              queue[tail++] = j;
            }
          }
        }
      }

      const mx = sumX / tail;
      const my = sumY / tail;
      const col = Math.min(state.cols - 1, Math.max(0, state.xs.findIndex((n, i) => i && n > mx) - 1));
      const row = Math.min(state.rows - 1, Math.max(0, state.ys.findIndex((n, i) => i && n > my) - 1));
      const isMulti = Array.from(occupancy).filter(n => n > (w * h / totalCells) * 0.06).length > 1;

      comps.push({
        multi: isMulti,
        count: tail,
        minX, minY, maxX, maxY,
        group: tail < 8 ? -1 : row * state.cols + col
      });
    }

    // Dynamic Programming Seam Carving across vertical & horizontal gutters
    function carveSeam(target, vertical) {
      const length = vertical ? h : w;
      const extent = vertical ? w : h;
      const band = Math.max(8, Math.round(extent / (vertical ? state.cols : state.rows) * 0.18));
      const lo = Math.max(1, target - band);
      const hi = Math.min(extent - 2, target + band);
      const size = hi - lo + 1;
      const back = new Int8Array(length * size);
      let prev = new Float64Array(size);
      let next = new Float64Array(size);

      for (let t = 0; t < length; t++) {
        for (let k = 0; k < size; k++) {
          const v = lo + k;
          const x = vertical ? v : t;
          const y = vertical ? t : v;
          const a = d[(y * w + x) * 4 + 3] / 255;
          const cost = a * a * (2 + 80 * (1 - Math.min(d[(y*w+x)*4], d[(y*w+x)*4+1], d[(y*w+x)*4+2]) / 255)) + Math.abs(v - target) / band * 0.5;
          let best = prev[k];
          let step = 0;
          if (k > 0 && prev[k - 1] + 0.12 < best) {
            best = prev[k - 1] + 0.12;
            step = -1;
          }
          if (k + 1 < size && prev[k + 1] + 0.12 < best) {
            best = prev[k + 1] + 0.12;
            step = 1;
          }
          next[k] = cost + (t ? best : 0);
          back[t * size + k] = step;
        }
        const tmp = prev;
        prev = next;
        next = tmp;
      }

      let k = 0;
      for (let j = 1; j < size; j++) {
        if (prev[j] < prev[k]) k = j;
      }

      const line = new Int32Array(length);
      for (let t = length - 1; t >= 0; t--) {
        line[t] = lo + k;
        k += back[t * size + k];
      }
      return line;
    }

    const vertical = state.xs.slice(1, -1).map(x => carveSeam(x, true));
    const horizontal = state.ys.slice(1, -1).map(y => carveSeam(y, false));
    const owners = new Int8Array(w * h);
    owners.fill(-1);

    const bounds = Array.from({ length: totalCells }, () => ({
      minX: w, minY: h, maxX: -1, maxY: -1, count: 0
    }));

    const splitCount = comps.slice(1).filter(a => a.multi).length;

    for (let i = 0; i < w * h; i++) {
      const comp = comps[labels[i]];
      if (!comp || comp.group < 0) continue;
      const x = i % w;
      const y = (i / w) | 0;
      let n = comp.group;
      if (comp.multi) {
        const col = vertical.filter(a => x >= a[y]).length;
        const row = horizontal.filter(a => y >= a[x]).length;
        n = row * state.cols + col;
      }
      owners[i] = n;
      const b = bounds[n];
      if (x < b.minX) b.minX = x;
      if (x > b.maxX) b.maxX = x;
      if (y < b.minY) b.minY = y;
      if (y > b.maxY) b.maxY = y;
      b.count++;
    }

    state.items = [];
    for (let n = 0; n < totalCells; n++) {
      const b = bounds[n];
      const empty = !b.count;
      const minX = empty ? 0 : b.minX;
      const minY = empty ? 0 : b.minY;
      const maxX = empty ? 0 : b.maxX;
      const maxY = empty ? 0 : b.maxY;

      const tile = C(maxX - minX + 1, maxY - minY + 1);
      const g = tile.getContext('2d');
      const out = g.createImageData(tile.width, tile.height);

      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const i = y * w + x;
          if (owners[i] === n) {
            out.data.set(d.subarray(i * 4, i * 4 + 4), ((y - minY) * tile.width + x - minX) * 4);
          }
        }
      }
      g.putImageData(out, 0, 0);

      const original = C(tile.width, tile.height);
      original.getContext('2d').drawImage(tile, 0, 0);

      const isEdge = tile.width > (w / state.cols) * 1.6 || tile.height > (h / state.rows) * 1.6;

      state.items.push({
        id: n + 1,
        filename: `${String(n + 1).padStart(2, '0')}.png`,
        canvas: tile,
        original: original,
        scale: 1,
        dx: 0,
        dy: 0,
        undo: [],
        redo: [],
        edge: isEdge,
        empty: empty
      });
    }

    state.selected = 0;
    renderGallery();
    renderMainDisplay();
    renderSheetCanvas();

    const emptyCount = state.items.filter(a => a.empty).length;
    const msg = emptyCount
      ? `注意：有 ${emptyCount} 格空白，請檢查格線與素材。`
      : `已分割 ${totalCells} 張 · ${splitCount ? `已拆開 ${splitCount} 組跨格相連輪廓 · ` : ''}去背置中完成`;
    setStatus(msg);
    showToast(msg);
  }

  function splitByGrid(c) {
    const w = c.width;
    const h = c.height;
    const all = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const totalCells = state.cols * state.rows;
    state.items = [];

    let count = 0;
    for (let r = 0; r < state.rows; r++) {
      for (let col = 0; col < state.cols; col++) {
        count++;
        const x = state.xs[col];
        const y = state.ys[r];
        const cellW = state.xs[col + 1] - x;
        const cellH = state.ys[r + 1] - y;
        let minX = cellW, minY = cellH, maxX = -1, maxY = -1, edge = false;

        for (let yy = 0; yy < cellH; yy++) {
          for (let xx = 0; xx < cellW; xx++) {
            if (all[((y + yy) * w + x + xx) * 4 + 3] > 16) {
              if (xx < minX) minX = xx;
              if (xx > maxX) maxX = xx;
              if (yy < minY) minY = yy;
              if (yy > maxY) maxY = yy;
              if (xx === 0 || yy === 0 || xx === cellW - 1 || yy === cellH - 1) {
                edge = true;
              }
            }
          }
        }

        const empty = maxX < 0;
        if (empty) {
          minX = minY = maxX = maxY = 0;
        }

        const tile = C(maxX - minX + 1, maxY - minY + 1);
        tile.getContext('2d').drawImage(c, x + minX, y + minY, tile.width, tile.height, 0, 0, tile.width, tile.height);

        const original = C(tile.width, tile.height);
        original.getContext('2d').drawImage(tile, 0, 0);

        state.items.push({
          id: count,
          filename: `${String(count).padStart(2, '0')}.png`,
          canvas: tile,
          original: original,
          scale: 1,
          dx: 0,
          dy: 0,
          undo: [],
          redo: [],
          edge: edge,
          empty: empty
        });
      }
    }

    state.selected = 0;
    renderGallery();
    renderMainDisplay();
    renderSheetCanvas();

    const msg = `已依格線重新分割 ${totalCells} 張 · 透明背景已建立`;
    setStatus(msg);
    showToast(msg);
  }

  // --- 4. CODEX 安全留白幾何約束與輸出 (geom & output) ---

  /**
   * 計算貼圖在標準 LINE 畫布 (370x320) 的縮放與受限平移 (Clamp)
   * 保證任何縮放與拖曳絕對不會超出 10px 安全框！
   */
  function geom(it) {
    const W = state.outW;
    const H = state.outH;
    const P = state.padding;
    const availW = Math.max(2, W - 2 * P);
    const availH = Math.max(2, H - 2 * P);

    const baseScale = Math.min(availW / it.canvas.width, availH / it.canvas.height);
    const s = baseScale * it.scale;
    const w = it.canvas.width * s;
    const h = it.canvas.height * s;

    // 平移約束：不可超出留白邊緣
    const maxDx = Math.max(0, (availW - w) / 2);
    const maxDy = Math.max(0, (availH - h) / 2);
    it.dx = Math.max(-maxDx, Math.min(maxDx, it.dx));
    it.dy = Math.max(-maxDy, Math.min(maxDy, it.dy));

    return {
      s,
      w,
      h,
      x: (W - w) / 2 + it.dx,
      y: (H - h) / 2 + it.dy
    };
  }

  /**
   * 將貼圖輸出繪製在標準 370x320 透明背景 Canvas
   */
  function outputCanvas(it) {
    const c = C(state.outW, state.outH);
    const g = geom(it);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(it.canvas, g.x, g.y, g.w, g.h);
    return c;
  }

  // --- 5. 特別素材生成 (Main 240x240 & Tab 96x74) ---

  function generateSpecialAsset(type, stickerIndex) {
    const it = state.items[stickerIndex];
    if (!it) return null;
    const targetW = type === 'main' ? 240 : 96;
    const targetH = type === 'main' ? 240 : 74;
    const pad = type === 'main' ? 10 : 4;

    const c = C(targetW, targetH);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const availW = targetW - 2 * pad;
    const availH = targetH - 2 * pad;
    const scale = Math.min(availW / it.canvas.width, availH / it.canvas.height);
    const w = it.canvas.width * scale;
    const h = it.canvas.height * scale;
    const x = Math.round((targetW - w) / 2);
    const y = Math.round((targetH - h) / 2);

    ctx.drawImage(it.canvas, x, y, w, h);
    return c;
  }

  // --- 6. 原圖可拖曳格線畫布 (Sheet Canvas) ---

  function renderSheetCanvas() {
    if (!state.source) return;
    const c = $('sheetCanvas');
    if (!c) return;
    c.width = state.source.width;
    c.height = state.source.height;
    const g = c.getContext('2d');

    // 繪製原圖
    g.drawImage(state.source, 0, 0);

    // 繪製橘色分割格線
    g.strokeStyle = '#f59e0b';
    g.lineWidth = Math.max(2, c.width / 500);
    g.setLineDash([10, 6]);

    for (const x of state.xs.slice(1, -1)) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, c.height);
      g.stroke();
    }
    for (const y of state.ys.slice(1, -1)) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(c.width, y);
      g.stroke();
    }

    g.setLineDash([]);
    g.font = `bold ${Math.max(16, c.width / 60)}px sans-serif`;

    // 繪製格號徽章
    let count = 0;
    for (let r = 0; r < state.rows; r++) {
      for (let col = 0; col < state.cols; col++) {
        count++;
        const bx = state.xs[col] + 4;
        const by = state.ys[r] + 4;
        g.fillStyle = 'rgba(15, 23, 42, 0.85)';
        g.fillRect(bx, by, 36, 26);
        g.fillStyle = '#f8fafc';
        g.fillText(String(count).padStart(2, '0'), bx + 7, by + 20);
      }
    }
  }

  // 支援指標拖曳橘色格線微調
  let seamDrag = null;
  function initSheetDragEvents() {
    const c = $('sheetCanvas');
    if (!c) return;

    function getPos(e) {
      const r = c.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * c.width / r.width,
        y: (e.clientY - r.top) * c.height / r.height
      };
    }

    c.onpointerdown = (e) => {
      if (!state.source) return;
      const p = getPos(e);
      let d = Infinity;
      seamDrag = null;

      // 檢查是否點擊縱向格線
      state.xs.slice(1, -1).forEach((xVal, i) => {
        const dist = Math.abs(xVal - p.x);
        if (dist < d) {
          d = dist;
          seamDrag = { axis: 'x', i: i + 1 };
        }
      });

      // 檢查是否點擊橫向格線
      state.ys.slice(1, -1).forEach((yVal, i) => {
        const dist = Math.abs(yVal - p.y);
        if (dist < d) {
          d = dist;
          seamDrag = { axis: 'y', i: i + 1 };
        }
      });

      // 若距離格線大於容差，取消拖曳
      if (d > state.source.width * 0.03) {
        seamDrag = null;
        return;
      }
      c.setPointerCapture(e.pointerId);
    };

    c.onpointermove = (e) => {
      if (!seamDrag) return;
      const p = getPos(e);
      const arr = seamDrag.axis === 'x' ? state.xs : state.ys;
      arr[seamDrag.i] = Math.round(
        Math.max(arr[seamDrag.i - 1] + 10, Math.min(arr[seamDrag.i + 1] - 10, p[seamDrag.axis]))
      );
      renderSheetCanvas();
      setStatus('格線已調整，請點擊「依格線重新分割」套用');
    };

    c.onpointerup = c.onpointercancel = () => {
      seamDrag = null;
    };
  }

  // --- 7. 單張貼圖微調編輯器 (Move / Erase / Restore / Magic Wand / Undo / Redo) ---

  function snapshot(it) {
    const copy = C(it.canvas.width, it.canvas.height);
    copy.getContext('2d').drawImage(it.canvas, 0, 0);
    return {
      data: copy,
      scale: it.scale,
      dx: it.dx,
      dy: it.dy
    };
  }

  function pushUndo() {
    const it = state.items[state.selected];
    if (!it) return;
    it.undo.push(snapshot(it));
    if (it.undo.length > 20) it.undo.shift();
    it.redo = [];
    state.dirty = true;
  }

  function applySnapshot(it, snap) {
    const ctx = it.canvas.getContext('2d');
    ctx.clearRect(0, 0, it.canvas.width, it.canvas.height);
    ctx.drawImage(snap.data, 0, 0);
    it.scale = snap.scale;
    it.dx = snap.dx;
    it.dy = snap.dy;
    renderModalEditor();
    renderGalleryThumb(state.selected);
  }

  function paintBrush(p, last) {
    const it = state.items[state.selected];
    if (!it) return;
    const g = geom(it);
    const ctx = it.canvas.getContext('2d');

    const a = { x: (p.x - g.x) / g.s, y: (p.y - g.y) / g.s };
    const b = last ? { x: (last.x - g.x) / g.s, y: (last.y - g.y) / g.s } : a;
    const r = (Number(state.brushSize) || 18) / 2 / g.s;

    ctx.save();
    if (state.activeTool === 'erase') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = r * 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(a.x, a.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (state.activeTool === 'restore') {
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const steps = Math.max(1, Math.ceil(distance / Math.max(1, r / 2)));
      ctx.beginPath();
      for (let j = 0; j <= steps; j++) {
        const x = b.x + (a.x - b.x) * j / steps;
        const y = b.y + (a.y - b.y) * j / steps;
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
      ctx.clip();
      ctx.clearRect(0, 0, it.canvas.width, it.canvas.height);
      ctx.drawImage(it.original, 0, 0);
    }
    ctx.restore();
  }

  function magicWand(p) {
    const it = state.items[state.selected];
    if (!it) return;
    const g = geom(it);
    const w = it.canvas.width;
    const h = it.canvas.height;
    const x = Math.floor((p.x - g.x) / g.s);
    const y = Math.floor((p.y - g.y) / g.s);
    if (x < 0 || x >= w || y < 0 || y >= h) return;

    const ctx = it.canvas.getContext('2d', { willReadFrequently: true });
    const im = ctx.getImageData(0, 0, w, h);
    const d = im.data;
    const k = (y * w + x) * 4;
    const ref = [d[k], d[k + 1], d[k + 2]];
    if (!d[k + 3]) return; // 點選到已透明區域不動作

    const tol = Number(state.tolerance) || 80;
    const q = [y * w + x];
    const seen = new Uint8Array(w * h);
    seen[q[0]] = 1;

    for (let j = 0; j < q.length; j++) {
      const idx = q[j];
      const a = idx * 4;
      if (!d[a + 3] || Math.hypot(d[a] - ref[0], d[a + 1] - ref[1], d[a + 2] - ref[2]) > tol) {
        continue;
      }
      d[a + 3] = 0;
      const xx = idx % w;
      for (const n of [
        xx ? idx - 1 : -1,
        xx < w - 1 ? idx + 1 : -1,
        idx >= w ? idx - w : -1,
        idx < w * (h - 1) ? idx + w : -1
      ]) {
        if (n >= 0 && !seen[n]) {
          seen[n] = 1;
          q.push(n);
        }
      }
    }
    ctx.putImageData(im, 0, 0);
  }

  function initEditorModalEvents() {
    const c = $('modalCanvas');
    if (!c) return;

    function getCanvasPos(e) {
      const r = c.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * c.width / r.width,
        y: (e.clientY - r.top) * c.height / r.height
      };
    }

    let dragOp = null;

    c.onpointerdown = (e) => {
      if (!state.items.length) return;
      e.preventDefault();
      const p = getCanvasPos(e);
      pushUndo();
      const it = state.items[state.selected];
      dragOp = {
        p,
        dx: it.dx,
        dy: it.dy,
        last: p
      };
      c.setPointerCapture(e.pointerId);

      if (state.activeTool === 'magic') {
        magicWand(p);
      } else if (state.activeTool !== 'move') {
        paintBrush(p);
      }
      renderModalEditor();
      renderGalleryThumb(state.selected);
    };

    c.onpointermove = (e) => {
      if (!dragOp) return;
      const p = getCanvasPos(e);
      const it = state.items[state.selected];

      if (state.activeTool === 'move') {
        it.dx = dragOp.dx + (p.x - dragOp.p.x);
        it.dy = dragOp.dy + (p.y - dragOp.p.y);
      } else if (state.activeTool !== 'magic') {
        paintBrush(p, dragOp.last);
      }
      dragOp.last = p;
      renderModalEditor();
      renderGalleryThumb(state.selected);
    };

    c.onpointerup = c.onpointercancel = () => {
      dragOp = null;
    };
  }

  // --- 8. 介面渲染核心 (Gallery, Canvas View, LINE Simulator) ---

  function renderGalleryThumb(i) {
    const thumbCanvas = $(`thumbCanvas_${i}`);
    if (!thumbCanvas || !state.items[i]) return;
    thumbCanvas.width = state.outW;
    thumbCanvas.height = state.outH;
    const ctx = thumbCanvas.getContext('2d');
    ctx.clearRect(0, 0, state.outW, state.outH);
    ctx.drawImage(outputCanvas(state.items[i]), 0, 0);
  }

  function renderGallery() {
    const grid = $('stickersGrid');
    if (!grid) return;
    grid.innerHTML = '';

    state.items.forEach((it, i) => {
      const isMain = i === state.mainIndex;
      const isTab = i === state.tabIndex;
      const isSelected = i === state.selected;

      const card = document.createElement('div');
      card.className = `bg-[#131b28] border ${isSelected ? 'border-amber-400 ring-2 ring-amber-400/30' : 'border-[#222e42] hover:border-indigo-500/60'} rounded-xl p-2 relative flex flex-col cursor-pointer transition shadow-md group`;

      let badgeHtml = '';
      if (isMain) badgeHtml += '<span class="bg-emerald-500/20 text-emerald-400 text-[8px] font-black px-1.5 py-0.5 rounded border border-emerald-500/40">Main 封面</span> ';
      if (isTab) badgeHtml += '<span class="bg-cyan-500/20 text-cyan-400 text-[8px] font-black px-1.5 py-0.5 rounded border border-cyan-500/40">Tab 標籤</span>';

      let warnHtml = '';
      if (it.empty) {
        warnHtml = '<span class="text-rose-400 text-[8px] font-bold block mt-0.5">⚠️ 空白格</span>';
      } else if (it.edge) {
        warnHtml = '<span class="text-amber-400 text-[8px] font-bold block mt-0.5">⚠️ 邊界需檢查</span>';
      }

      card.innerHTML = `
        <div class="flex items-center justify-between mb-1 text-[10px]">
          <span class="font-bold text-slate-200">#${String(i + 1).padStart(2, '0')}</span>
          <div class="flex gap-1">${badgeHtml}</div>
        </div>
        <div class="w-full h-28 rounded-lg overflow-hidden bg-checker flex items-center justify-center relative border border-[#273449]">
          <canvas id="thumbCanvas_${i}" class="w-full h-full object-contain"></canvas>
        </div>
        ${warnHtml}
        <div class="flex items-center justify-between mt-1.5 pt-1 border-t border-[#1e293b] text-[9px]">
          <button class="text-indigo-400 hover:text-indigo-300 font-bold" data-action="edit" data-index="${i}">
            <i class="fa-solid fa-pen-to-square"></i> 微調
          </button>
          <div class="flex gap-1.5">
            <button class="${isMain ? 'text-emerald-400 font-bold' : 'text-slate-400 hover:text-slate-200'}" data-action="setMain" data-index="${i}" title="設為 Main 封面">★ Main</button>
            <button class="${isTab ? 'text-cyan-400 font-bold' : 'text-slate-400 hover:text-slate-200'}" data-action="setTab" data-index="${i}" title="設為 Tab 標籤">🏷️ Tab</button>
          </div>
        </div>
      `;

      card.onclick = (e) => {
        const btn = e.target.closest('button');
        if (btn) {
          const action = btn.dataset.action;
          const idx = parseInt(btn.dataset.index, 10);
          if (action === 'setMain') {
            state.mainIndex = idx;
            renderGallery();
            updateSpecialAssets();
            return;
          }
          if (action === 'setTab') {
            state.tabIndex = idx;
            renderGallery();
            updateSpecialAssets();
            return;
          }
        }
        state.selected = i;
        openModalEditor();
      };

      grid.appendChild(card);
      renderGalleryThumb(i);
    });

    const badge = $('stickerCountBadge');
    if (badge) badge.textContent = state.items.length;
    const summaryCount = $('summaryCount');
    if (summaryCount) summaryCount.textContent = state.items.length;

    updateSpecialAssets();
    updateLineSimulator();
  }

  function renderModalEditor() {
    if (!state.items.length) return;
    const it = state.items[state.selected];
    const c = $('modalCanvas');
    if (!c) return;

    c.width = state.outW;
    c.height = state.outH;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, state.outW, state.outH);

    // 繪製輸出貼圖 (已包含幾何縮放與平移)
    ctx.drawImage(outputCanvas(it), 0, 0);

    // 繪製 LINE 10px 安全留白框虛線 (橘色提示框，不會匯出)
    ctx.save();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(
      state.padding + 0.5,
      state.padding + 0.5,
      state.outW - 2 * state.padding - 1,
      state.outH - 2 * state.padding - 1
    );
    ctx.restore();

    // 更新介面數值
    const title = $('modalTitle');
    if (title) title.textContent = `貼圖 #${String(state.selected + 1).padStart(2, '0')} / ${state.items.length}`;
    const scaleSlider = $('itemScaleSlider');
    if (scaleSlider) scaleSlider.value = Math.round(it.scale * 100);
    const scaleVal = $('itemScaleVal');
    if (scaleVal) scaleVal.textContent = `${Math.round(it.scale * 100)}%`;

    const undoBtn = $('modalUndoBtn');
    if (undoBtn) undoBtn.disabled = !it.undo.length;
    const redoBtn = $('modalRedoBtn');
    if (redoBtn) redoBtn.disabled = !it.redo.length;

    const warnBox = $('modalWarningText');
    if (warnBox) {
      if (it.empty) {
        warnBox.textContent = '此格沒有找到貼圖主體，請檢查原圖或手動調整格線。';
        warnBox.className = 'text-rose-400 text-[10px] font-bold';
      } else if (it.edge) {
        warnBox.textContent = '注意：原圖邊界接觸分割線或與鄰近相連，建議調整格線或切換分割方式。';
        warnBox.className = 'text-amber-400 text-[10px] font-bold';
      } else {
        warnBox.textContent = '100% 為填滿 10px 安全框之最大尺寸；平移受到邊界限制，絕不超線切邊。';
        warnBox.className = 'text-slate-400 text-[10px]';
      }
    }
  }

  function openModalEditor() {
    const modal = $('editorModal');
    if (!modal) return;
    renderModalEditor();
    modal.classList.remove('hidden');
  }

  function closeModalEditor() {
    const modal = $('editorModal');
    if (modal) modal.classList.add('hidden');
  }

  // --- 9. 中央畫布顯示與視圖模式 ---

  function renderMainDisplay() {
    const mainC = $('mainCanvas');
    if (!mainC || !state.source) return;
    mainC.width = state.source.width;
    mainC.height = state.source.height;
    const ctx = mainC.getContext('2d');
    ctx.clearRect(0, 0, mainC.width, mainC.height);

    // 繪製去背後全圖
    const cleaned = getCleanedSourceCanvas();
    if (cleaned) {
      ctx.drawImage(cleaned, 0, 0);
    }

    // 繪製原圖對比畫布
    const origC = $('originalCanvas');
    if (origC) {
      origC.width = state.source.width;
      origC.height = state.source.height;
      const oCtx = origC.getContext('2d');
      oCtx.drawImage(state.source, 0, 0);
    }
  }

  function updateSpecialAssets() {
    const mainCanvas = generateSpecialAsset('main', state.mainIndex);
    const tabCanvas = generateSpecialAsset('tab', state.tabIndex);

    const mainPreview = $('mainIconPreview');
    if (mainPreview && mainCanvas) mainPreview.src = mainCanvas.toDataURL('image/png');

    const tabPreview = $('tabIconPreview');
    if (tabPreview && tabCanvas) tabPreview.src = tabCanvas.toDataURL('image/png');

    const sumMain = $('summaryMain');
    if (sumMain) sumMain.textContent = `#${state.mainIndex + 1}`;

    const sumTab = $('summaryTab');
    if (sumTab) sumTab.textContent = `#${state.tabIndex + 1}`;
  }

  function updateLineSimulator() {
    const it = state.items[state.selected] || state.items[0];
    if (!it) return;

    const simCurrent = $('simCurrentSticker');
    if (simCurrent) {
      simCurrent.src = outputCanvas(it).toDataURL('image/png');
    }

    const kbGrid = $('simKeyboardGrid');
    if (!kbGrid) return;
    kbGrid.innerHTML = '';

    state.items.forEach((item, i) => {
      const btn = document.createElement('button');
      btn.className = 'w-full h-9 rounded bg-[#131b28] hover:bg-[#1f2c41] p-1 flex items-center justify-center border border-[#222e42] transition';
      const img = document.createElement('img');
      img.src = outputCanvas(item).toDataURL('image/png');
      img.className = 'w-full h-full object-contain';
      btn.appendChild(img);
      btn.onclick = () => {
        if (simCurrent) {
          simCurrent.src = outputCanvas(item).toDataURL('image/png');
        }
      };
      kbGrid.appendChild(btn);
    });
  }

  // --- 10. 原生純 JS ZIP 封裝演算法 (CRC32 + Store Binary ZIP) ---

  const crcTable = Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) {
      n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    }
    return n >>> 0;
  });

  function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) {
      c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function buildNativeZipBlob(files) {
    const parts = [], cent = [];
    let offset = 0, centralSize = 0;
    const encoder = new TextEncoder();

    for (const f of files) {
      const name = encoder.encode(f.name);
      const data = f.data;
      const sum = crc32(data);

      // Local Header (30 + name.length bytes)
      const local = new Uint8Array(30 + name.length);
      const v = new DataView(local.buffer);
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, 20, true);
      v.setUint32(14, sum, true);
      v.setUint32(18, data.length, true);
      v.setUint32(22, data.length, true);
      v.setUint16(26, name.length, true);
      local.set(name, 30);
      parts.push(local, data);

      // Central Directory Header (46 + name.length bytes)
      const cd = new Uint8Array(46 + name.length);
      const d = new DataView(cd.buffer);
      d.setUint32(0, 0x02014b50, true);
      d.setUint16(4, 20, true);
      d.setUint16(6, 20, true);
      d.setUint32(16, sum, true);
      d.setUint32(20, data.length, true);
      d.setUint32(24, data.length, true);
      d.setUint16(28, name.length, true);
      d.setUint32(42, offset, true);
      cd.set(name, 46);
      cent.push(cd);

      centralSize += cd.length;
      offset += local.length + data.length;
    }

    // End of Central Directory Record (22 bytes)
    const end = new Uint8Array(22);
    const ed = new DataView(end.buffer);
    ed.setUint32(0, 0x06054b50, true);
    ed.setUint16(8, files.length, true);
    ed.setUint16(10, files.length, true);
    ed.setUint32(12, centralSize, true);
    ed.setUint32(16, offset, true);

    return new Blob([...parts, ...cent, end], { type: 'application/zip' });
  }

  function canvasToPngBytes(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(async (blob) => {
        if (!blob) return reject(new Error('PNG 轉換失敗'));
        const buffer = await blob.arrayBuffer();
        resolve(new Uint8Array(buffer));
      }, 'image/png');
    });
  }

  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 30000);
  }

  // --- 11. 全流程執行 (Load -> Find Lines -> Split) ---

  async function loadSourceImage(url) {
    showProcessing(true, '載入素材大圖中...');
    try {
      state.source = await loadImage(url);
      if (state.source.width * state.source.height > 25000000) {
        throw new Error('圖片解析度過高，請使用 2500 萬像素以內之素材');
      }
      state.sourceData = url;

      // 1. 去背並投影尋找格線 (findLines)
      showProcessing(true, '智慧分析背景間隙與吸附格線中...');
      await tick();
      const cleaned = getCleanedSourceCanvas();
      findGridLines(cleaned);

      // 2. 分割切圖
      showProcessing(true, '智慧輪廓避讓裁切中...');
      await tick();
      await executeSplit(cleaned);

      state.dirty = false;
      showToast('素材載入並完成智慧分割對齊！');
    } catch (err) {
      console.error(err);
      showToast(err.message || '載入失敗', false);
    } finally {
      showProcessing(false);
    }
  }

  async function executeSplit(cleaned) {
    cleaned = cleaned || getCleanedSourceCanvas();
    if (!cleaned) return;

    if (state.splitMode === 'contour') {
      splitByContours(cleaned);
    } else {
      splitByGrid(cleaned);
    }

    renderMainDisplay();
    renderSheetCanvas();
  }

  // --- 12. 專案儲存與讀取 (.json) ---

  function saveProjectJson() {
    if (!state.items.length) {
      showToast('請先載入素材後再儲存專案', false);
      return;
    }

    const project = {
      version: 2,
      splitMode: state.splitMode,
      bgRemovalMode: state.bgRemovalMode,
      tolerance: state.tolerance,
      cols: state.cols,
      rows: state.rows,
      outW: state.outW,
      outH: state.outH,
      padding: state.padding,
      xs: state.xs,
      ys: state.ys,
      mainIndex: state.mainIndex,
      tabIndex: state.tabIndex,
      source: state.sourceData,
      items: state.items.map((it) => ({
        id: it.id,
        image: it.canvas.toDataURL('image/png'),
        original: it.original.toDataURL('image/png'),
        scale: it.scale,
        dx: it.dx,
        dy: it.dy,
        edge: it.edge,
        empty: it.empty
      }))
    };

    const blob = new Blob([JSON.stringify(project)], { type: 'application/json' });
    downloadBlob(blob, 'sticker-studio-project.json');
    state.dirty = false;
    showToast('已儲存可編輯專案檔 (sticker-studio-project.json)');
  }

  async function loadProjectJson(file) {
    showProcessing(true, '還原專案資料中...');
    try {
      const text = await file.text();
      const p = JSON.parse(text);

      if (!p.source || !Array.isArray(p.items) || !Array.isArray(p.xs) || !Array.isArray(p.ys)) {
        throw new Error('不是有效的貼圖工坊專案檔');
      }

      state.source = await loadImage(p.source);
      state.sourceData = p.source;
      state.splitMode = p.splitMode || 'contour';
      state.bgRemovalMode = p.bgRemovalMode || 'outer';
      state.tolerance = p.tolerance || 80;
      state.cols = p.cols || 5;
      state.rows = p.rows || 4;
      state.outW = p.outW || 370;
      state.outH = p.outH || 320;
      state.padding = p.padding !== undefined ? p.padding : 10;
      state.xs = p.xs;
      state.ys = p.ys;
      state.mainIndex = p.mainIndex || 0;
      state.tabIndex = p.tabIndex || 0;

      const restoredItems = [];
      for (const it of p.items) {
        const cImg = await loadImage(it.image);
        const oImg = await loadImage(it.original);
        const cCanvas = C(cImg.width, cImg.height);
        const oCanvas = C(oImg.width, oImg.height);
        cCanvas.getContext('2d').drawImage(cImg, 0, 0);
        oCanvas.getContext('2d').drawImage(oImg, 0, 0);

        restoredItems.push({
          id: it.id,
          filename: `${String(it.id).padStart(2, '0')}.png`,
          canvas: cCanvas,
          original: oCanvas,
          scale: it.scale || 1,
          dx: it.dx || 0,
          dy: it.dy || 0,
          undo: [],
          redo: [],
          edge: it.edge || false,
          empty: it.empty || false
        });
      }

      state.items = restoredItems;
      state.selected = 0;
      state.dirty = false;

      // Sync Controls UI
      syncControlsUI();
      renderGallery();
      renderMainDisplay();
      renderSheetCanvas();

      showToast('專案已完整還原，可繼續編輯與匯出！');
    } catch (err) {
      console.error(err);
      showToast(err.message || '專案讀取失敗', false);
    } finally {
      showProcessing(false);
    }
  }

  function syncControlsUI() {
    const tolSlider = $('tolSlider');
    if (tolSlider) tolSlider.value = state.tolerance;
    const tolVal = $('tolVal');
    if (tolVal) tolVal.textContent = state.tolerance;

    const bgModeSelect = $('bgRemovalModeSelect');
    if (bgModeSelect) bgModeSelect.value = state.bgRemovalMode;

    const splitModeSelect = $('splitModeSelect');
    if (splitModeSelect) splitModeSelect.value = state.splitMode;

    const padSlider = $('paddingSlider');
    if (padSlider) padSlider.value = state.padding;
    const padVal = $('paddingVal');
    if (padVal) padVal.textContent = `${state.padding}px`;
  }

  // --- 13. DOM 事件監聽綁定 ---

  function initAppEvents() {
    // 範例按鈕
    const loadSample = () => loadSourceImage('sample_stickers.jpg');
    const btn1 = $('loadSampleBtn');
    if (btn1) btn1.onclick = loadSample;
    const btn2 = $('emptySampleBtn');
    if (btn2) btn2.onclick = loadSample;

    // 上傳檔案
    const fileInput = $('fileInput');
    const dropZone = $('dropZone');
    if (dropZone && fileInput) {
      dropZone.onclick = () => fileInput.click();
      fileInput.onchange = async () => {
        const f = fileInput.files[0];
        if (f) {
          const url = await readFileAsDataURL(f);
          await loadSourceImage(url);
        }
        fileInput.value = '';
      };

      dropZone.ondragover = (e) => {
        e.preventDefault();
        dropZone.classList.add('border-indigo-500');
      };
      dropZone.ondragleave = () => {
        dropZone.classList.remove('border-indigo-500');
      };
      dropZone.ondrop = async (e) => {
        e.preventDefault();
        dropZone.classList.remove('border-indigo-500');
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          const url = await readFileAsDataURL(e.dataTransfer.files[0]);
          await loadSourceImage(url);
        }
      };
    }

    // 專案檔案讀取
    const projectFileInput = $('projectFileInput');
    const openProjectBtn = $('openProjectBtn');
    const saveProjectBtn = $('saveProjectBtn');

    if (openProjectBtn && projectFileInput) {
      openProjectBtn.onclick = () => projectFileInput.click();
      projectFileInput.onchange = () => {
        if (projectFileInput.files && projectFileInput.files[0]) {
          loadProjectJson(projectFileInput.files[0]);
        }
        projectFileInput.value = '';
      };
    }
    if (saveProjectBtn) {
      saveProjectBtn.onclick = saveProjectJson;
    }

    // 綠幕容差滑桿
    const tolSlider = $('tolSlider');
    const tolVal = $('tolVal');
    if (tolSlider) {
      tolSlider.oninput = () => {
        state.tolerance = parseInt(tolSlider.value, 10);
        if (tolVal) tolVal.textContent = state.tolerance;
      };
      tolSlider.onchange = () => {
        if (state.source) {
          executeSplit();
        }
      };
    }

    // 去背模式下拉選單
    const bgModeSelect = $('bgRemovalModeSelect');
    if (bgModeSelect) {
      bgModeSelect.onchange = () => {
        state.bgRemovalMode = bgModeSelect.value;
        if (state.source) executeSplit();
      };
    }

    // 分割方式下拉選單
    const splitModeSelect = $('splitModeSelect');
    if (splitModeSelect) {
      splitModeSelect.onchange = () => {
        state.splitMode = splitModeSelect.value;
        if (state.source) executeSplit();
      };
    }

    // 自動尋找格線按鈕
    const autoFindLinesBtn = $('autoFindLinesBtn');
    if (autoFindLinesBtn) {
      autoFindLinesBtn.onclick = () => {
        if (!state.source) {
          showToast('請先載入圖片', false);
          return;
        }
        const cleaned = getCleanedSourceCanvas();
        findGridLines(cleaned);
        renderSheetCanvas();
        showToast('已沿背景間隙自動校準格線，點擊「重新分割」套用');
      };
    }

    // 依格線重新分割按鈕
    const reSplitBtn = $('reSplitBtn');
    if (reSplitBtn) {
      reSplitBtn.onclick = () => {
        if (!state.source) {
          showToast('請先載入圖片', false);
          return;
        }
        executeSplit();
      };
    }

    const reprocessBtn = $('reprocessBtn');
    if (reprocessBtn) {
      reprocessBtn.onclick = () => {
        if (state.source) executeSplit();
      };
    }

    // 安全留白滑桿
    const paddingSlider = $('paddingSlider');
    const paddingVal = $('paddingVal');
    if (paddingSlider) {
      paddingSlider.oninput = () => {
        state.padding = parseInt(paddingSlider.value, 10);
        if (paddingVal) paddingVal.textContent = `${state.padding}px`;
        renderGallery();
        renderModalEditor();
      };
    }

    // 視圖切換
    const viewProcessedBtn = $('viewProcessedBtn');
    const viewGridBtn = $('viewGridBtn');
    const viewSheetBtn = $('viewSheetBtn');
    const viewSplitBtn = $('viewSplitBtn');

    const updateViewTabs = (activeTab) => {
      [viewProcessedBtn, viewGridBtn, viewSheetBtn, viewSplitBtn].forEach((btn) => {
        if (!btn) return;
        if (btn === activeTab) {
          btn.className = 'px-3 py-1 rounded-md text-[11px] font-semibold bg-indigo-600 text-white border border-indigo-500 transition shadow-sm';
        } else {
          btn.className = 'px-3 py-1 rounded-md text-[11px] font-semibold bg-[#1a2333] text-slate-300 hover:text-white border border-transparent transition';
        }
      });

      const mainC = $('mainCanvas');
      const sheetC = $('sheetCanvas');
      const splitOverlay = $('splitOverlay');

      if (mainC) mainC.classList.toggle('hidden', state.viewMode === 'sheet');
      if (sheetC) sheetC.classList.toggle('hidden', state.viewMode !== 'sheet');
      if (splitOverlay) splitOverlay.classList.toggle('hidden', state.viewMode !== 'split');
    };

    if (viewProcessedBtn) {
      viewProcessedBtn.onclick = () => {
        state.viewMode = 'processed';
        updateViewTabs(viewProcessedBtn);
      };
    }
    if (viewGridBtn) {
      viewGridBtn.onclick = () => {
        state.viewMode = 'grid';
        updateViewTabs(viewGridBtn);
      };
    }
    if (viewSheetBtn) {
      viewSheetBtn.onclick = () => {
        state.viewMode = 'sheet';
        updateViewTabs(viewSheetBtn);
        renderSheetCanvas();
      };
    }
    if (viewSplitBtn) {
      viewSplitBtn.onclick = () => {
        state.viewMode = 'split';
        updateViewTabs(viewSplitBtn);
      };
    }

    // 背景底色選擇器
    document.querySelectorAll('.bg-mode-btn').forEach((btn) => {
      btn.onclick = () => {
        document.querySelectorAll('.bg-mode-btn').forEach((b) => b.classList.remove('border-indigo-500'));
        btn.classList.add('border-indigo-500');
        const bg = btn.dataset.bg;
        state.previewBg = bg;
        const wrapper = $('canvasWrapper');
        if (wrapper) {
          wrapper.className = `relative shadow-2xl rounded-lg overflow-hidden border border-[#273449] ${bg === 'checker' ? 'bg-checker' : ''}`;
          if (bg === 'white') wrapper.style.backgroundColor = '#ffffff';
          else if (bg === 'dark') wrapper.style.backgroundColor = '#080c14';
          else if (bg === 'line') wrapper.style.backgroundColor = '#849ebf';
          else if (bg === 'pink') wrapper.style.backgroundColor = '#df8cb1';
          else wrapper.style.backgroundColor = '';
        }
      };
    });

    // 右側頁籤切換 (貼圖清單 vs LINE 聊天室)
    const tabListBtn = $('tabListBtn');
    const tabSimBtn = $('tabSimBtn');
    const galleryContainer = $('galleryContainer');
    const simulatorContainer = $('simulatorContainer');

    if (tabListBtn && tabSimBtn) {
      tabListBtn.onclick = () => {
        tabListBtn.className = 'flex-1 py-1.5 text-xs font-bold text-indigo-400 border-b-2 border-indigo-500 flex items-center justify-center gap-1.5';
        tabSimBtn.className = 'flex-1 py-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200 border-b-2 border-transparent flex items-center justify-center gap-1.5';
        if (galleryContainer) galleryContainer.classList.remove('hidden');
        if (simulatorContainer) simulatorContainer.classList.add('hidden');
      };

      tabSimBtn.onclick = () => {
        tabSimBtn.className = 'flex-1 py-1.5 text-xs font-bold text-emerald-400 border-b-2 border-emerald-500 flex items-center justify-center gap-1.5';
        tabListBtn.className = 'flex-1 py-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200 border-b-2 border-transparent flex items-center justify-center gap-1.5';
        if (simulatorContainer) simulatorContainer.classList.remove('hidden');
        if (galleryContainer) galleryContainer.classList.add('hidden');
        updateLineSimulator();
      };
    }

    // Modal 編輯器按鈕群
    const modalCloseBtn = $('modalCloseBtn');
    if (modalCloseBtn) modalCloseBtn.onclick = closeModalEditor;

    // 工具切換
    const toolBtns = {
      move: $('toolMoveBtn'),
      erase: $('toolEraseBtn'),
      restore: $('toolRestoreBtn'),
      magic: $('toolMagicBtn')
    };

    Object.entries(toolBtns).forEach(([toolName, btn]) => {
      if (!btn) return;
      btn.onclick = () => {
        state.activeTool = toolName;
        Object.values(toolBtns).forEach((b) => {
          if (b) b.classList.remove('bg-indigo-600', 'text-white', 'font-bold');
        });
        btn.classList.add('bg-indigo-600', 'text-white', 'font-bold');
        const modalCanvas = $('modalCanvas');
        if (modalCanvas) {
          modalCanvas.style.cursor = toolName === 'move' ? 'move' : 'crosshair';
        }
      };
    });

    // 縮放滑桿
    const itemScaleSlider = $('itemScaleSlider');
    const itemScaleVal = $('itemScaleVal');
    if (itemScaleSlider) {
      itemScaleSlider.onpointerdown = pushUndo;
      itemScaleSlider.oninput = () => {
        if (!state.items.length) return;
        const it = state.items[state.selected];
        it.scale = parseInt(itemScaleSlider.value, 10) / 100;
        if (itemScaleVal) itemScaleVal.textContent = `${Math.round(it.scale * 100)}%`;
        renderModalEditor();
        renderGalleryThumb(state.selected);
      };
    }

    // 筆刷大小滑桿
    const brushSlider = $('modalBrushSlider');
    const brushVal = $('modalBrushVal');
    if (brushSlider) {
      brushSlider.oninput = () => {
        state.brushSize = parseInt(brushSlider.value, 10);
        if (brushVal) brushVal.textContent = `${state.brushSize}px`;
      };
    }

    // 置中按鈕
    const centerBtn = $('modalCenterBtn');
    if (centerBtn) {
      centerBtn.onclick = () => {
        if (!state.items.length) return;
        pushUndo();
        state.items[state.selected].dx = 0;
        state.items[state.selected].dy = 0;
        renderModalEditor();
        renderGalleryThumb(state.selected);
        showToast('已自動置中');
      };
    }

    // 重設本張按鈕
    const resetBtn = $('modalResetBtn');
    if (resetBtn) {
      resetBtn.onclick = () => {
        if (!state.items.length) return;
        pushUndo();
        const it = state.items[state.selected];
        const ctx = it.canvas.getContext('2d');
        ctx.clearRect(0, 0, it.canvas.width, it.canvas.height);
        ctx.drawImage(it.original, 0, 0);
        it.scale = 1;
        it.dx = 0;
        it.dy = 0;
        renderModalEditor();
        renderGalleryThumb(state.selected);
        showToast('本張貼圖已重設為原始裁切狀態');
      };
    }

    // 復原 / 重做
    const undoBtn = $('modalUndoBtn');
    if (undoBtn) {
      undoBtn.onclick = () => {
        const it = state.items[state.selected];
        if (!it || !it.undo.length) return;
        it.redo.push(snapshot(it));
        applySnapshot(it, it.undo.pop());
      };
    }

    const redoBtn = $('modalRedoBtn');
    if (redoBtn) {
      redoBtn.onclick = () => {
        const it = state.items[state.selected];
        if (!it || !it.redo.length) return;
        it.undo.push(snapshot(it));
        applySnapshot(it, it.redo.pop());
      };
    }

    // 單張下載
    const singleDownloadBtn = $('modalSingleDownloadBtn');
    if (singleDownloadBtn) {
      singleDownloadBtn.onclick = async () => {
        if (!state.items.length) return;
        const it = state.items[state.selected];
        const bytes = await canvasToPngBytes(outputCanvas(it));
        const blob = new Blob([bytes], { type: 'image/png' });
        downloadBlob(blob, it.filename);
      };
    }

    // 設為 Main / Tab
    const modalSetMain = $('modalSetMainBtn');
    if (modalSetMain) {
      modalSetMain.onclick = () => {
        state.mainIndex = state.selected;
        renderGallery();
        updateSpecialAssets();
        showToast(`已將 #${state.selected + 1} 設為 Main 封面 (240x240)`);
      };
    }

    const modalSetTab = $('modalSetTabBtn');
    if (modalSetTab) {
      modalSetTab.onclick = () => {
        state.tabIndex = state.selected;
        renderGallery();
        updateSpecialAssets();
        showToast(`已將 #${state.selected + 1} 設為 Tab 標籤 (96x74)`);
      };
    }

    // 導出全部 ZIP
    const exportZipBtn = $('exportAllZipBtn');
    if (exportZipBtn) {
      exportZipBtn.onclick = async () => {
        if (!state.items.length) {
          showToast('尚未載入任何貼圖', false);
          return;
        }

        showProcessing(true, '正在生成 20 張透明 PNG 與 LINE 專用包 (ZIP)...');
        try {
          const files = [];

          // 1. 20 張貼圖 (370x320 偶數尺寸、10px 留白)
          for (let i = 0; i < state.items.length; i++) {
            setStatus(`匯出中 (${i + 1}/${state.items.length})...`);
            const it = state.items[i];
            const bytes = await canvasToPngBytes(outputCanvas(it));
            files.push({
              name: it.filename,
              data: bytes
            });
          }

          // 2. main.png (240x240)
          const mainCanvas = generateSpecialAsset('main', state.mainIndex);
          if (mainCanvas) {
            const mainBytes = await canvasToPngBytes(mainCanvas);
            files.push({ name: 'main.png', data: mainBytes });
          }

          // 3. tab.png (96x74)
          const tabCanvas = generateSpecialAsset('tab', state.tabIndex);
          if (tabCanvas) {
            const tabBytes = await canvasToPngBytes(tabCanvas);
            files.push({ name: 'tab.png', data: tabBytes });
          }

          // 純 JS 原生打包
          const zipBlob = buildNativeZipBlob(files);
          downloadBlob(zipBlob, 'line_stickers_20_pack.zip');
          showToast('✨ LINE 貼圖包 (ZIP) 打包下載完成！包含 20 張貼圖 + main.png + tab.png');
        } catch (err) {
          console.error(err);
          showToast('ZIP 匯出失敗：' + err.message, false);
        } finally {
          showProcessing(false);
        }
      };
    }

    // 下載 Main & Tab 單張按鈕
    const dlMainBtn = $('downloadMainBtn');
    if (dlMainBtn) {
      dlMainBtn.onclick = async () => {
        const mc = generateSpecialAsset('main', state.mainIndex);
        if (mc) {
          const bytes = await canvasToPngBytes(mc);
          downloadBlob(new Blob([bytes], { type: 'image/png' }), 'main.png');
        }
      };
    }

    const dlTabBtn = $('downloadTabBtn');
    if (dlTabBtn) {
      dlTabBtn.onclick = async () => {
        const tc = generateSpecialAsset('tab', state.tabIndex);
        if (tc) {
          const bytes = await canvasToPngBytes(tc);
          downloadBlob(new Blob([bytes], { type: 'image/png' }), 'tab.png');
        }
      };
    }

    // 初始化畫布拖曳與微調事件
    initSheetDragEvents();
    initEditorModalEvents();
  }

  // --- 14. 程式啟動初始化 ---
  document.addEventListener('DOMContentLoaded', () => {
    initAppEvents();

    // 自動預載台股壁虎貼圖範例
    setTimeout(() => {
      loadSourceImage('sample_stickers.jpg');
    }, 150);
  });
})();
