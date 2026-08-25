/**
 * Sticker Studio PRO - LINE Sticker Background Remover & Grid Splitter
 * Ultra-fast client-side Canvas processing & LINE standard exporter
 */

(function () {
  'use strict';

  // State Management
  const state = {
    originalImage: null,
    processedCanvas: null,
    stickers: [], // Array of { id, filename, dataUrl, blob, canvas, width, height }
    mainIndex: 0,
    tabIndex: 0,
    currentView: 'processed', // 'processed', 'grid', 'split'
    currentBg: 'checker', // 'checker', 'dark', 'white', 'line'
    activeModalSticker: null,
    
    // Chroma key settings
    keyColor: '#07FD04',
    threshold: 55,
    smoothness: 20,
    despill: true,
    
    // State extensions
    brushSize: 12,
    
    // Grid settings
    cols: 5,
    rows: 4,
    padding: 10
  };

  // DOM Elements
  const DOM = {
    // Header & Actions
    loadSampleBtn: document.getElementById('loadSampleBtn'),
    emptyLoadSampleBtn: document.getElementById('emptyLoadSampleBtn'),
    exportAllZipBtn: document.getElementById('exportAllZipBtn'),
    fileInput: document.getElementById('fileInput'),
    dropZone: document.getElementById('dropZone'),
    
    // Controls
    keyColorInput: document.getElementById('keyColorInput'),
    keyColorVal: document.getElementById('keyColorVal'),
    thresholdSlider: document.getElementById('thresholdSlider'),
    threshVal: document.getElementById('threshVal'),
    smoothnessSlider: document.getElementById('smoothnessSlider'),
    smoothVal: document.getElementById('smoothVal'),
    despillToggle: document.getElementById('despillToggle'),
    presetBtns: document.querySelectorAll('.preset-btn'),
    colsInput: document.getElementById('colsInput'),
    rowsInput: document.getElementById('rowsInput'),
    paddingSlider: document.getElementById('paddingSlider'),
    paddingVal: document.getElementById('paddingVal'),
    
    // Workspace & Canvas
    emptyState: document.getElementById('emptyState'),
    canvasStage: document.getElementById('canvasStage'),
    canvasWrapper: document.getElementById('canvasWrapper'),
    mainCanvas: document.getElementById('mainCanvas'),
    splitOverlay: document.getElementById('splitOverlay'),
    splitCanvas: document.getElementById('splitCanvas'),
    splitDivider: document.getElementById('splitDivider'),
    gridSvg: document.getElementById('gridSvg'),
    processingBadge: document.getElementById('processingBadge'),
    viewTabs: document.querySelectorAll('.view-tab'),
    bgBtns: document.querySelectorAll('.bg-btn'),
    
    // Right Panel
    tabStickerList: document.getElementById('tabStickerList'),
    tabLineSim: document.getElementById('tabLineSim'),
    stickerListView: document.getElementById('stickerListView'),
    lineSimView: document.getElementById('lineSimView'),
    stickersGrid: document.getElementById('stickersGrid'),
    stickerCountBadge: document.getElementById('stickerCountBadge'),
    galleryStatsText: document.getElementById('galleryStatsText'),
    reprocessBtn: document.getElementById('reprocessBtn'),
    
    // Special Assets
    mainImgPreview: document.getElementById('mainImgPreview'),
    tabImgPreview: document.getElementById('tabImgPreview'),
    downloadMainBtn: document.getElementById('downloadMainBtn'),
    downloadTabBtn: document.getElementById('downloadTabBtn'),
    
    // LINE Simulator
    simStickerImg: document.getElementById('simStickerImg'),
    simKeyboardGrid: document.getElementById('simKeyboardGrid'),
    chatMessagesArea: document.getElementById('chatMessagesArea'),
    
    // Modal & Eraser Editor
    stickerModal: document.getElementById('stickerModal'),
    modalCloseBtn: document.getElementById('modalCloseBtn'),
    modalPreviewBox: document.getElementById('modalPreviewBox'),
    editorCanvas: document.getElementById('editorCanvas'),
    brushCursor: document.getElementById('brushCursor'),
    brushSizeSlider: document.getElementById('brushSizeSlider'),
    brushSizeVal: document.getElementById('brushSizeVal'),
    editorResetBtn: document.getElementById('editorResetBtn'),
    editorSaveBtn: document.getElementById('editorSaveBtn'),
    modalTitle: document.getElementById('modalTitle'),
    modalBadges: document.getElementById('modalBadges'),
    modalFilename: document.getElementById('modalFilename'),
    modalDimensions: document.getElementById('modalDimensions'),
    modalDownloadBtn: document.getElementById('modalDownloadBtn'),
    modalSetMainBtn: document.getElementById('modalSetMainBtn'),
    modalSetTabBtn: document.getElementById('modalSetTabBtn')
  };

  // Helper: Hex to RGB
  function hexToRgb(hex) {
    const cleanHex = hex.replace('#', '');
    const bigint = parseInt(cleanHex, 16);
    return {
      r: (bigint >> 16) & 255,
      g: (bigint >> 8) & 255,
      b: bigint & 255
    };
  }

  // Ensure Even Number (LINE Specification Requirement)
  function makeEven(n) {
    let rounded = Math.round(n);
    if (rounded % 2 !== 0) rounded -= 1;
    return Math.max(2, rounded);
  }

  // Initialize Event Listeners
  function initEvents() {
    // Sample Button Clicks
    DOM.loadSampleBtn.addEventListener('click', loadSampleImage);
    DOM.emptyLoadSampleBtn.addEventListener('click', loadSampleImage);

    // File Upload
    DOM.dropZone.addEventListener('click', () => DOM.fileInput.click());
    DOM.fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        handleImageFile(e.target.files[0]);
      }
    });

    // Drag & Drop
    ['dragenter', 'dragover'].forEach(eventName => {
      DOM.dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        DOM.dropZone.classList.add('drag-over');
      });
    });

    ['dragleave', 'drop'].forEach(eventName => {
      DOM.dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        DOM.dropZone.classList.remove('drag-over');
      });
    });

    DOM.dropZone.addEventListener('drop', (e) => {
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleImageFile(e.dataTransfer.files[0]);
      }
    });

    // Controls change
    DOM.keyColorInput.addEventListener('input', (e) => {
      state.keyColor = e.target.value;
      DOM.keyColorVal.textContent = state.keyColor.toUpperCase();
      debouncedProcess();
    });

    DOM.thresholdSlider.addEventListener('input', (e) => {
      state.threshold = parseInt(e.target.value, 10);
      DOM.threshVal.textContent = state.threshold;
      debouncedProcess();
    });

    DOM.smoothnessSlider.addEventListener('input', (e) => {
      state.smoothness = parseInt(e.target.value, 10);
      DOM.smoothVal.textContent = state.smoothness;
      debouncedProcess();
    });

    DOM.despillToggle.addEventListener('change', (e) => {
      state.despill = e.target.checked;
      debouncedProcess();
    });

    DOM.paddingSlider.addEventListener('input', (e) => {
      state.padding = parseInt(e.target.value, 10);
      DOM.paddingVal.textContent = `${state.padding}px`;
      debouncedProcess();
    });

    // Grid Presets
    DOM.presetBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        DOM.presetBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.cols = parseInt(btn.dataset.cols, 10);
        state.rows = parseInt(btn.dataset.rows, 10);
        DOM.colsInput.value = state.cols;
        DOM.rowsInput.value = state.rows;
        debouncedProcess();
      });
    });

    DOM.colsInput.addEventListener('change', (e) => {
      state.cols = Math.max(1, parseInt(e.target.value, 10) || 5);
      debouncedProcess();
    });

    DOM.rowsInput.addEventListener('change', (e) => {
      state.rows = Math.max(1, parseInt(e.target.value, 10) || 4);
      debouncedProcess();
    });

    // View Toolbar Tabs
    DOM.viewTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        DOM.viewTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        state.currentView = tab.dataset.view;
        updateViewMode();
      });
    });

    // Background Selector
    DOM.bgBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        DOM.bgBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.currentBg = btn.dataset.bg;
        applyBackgroundMode();
      });
    });

    // Right Panel Tabs
    DOM.tabStickerList.addEventListener('click', () => {
      DOM.tabStickerList.classList.add('active');
      DOM.tabLineSim.classList.remove('active');
      DOM.stickerListView.classList.remove('hidden');
      DOM.lineSimView.classList.add('hidden');
    });

    DOM.tabLineSim.addEventListener('click', () => {
      DOM.tabLineSim.classList.add('active');
      DOM.tabStickerList.classList.remove('active');
      DOM.lineSimView.classList.remove('hidden');
      DOM.stickerListView.classList.add('hidden');
    });

    DOM.reprocessBtn.addEventListener('click', () => {
      if (state.originalImage) processFullWorkflow();
    });

    // Export All ZIP
    DOM.exportAllZipBtn.addEventListener('click', exportZipPackage);

    // Download Main & Tab
    DOM.downloadMainBtn.addEventListener('click', () => downloadSpecialAsset('main'));
    DOM.downloadTabBtn.addEventListener('click', () => downloadSpecialAsset('tab'));

    // Modal
    DOM.modalCloseBtn.addEventListener('click', closeModal);
    DOM.stickerModal.addEventListener('click', (e) => {
      if (e.target === DOM.stickerModal) closeModal();
    });

    // Initialize Editor & Eraser events
    initEditorEvents();

    // Split view drag
    initSplitSlider();
  }

  // Debounced Processing
  let debounceTimeout = null;
  function debouncedProcess() {
    if (!state.originalImage) return;
    showProcessing(true);
    clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(() => {
      processFullWorkflow();
      showProcessing(false);
    }, 120);
  }

  function showProcessing(show) {
    if (show) DOM.processingBadge.classList.remove('hidden');
    else DOM.processingBadge.classList.add('hidden');
  }

  // Load Built-in Sample Image
  function loadSampleImage() {
    showProcessing(true);
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
      state.originalImage = img;
      onImageLoaded();
      showProcessing(false);
    };
    img.onerror = () => {
      alert('無法載入範例圖片，請直接上傳圖片。');
      showProcessing(false);
    };
    img.src = 'sample_stickers.jpg';
  }

  // Handle User Uploaded Image
  function handleImageFile(file) {
    if (!file.type.startsWith('image/')) {
      alert('請選擇圖片檔案 (JPG / PNG / WEBP)');
      return;
    }
    showProcessing(true);
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        state.originalImage = img;
        onImageLoaded();
        showProcessing(false);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // Helper: Sample auto background key color from image edges & corners
  function autoDetectKeyColor(imgData, w, h) {
    const data = imgData.data;
    const sampleCoords = [
      0, 0,
      w - 1, 0,
      0, h - 1,
      w - 1, h - 1,
      Math.floor(w / 2), 0,
      Math.floor(w / 2), h - 1,
      0, Math.floor(h / 2),
      w - 1, Math.floor(h / 2)
    ];
    let rSum = 0, gSum = 0, bSum = 0, count = 0;
    for (let i = 0; i < sampleCoords.length; i += 2) {
      const x = sampleCoords[i];
      const y = sampleCoords[i + 1];
      const idx = (y * w + x) * 4;
      rSum += data[idx];
      gSum += data[idx + 1];
      bSum += data[idx + 2];
      count++;
    }
    const r = Math.round(rSum / count);
    const g = Math.round(gSum / count);
    const b = Math.round(bSum / count);
    const toHex = (n) => n.toString(16).padStart(2, '0');
    return {
      r, g, b,
      hex: `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase()
    };
  }

  function onImageLoaded() {
    DOM.emptyState.classList.add('hidden');
    DOM.canvasStage.classList.remove('hidden');
    DOM.exportAllZipBtn.removeAttribute('disabled');

    // Auto detect background key color
    const tempCanvas = document.createElement('canvas');
    const w = state.originalImage.naturalWidth || state.originalImage.width;
    const h = state.originalImage.naturalHeight || state.originalImage.height;
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(state.originalImage, 0, 0);
    const imgData = tempCtx.getImageData(0, 0, w, h);
    const detected = autoDetectKeyColor(imgData, w, h);
    if (detected && detected.hex) {
      state.keyColor = detected.hex;
      DOM.keyColorInput.value = detected.hex;
      DOM.keyColorVal.textContent = detected.hex;
    }

    // Auto calculate default grid
    processFullWorkflow();
  }

  // Core Workflow: Chroma Removal -> Slicing -> Formatting
  function processFullWorkflow() {
    if (!state.originalImage) return;

    const img = state.originalImage;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;

    // 1. Render & Chroma Key full sheet
    const offscreen = document.createElement('canvas');
    offscreen.width = w;
    offscreen.height = h;
    const ctx = offscreen.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);

    const imgData = ctx.getImageData(0, 0, w, h);
    removeGreenChroma(imgData.data, w, h);
    ctx.putImageData(imgData, 0, 0);
    state.processedCanvas = offscreen;

    // 2. Render Main Canvas View
    DOM.mainCanvas.width = w;
    DOM.mainCanvas.height = h;
    const mainCtx = DOM.mainCanvas.getContext('2d');
    mainCtx.clearRect(0, 0, w, h);
    mainCtx.drawImage(offscreen, 0, 0);

    // 3. Render Split Canvas (Original Image)
    DOM.splitCanvas.width = w;
    DOM.splitCanvas.height = h;
    const splitCtx = DOM.splitCanvas.getContext('2d');
    splitCtx.drawImage(img, 0, 0);

    // 4. Update Grid SVG Lines
    renderGridSvg(w, h);

    // 5. Slice into stickers & format to LINE specification
    sliceAndFormatStickers(offscreen, w, h);

    // 6. Update UI
    updateViewMode();
    applyBackgroundMode();
    updateGalleryView();
    updateSpecialAssets();
    updateLineSimulator();
  }

  // Intelligent Background Removal (Edge-Connected Flood Fill + Outer Fringe Choke + White Border Decontamination)
  function removeGreenChroma(pixels, width, height) {
    const totalPixels = width * height;

    const bgMask = new Uint8Array(totalPixels);
    const candidateMask = new Uint8Array(totalPixels);
    const queue = new Int32Array(totalPixels);
    let head = 0;
    let tail = 0;

    // 1. Pass 1: Background candidate and interior pocket seeds
    for (let i = 0, p = 0; i < totalPixels; i++, p += 4) {
      const r = pixels[p];
      const g = pixels[p + 1];
      const b = pixels[p + 2];

      const maxRb = Math.max(r, b);
      const dominance = g - maxRb;

      // Candidate background pixel: strong green dominance
      if (g > 160 && dominance > 50) {
        candidateMask[i] = 1;
      }

      // Strict chroma green seed for isolated interior pockets (between limbs/tails)
      if (g > 200 && dominance > 120 && r < 40 && b < 40) {
        bgMask[i] = 1;
        queue[tail++] = i;
      }
    }

    // 2. Add outer boundaries to flood fill queue
    // Top & Bottom
    for (let x = 0; x < width; x++) {
      const topIdx = x;
      const btmIdx = (height - 1) * width + x;
      if (candidateMask[topIdx] && !bgMask[topIdx]) {
        bgMask[topIdx] = 1;
        queue[tail++] = topIdx;
      }
      if (candidateMask[btmIdx] && !bgMask[btmIdx]) {
        bgMask[btmIdx] = 1;
        queue[tail++] = btmIdx;
      }
    }

    // Left & Right
    for (let y = 0; y < height; y++) {
      const leftIdx = y * width;
      const rightIdx = y * width + (width - 1);
      if (candidateMask[leftIdx] && !bgMask[leftIdx]) {
        bgMask[leftIdx] = 1;
        queue[tail++] = leftIdx;
      }
      if (candidateMask[rightIdx] && !bgMask[rightIdx]) {
        bgMask[rightIdx] = 1;
        queue[tail++] = rightIdx;
      }
    }

    // 3. BFS Flood Fill
    const dx = [-1, 1, 0, 0, -1, 1, -1, 1];
    const dy = [0, 0, -1, 1, -1, -1, 1, 1];

    while (head < tail) {
      const curr = queue[head++];
      const cx = curr % width;
      const cy = (curr / width) | 0;

      for (let d = 0; d < 8; d++) {
        const nx = cx + dx[d];
        const ny = cy + dy[d];
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          const nIdx = ny * width + nx;
          if (!bgMask[nIdx] && candidateMask[nIdx]) {
            bgMask[nIdx] = 1;
            queue[tail++] = nIdx;
          }
        }
      }
    }

    // 4. Outer Fringe Choke: clean 1px transition halo touching background
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (!bgMask[idx]) {
          const p = idx * 4;
          const r = pixels[p];
          const g = pixels[p + 1];
          const b = pixels[p + 2];
          const dom = g - Math.max(r, b);

          if (dom > 20) {
            // Check if touching bgMask
            let isAdjacentToBg = false;
            for (let d = 0; d < 8; d++) {
              const nx = x + dx[d];
              const ny = y + dy[d];
              if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                if (bgMask[ny * width + nx]) {
                  isAdjacentToBg = true;
                  break;
                }
              }
            }
            if (isAdjacentToBg) {
              bgMask[idx] = 1;
            }
          }
        }
      }
    }

    // 5. White Border Edge Decontamination (3px outer boundary)
    const edgeZone = new Uint8Array(totalPixels);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (!bgMask[idx]) {
          let distToBg = 999;
          // Check 3px radius
          for (let rOffset = -3; rOffset <= 3; rOffset++) {
            for (let cOffset = -3; cOffset <= 3; cOffset++) {
              const nx = x + cOffset;
              const ny = y + rOffset;
              if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                if (bgMask[ny * width + nx]) {
                  distToBg = Math.hypot(rOffset, cOffset);
                  break;
                }
              }
            }
            if (distToBg <= 3) break;
          }
          if (distToBg <= 3) edgeZone[idx] = 1;
        }
      }
    }

    // 6. Apply Final Alpha and Pure White Border Decontamination
    for (let i = 0, p = 0; i < totalPixels; i++, p += 4) {
      if (bgMask[i]) {
        pixels[p + 3] = 0; // 100% Transparent
      } else {
        pixels[p + 3] = 255; // 100% Opaque sticker content
        
        // Decontaminate white border on outer boundary: eliminate any remaining green ring/halo
        if (edgeZone[i]) {
          const r = pixels[p];
          const g = pixels[p + 1];
          const b = pixels[p + 2];
          const maxRb = Math.max(r, b);

          if (maxRb >= 90) {
            // White die-cut border pixel: restore to pure crisp white
            pixels[p] = 255;
            pixels[p + 1] = 255;
            pixels[p + 2] = 255;
          } else if (g > maxRb) {
            // Dark outline pixel: clamp green to eliminate spill
            pixels[p + 1] = maxRb;
          }
        }
      }
    }
  }

  // Slice Sheet into Grid and Fit LINE Specs
  function sliceAndFormatStickers(sheetCanvas, fullW, fullH) {
    const cols = state.cols;
    const rows = state.rows;
    const cellW = fullW / cols;
    const cellH = fullH / rows;
    const padding = state.padding;

    state.stickers = [];
    let count = 0;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        count++;
        const left = Math.floor(c * cellW);
        const top = Math.floor(r * cellH);
        const cellActualW = Math.ceil(cellW);
        const cellActualH = Math.ceil(cellH);

        // Extract cell image
        const cellCanvas = document.createElement('canvas');
        cellCanvas.width = cellActualW;
        cellCanvas.height = cellActualH;
        const cellCtx = cellCanvas.getContext('2d', { willReadFrequently: true });
        cellCtx.drawImage(
          sheetCanvas,
          left, top, cellActualW, cellActualH,
          0, 0, cellActualW, cellActualH
        );

        // Find bounding box
        const bbox = getVisibleBBox(cellCtx, cellActualW, cellActualH);
        let cropCanvas;

        if (bbox) {
          cropCanvas = document.createElement('canvas');
          cropCanvas.width = bbox.w;
          cropCanvas.height = bbox.h;
          const cropCtx = cropCanvas.getContext('2d');
          cropCtx.drawImage(
            cellCanvas,
            bbox.x, bbox.y, bbox.w, bbox.h,
            0, 0, bbox.w, bbox.h
          );
        } else {
          cropCanvas = cellCanvas;
        }

        // Fit into LINE Sticker format (Max 370 x 320, Even numbers, Safe padding)
        const lineCanvas = fitToLineStickerSpec(cropCanvas, 370, 320, padding);
        const filename = `${String(count).padStart(2, '0')}.png`;

        state.stickers.push({
          id: count,
          filename: filename,
          canvas: lineCanvas,
          dataUrl: lineCanvas.toDataURL('image/png'),
          width: lineCanvas.width,
          height: lineCanvas.height
        });
      }
    }

    DOM.stickerCountBadge.textContent = state.stickers.length;
    DOM.galleryStatsText.textContent = `共 ${state.stickers.length} 張貼圖已自動完成去背與格式化`;
  }

  // Get Bounding Box of non-transparent pixels
  function getVisibleBBox(ctx, w, h) {
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    let minX = w, minY = h, maxX = -1, maxY = -1;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const alpha = data[(y * w + x) * 4 + 3];
        if (alpha > 15) { // Threshold for visible pixel
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < minX || maxY < minY) return null;
    return {
      x: minX,
      y: minY,
      w: maxX - minX + 1,
      h: maxY - minY + 1
    };
  }

  // Fit into LINE Sticker canvas (Max 370x320, Even, Safe margin)
  function fitToLineStickerSpec(sourceCanvas, maxW, maxH, padding) {
    const srcW = sourceCanvas.width;
    const srcH = sourceCanvas.height;

    const availW = maxW - (padding * 2);
    const availH = maxH - (padding * 2);

    const scale = Math.min(availW / srcW, availH / srcH, 2.5); // Allow clean upscaling if small
    const targetContentW = Math.max(2, Math.round(srcW * scale));
    const targetContentH = Math.max(2, Math.round(srcH * scale));

    const finalCanvasW = makeEven(Math.min(maxW, targetContentW + padding * 2));
    const finalCanvasH = makeEven(Math.min(maxH, targetContentH + padding * 2));

    const destCanvas = document.createElement('canvas');
    destCanvas.width = finalCanvasW;
    destCanvas.height = finalCanvasH;
    const destCtx = destCanvas.getContext('2d');
    destCtx.imageSmoothingEnabled = true;
    destCtx.imageSmoothingQuality = 'high';

    const pasteX = Math.round((finalCanvasW - targetContentW) / 2);
    const pasteY = Math.round((finalCanvasH - targetContentH) / 2);

    destCtx.drawImage(sourceCanvas, pasteX, pasteY, targetContentW, targetContentH);
    return destCanvas;
  }

  // Update Right Gallery Grid
  function updateGalleryView() {
    DOM.stickersGrid.innerHTML = '';

    state.stickers.forEach((sticker, index) => {
      const isMain = index === state.mainIndex;
      const isTab = index === state.tabIndex;

      const card = document.createElement('div');
      let cardClass = 'sticker-card';
      if (isMain) cardClass += ' active-main';
      if (isTab) cardClass += ' active-tab';
      card.className = cardClass;

      let badgesHtml = '';
      if (isMain) badgesHtml += '<span class="badge-main">Main 封面</span>';
      if (isTab) badgesHtml += '<span class="badge-tab">Tab 標籤</span>';

      card.innerHTML = `
        <div class="sticker-badges-container">
          ${badgesHtml}
        </div>
        <div class="sticker-thumb-box bg-checker" title="點擊放大微調貼圖">
          <img src="${sticker.dataUrl}" alt="${sticker.filename}">
        </div>
        <div class="sticker-card-mid">
          <span class="sticker-card-pill">${sticker.filename}</span>
          <button class="btn-card-edit" title="微調橡皮擦">
            <i class="fa-solid fa-pencil"></i> 微調橡皮擦
          </button>
        </div>
        <div class="sticker-card-actions">
          <button class="btn-card-main ${isMain ? 'active' : ''}" title="設為 LINE 貼圖主圖 (main.png)">
            <i class="fa-solid fa-star"></i> Main
          </button>
          <button class="btn-card-tab ${isTab ? 'active' : ''}" title="設為 LINE 貼圖標籤圖示 (tab.png)">
            <i class="fa-solid fa-tag"></i> Tab
          </button>
        </div>
      `;

      // 1. Click thumbnail or edit button -> Open modal
      const thumbBox = card.querySelector('.sticker-thumb-box');
      const editBtn = card.querySelector('.btn-card-edit');
      thumbBox.addEventListener('click', () => openStickerModal(sticker));
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openStickerModal(sticker);
      });

      // 2. Click Main button
      const mainBtn = card.querySelector('.btn-card-main');
      mainBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.mainIndex = index;
        updateSpecialAssets();
        updateGalleryView();
      });

      // 3. Click Tab button
      const tabBtn = card.querySelector('.btn-card-tab');
      tabBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.tabIndex = index;
        updateSpecialAssets();
        updateGalleryView();
      });

      DOM.stickersGrid.appendChild(card);
    });

    DOM.stickerCountBadge.textContent = state.stickers.length;
    DOM.galleryStatsText.textContent = `共 ${state.stickers.length} 張貼圖 (Main: #${state.mainIndex + 1}, Tab: #${state.tabIndex + 1})`;
  }

  // Update Special Assets (main.png & tab.png)
  function updateSpecialAssets() {
    if (state.stickers.length === 0) return;

    // 1. main.png (240x240)
    const mainSticker = state.stickers[state.mainIndex] || state.stickers[0];
    const mainCanvas = document.createElement('canvas');
    mainCanvas.width = 240;
    mainCanvas.height = 240;
    const mainCtx = mainCanvas.getContext('2d');
    mainCtx.imageSmoothingQuality = 'high';

    const mainFit = fitToLineStickerSpec(mainSticker.canvas, 240, 240, 10);
    const mx = (240 - mainFit.width) / 2;
    const my = (240 - mainFit.height) / 2;
    mainCtx.drawImage(mainFit, mx, my);
    DOM.mainImgPreview.src = mainCanvas.toDataURL('image/png');
    state.mainCanvasData = mainCanvas;

    // 2. tab.png (96x74)
    const tabSticker = state.stickers[state.tabIndex] || state.stickers[0];
    const tabCanvas = document.createElement('canvas');
    tabCanvas.width = 96;
    tabCanvas.height = 74;
    const tabCtx = tabCanvas.getContext('2d');
    tabCtx.imageSmoothingQuality = 'high';

    const tabFit = fitToLineStickerSpec(tabSticker.canvas, 96, 74, 4);
    const tx = (96 - tabFit.width) / 2;
    const ty = (74 - tabFit.height) / 2;
    tabCtx.drawImage(tabFit, tx, ty);
    DOM.tabImgPreview.src = tabCanvas.toDataURL('image/png');
    state.tabCanvasData = tabCanvas;
  }

  // Update LINE Simulator
  function updateLineSimulator() {
    if (state.stickers.length === 0) return;

    // Set active sample sticker
    const sample = state.stickers[0];
    DOM.simStickerImg.src = sample.dataUrl;

    // Populate mini picker
    DOM.simKeyboardGrid.innerHTML = '';
    state.stickers.forEach((s) => {
      const item = document.createElement('div');
      item.className = 'keyboard-item';
      item.innerHTML = `<img src="${s.dataUrl}" alt="${s.filename}">`;
      item.addEventListener('click', () => {
        // Send sticker animation
        DOM.simStickerImg.style.animation = 'none';
        void DOM.simStickerImg.offsetWidth; // Trigger reflow
        DOM.simStickerImg.src = s.dataUrl;
        DOM.simStickerImg.style.animation = 'popIn 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
      });
      DOM.simKeyboardGrid.appendChild(item);
    });
  }

  // Render SVG Grid Cutlines
  function renderGridSvg(w, h) {
    const cols = state.cols;
    const rows = state.rows;
    const cellW = w / cols;
    const cellH = h / rows;

    let svgHtml = `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">`;

    // Vertical lines
    for (let c = 1; c < cols; c++) {
      const x = c * cellW;
      svgHtml += `<line x1="${x}" y1="0" x2="${x}" y2="${h}" class="grid-line" />`;
    }

    // Horizontal lines
    for (let r = 1; r < rows; r++) {
      const y = r * cellH;
      svgHtml += `<line x1="0" y1="${y}" x2="${w}" y2="${y}" class="grid-line" />`;
    }

    // Cell labels
    let count = 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cellW + 12;
        const y = r * cellH + 24;
        svgHtml += `<text x="${x}" y="${y}" class="grid-cell-label">#${count}</text>`;
        count++;
      }
    }

    svgHtml += '</svg>';
    DOM.gridSvg.innerHTML = svgHtml;
  }

  // View Mode Switching
  function updateViewMode() {
    const view = state.currentView;
    if (view === 'processed') {
      DOM.mainCanvas.classList.remove('hidden');
      DOM.splitOverlay.classList.add('hidden');
      DOM.gridSvg.classList.add('hidden');
    } else if (view === 'grid') {
      DOM.mainCanvas.classList.remove('hidden');
      DOM.splitOverlay.classList.add('hidden');
      DOM.gridSvg.classList.remove('hidden');
    } else if (view === 'split') {
      DOM.mainCanvas.classList.remove('hidden');
      DOM.splitOverlay.classList.remove('hidden');
      DOM.gridSvg.classList.add('hidden');
    }
  }

  // Background Class Toggle
  function applyBackgroundMode() {
    const bg = state.currentBg;
    DOM.canvasWrapper.className = `canvas-wrapper bg-${bg}`;
    DOM.modalPreviewBox.className = `modal-preview-box bg-${bg}`;
  }

  // Split view slider behavior
  function initSplitSlider() {
    let isDragging = false;

    const onMove = (clientX) => {
      if (!isDragging) return;
      const rect = DOM.canvasWrapper.getBoundingClientRect();
      let pos = (clientX - rect.left) / rect.width;
      pos = Math.max(0, Math.min(1, pos));
      
      DOM.splitDivider.style.left = `${pos * 100}%`;
      DOM.splitCanvas.style.clipPath = `polygon(0 0, ${pos * 100}% 0, ${pos * 100}% 100%, 0 100%)`;
    };

    DOM.splitDivider.addEventListener('mousedown', () => { isDragging = true; });
    window.addEventListener('mouseup', () => { isDragging = false; });
    window.addEventListener('mousemove', (e) => onMove(e.clientX));

    // Touch support
    DOM.splitDivider.addEventListener('touchstart', () => { isDragging = true; });
    window.addEventListener('touchend', () => { isDragging = false; });
    window.addEventListener('touchmove', (e) => {
      if (e.touches && e.touches[0]) onMove(e.touches[0].clientX);
    });
  }

  // Interactive Eraser & Modal Editor Management
  let editorCtx = null;
  let editorBackupCanvas = null;

  function openStickerModal(sticker) {
    state.activeModalSticker = sticker;
    const stickerIdx = sticker.id - 1;
    const isMain = state.mainIndex === stickerIdx;
    const isTab = state.tabIndex === stickerIdx;

    DOM.modalTitle.textContent = `貼圖微調編輯器 (${sticker.filename})`;
    DOM.modalFilename.textContent = sticker.filename;
    DOM.modalDimensions.textContent = `${sticker.width} × ${sticker.height} px (LINE 偶數規範)`;

    // Update modal badges
    DOM.modalBadges.innerHTML = `
      ${isMain ? '<span class="badge-main">Main 封面</span>' : ''}
      ${isTab ? '<span class="badge-tab">Tab 標籤</span>' : ''}
    `;

    // Update Main & Tab button states
    updateModalActionButtons();

    // Init Editor Canvas with sticker canvas
    initEditorCanvas(sticker);

    DOM.stickerModal.classList.remove('hidden');
  }

  function updateModalActionButtons() {
    if (!state.activeModalSticker) return;
    const stickerIdx = state.activeModalSticker.id - 1;
    const isMain = state.mainIndex === stickerIdx;
    const isTab = state.tabIndex === stickerIdx;

    DOM.modalSetMainBtn.className = `btn btn-card-main-lg ${isMain ? 'active' : ''}`;
    DOM.modalSetMainBtn.querySelector('span').textContent = isMain ? '★ 已設為 Main 封面' : '設為 Main 封面';

    DOM.modalSetTabBtn.className = `btn btn-card-tab-lg ${isTab ? 'active' : ''}`;
    DOM.modalSetTabBtn.querySelector('span').textContent = isTab ? '🏷️ 已設為 Tab 標籤' : '設為 Tab 標籤';

    // Update badges
    DOM.modalBadges.innerHTML = `
      ${isMain ? '<span class="badge-main">Main 封面</span>' : ''}
      ${isTab ? '<span class="badge-tab">Tab 標籤</span>' : ''}
    `;
  }

  function initEditorCanvas(sticker) {
    const canvas = DOM.editorCanvas;
    canvas.width = sticker.canvas.width;
    canvas.height = sticker.canvas.height;
    editorCtx = canvas.getContext('2d');
    editorCtx.clearRect(0, 0, canvas.width, canvas.height);
    editorCtx.drawImage(sticker.canvas, 0, 0);

    // Save backup for reset
    editorBackupCanvas = document.createElement('canvas');
    editorBackupCanvas.width = canvas.width;
    editorBackupCanvas.height = canvas.height;
    editorBackupCanvas.getContext('2d').drawImage(sticker.canvas, 0, 0);
  }

  function initEditorEvents() {
    let isDrawing = false;
    const canvas = DOM.editorCanvas;
    const cursor = DOM.brushCursor;
    const previewBox = DOM.modalPreviewBox;

    function getCanvasCoords(e) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
      };
    }

    function eraseAt(x, y) {
      if (!editorCtx) return;
      editorCtx.save();
      editorCtx.globalCompositeOperation = 'destination-out';
      editorCtx.beginPath();
      editorCtx.arc(x, y, state.brushSize / 2, 0, Math.PI * 2);
      editorCtx.fill();
      editorCtx.restore();
    }

    previewBox.addEventListener('mousemove', (e) => {
      cursor.style.display = 'block';
      const boxRect = previewBox.getBoundingClientRect();
      cursor.style.left = `${e.clientX - boxRect.left}px`;
      cursor.style.top = `${e.clientY - boxRect.top}px`;
      
      const canvasRect = canvas.getBoundingClientRect();
      const scale = canvasRect.width > 0 ? (canvasRect.width / canvas.width) : 1;
      const displaySize = Math.max(4, state.brushSize * scale);
      cursor.style.width = `${displaySize}px`;
      cursor.style.height = `${displaySize}px`;

      if (isDrawing) {
        const coords = getCanvasCoords(e);
        eraseAt(coords.x, coords.y);
      }
    });

    previewBox.addEventListener('mouseenter', () => { cursor.style.display = 'block'; });
    previewBox.addEventListener('mouseleave', () => { cursor.style.display = 'none'; isDrawing = false; });

    canvas.addEventListener('mousedown', (e) => {
      isDrawing = true;
      const coords = getCanvasCoords(e);
      eraseAt(coords.x, coords.y);
    });

    window.addEventListener('mouseup', () => { isDrawing = false; });

    DOM.brushSizeSlider.addEventListener('input', (e) => {
      state.brushSize = parseInt(e.target.value, 10);
      DOM.brushSizeVal.textContent = `${state.brushSize}px`;
    });

    DOM.editorResetBtn.addEventListener('click', () => {
      if (editorBackupCanvas && editorCtx) {
        editorCtx.clearRect(0, 0, canvas.width, canvas.height);
        editorCtx.drawImage(editorBackupCanvas, 0, 0);
      }
    });

    DOM.editorSaveBtn.addEventListener('click', () => {
      if (!state.activeModalSticker) return;
      const st = state.activeModalSticker;
      const newCanvas = document.createElement('canvas');
      newCanvas.width = canvas.width;
      newCanvas.height = canvas.height;
      newCanvas.getContext('2d').drawImage(canvas, 0, 0);
      st.canvas = newCanvas;
      st.dataUrl = newCanvas.toDataURL('image/png');

      updateSpecialAssets();
      updateGalleryView();
      updateLineSimulator();
      closeModal();
    });

    DOM.modalSetMainBtn.addEventListener('click', () => {
      if (state.activeModalSticker) {
        state.mainIndex = state.activeModalSticker.id - 1;
        updateSpecialAssets();
        updateGalleryView();
        updateModalActionButtons();
      }
    });

    DOM.modalSetTabBtn.addEventListener('click', () => {
      if (state.activeModalSticker) {
        state.tabIndex = state.activeModalSticker.id - 1;
        updateSpecialAssets();
        updateGalleryView();
        updateModalActionButtons();
      }
    });

    DOM.modalDownloadBtn.addEventListener('click', () => {
      if (state.activeModalSticker) {
        const downloadCanvas = DOM.editorCanvas || state.activeModalSticker.canvas;
        downloadCanvas.toBlob((blob) => {
          downloadBlob(blob, state.activeModalSticker.filename);
        }, 'image/png');
      }
    });
  }

  function closeModal() {
    DOM.stickerModal.classList.add('hidden');
    state.activeModalSticker = null;
  }

  // Download Blob Helper
  function downloadBlob(blob, filename) {
    if (window.saveAs) {
      window.saveAs(blob, filename);
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  function downloadSpecialAsset(type) {
    const canvas = type === 'main' ? state.mainCanvasData : state.tabCanvasData;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      downloadBlob(blob, `${type}.png`);
    }, 'image/png');
  }

  // Export All ZIP
  async function exportZipPackage() {
    if (state.stickers.length === 0) return;
    if (typeof JSZip === 'undefined') {
      alert('正在載入 ZIP 打包程式庫，請稍候...');
      return;
    }

    const zip = new JSZip();
    const folder = zip.folder('line_stickers');

    showProcessing(true);

    // 1. Add all individual stickers (01.png ~ 20.png)
    for (const sticker of state.stickers) {
      const blob = await new Promise(res => sticker.canvas.toBlob(res, 'image/png'));
      folder.file(sticker.filename, blob);
    }

    // 2. Add main.png (240x240)
    if (state.mainCanvasData) {
      const mainBlob = await new Promise(res => state.mainCanvasData.toBlob(res, 'image/png'));
      folder.file('main.png', mainBlob);
    }

    // 3. Add tab.png (96x74)
    if (state.tabCanvasData) {
      const tabBlob = await new Promise(res => state.tabCanvasData.toBlob(res, 'image/png'));
      folder.file('tab.png', tabBlob);
    }

    // 4. Generate and download zip
    const content = await zip.generateAsync({ type: 'blob' });
    downloadBlob(content, 'line_stickers_20_pack.zip');

    showProcessing(false);
  }

  // Auto-init on page load
  document.addEventListener('DOMContentLoaded', () => {
    initEvents();
    // Auto load sample
    loadSampleImage();
  });

})();
