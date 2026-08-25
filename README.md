# Sticker Studio PRO 🦎
### LINE 貼圖綠幕智慧去背 & 5×4 自動切割工作站

一個專為 **LINE 貼圖創作者** 設計的極速靜態網頁工具與 Python 後端腳本。支援 Midjourney / DALL-E 生成的 5×4（20格）綠幕貼圖一鍵智慧去背、外框綠線消除、主圖（`main.png`）與標籤（`tab.png`）任意選定、微調橡皮擦，以及一鍵打包匯出符合 LINE 官方規範的 ZIP 包！

---

## ✨ 核心特色

1. **智慧邊界擴散去背 (Edge-Connected Flood Fill)**
   - 從四周由外向內去除綠幕背景，**100% 保留貼圖內部的綠色文字、鈔票、發財樹、K 線圖與晶片元件**。
2. **模切白邊純化去雜色 (White Border Decontamination)**
   - 自動吞噬交界處的 JPEG 壓縮雜光，將外圍模切白邊純化為純白（#FFFFFF），徹底消除貼圖外圈的綠色邊線。
3. **靈活設定 Main 封面與 Tab 標籤**
   - 20 張貼圖中的**任何一張**皆可一鍵設為 `main.png`（240×240）或 `tab.png`（96×74）。
4. **內建微調橡皮擦 (Interactive Eraser)**
   - 支援畫布塗抹微調、調整筆刷大小（2~40px）、一鍵重設與單張下載。
5. **完整符合 LINE 官方貼圖規範**
   - 自動將長寬調整為**強制偶數像素 (Even Dimensions)**。
   - 保留 10px 安全留白。
   - 一鍵打包 ZIP：包含 `01.png` ~ `20.png`、`main.png`、`tab.png`。
6. **支援 GitHub Pages 免費靜態託管**
   - 純前端（HTML5 Canvas + Vanilla CSS + JS），無需任何後端伺服器，直接開瀏覽器即可使用！

---

## 🚀 專案結構

```
line-sticker-studio/
├── index.html            # 現代化前端工作站介面
├── style.css             # 完整設計系統與響應式 CSS
├── app.js                # Canvas 智慧去背、切圖、微調橡皮擦與 ZIP 匯出邏輯
├── process_stickers.py   # Python 批次處理與命令列工具
├── sample_stickers.jpg   # 內建台股壁虎範例貼圖 (20格)
└── README.md             # 說明文件
```

---

## 💻 兩種使用方式

### 方式 A：直接在瀏覽器使用（或部署至 GitHub Pages）
1. 雙擊開啟 `index.html` 或將專案上傳至 GitHub 並啟用 **GitHub Pages**。
2. 點擊「**載入台股貼圖範例 (20張)**」或拖曳上傳您自己的 5×4 綠幕貼圖。
3. 在右側貼圖清單挑選喜歡的貼圖設為 `Main` / `Tab`。
4. 點擊右上角「**一鍵打包 LINE 貼圖包 (ZIP)**」即可完成！

### 方式 B：使用 Python 命令列腳本
```bash
# 安裝所需套件
pip install pillow numpy

# 預設執行 (輸入 sample_stickers.jpg，輸出至 output_stickers 目錄)
python process_stickers.py sample_stickers.jpg output_stickers

# 自訂指定第 20 張為 Main 封面，第 1 張為 Tab 標籤
python process_stickers.py sample_stickers.jpg output_stickers --main 20 --tab 1
```

---

## 📄 LINE 官方貼圖規範適配說明

| 檔案名稱 | 官方規格限制 | 本工具自動適配 |
| :--- | :--- | :--- |
| **貼圖圖片 (`01.png` ~ `20.png`)** | 最大 W 370 × H 320 px，偶數寬高，保留 10px 留白 | ✅ 自動等比縮放、強制偶數尺寸、安全留白 |
| **主圖 (`main.png`)** | W 240 × H 240 px | ✅ 自動裁切並置中補齊至 240×240 px |
| **標籤 (`tab.png`)** | W 96 × H 74 px | ✅ 自動裁切並置中補齊至 96×74 px |
| **檔案格式** | 32-bit 透明背景 PNG | ✅ 完整支援 Alpha 透明去背 |

---

## 📜 License
MIT License
