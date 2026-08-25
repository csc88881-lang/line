import os
import sys
import zipfile
import numpy as np
from PIL import Image, ImageFilter

def remove_green_background(img, threshold=55, despill=True):
    """
    Intelligent Chroma Key Removal with Complete Edge Green Line Elimination:
    - Boundary-seeded Flood Fill & strict pocket clearing
    - Outer fringe choke to swallow anti-aliased green compression artifacts
    - White border edge decontamination: restores pure clean white die-cut edges
    - Preserves 100% of all green illustrations, text, and artwork inside stickers
    """
    img = img.convert('RGBA')
    w, h = img.size
    arr = np.array(img, dtype=np.uint8)
    
    r = arr[:, :, 0].astype(np.float32)
    g = arr[:, :, 1].astype(np.float32)
    b = arr[:, :, 2].astype(np.float32)
    
    max_rb = np.maximum(r, b)
    dom = g - max_rb
    
    # 1. Background classification for Flood Fill
    is_bg_candidate = (g > 160) & (dom > 50)
    
    bg_mask = np.zeros((h, w), dtype=bool)
    from collections import deque
    q = deque()
    
    # Add 4 borders
    for y in range(h):
        if is_bg_candidate[y, 0]: bg_mask[y, 0] = True; q.append((y, 0))
        if is_bg_candidate[y, w-1]: bg_mask[y, w-1] = True; q.append((y, w-1))
    for x in range(w):
        if is_bg_candidate[0, x] and not bg_mask[0, x]: bg_mask[0, x] = True; q.append((0, x))
        if is_bg_candidate[h-1, x] and not bg_mask[h-1, x]: bg_mask[h-1, x] = True; q.append((h-1, x))
        
    dy = [-1, 1, 0, 0, -1, -1, 1, 1]
    dx = [0, 0, -1, 1, -1, 1, -1, 1]
    
    while q:
        cy, cx = q.popleft()
        for i in range(8):
            ny, nx = cy + dy[i], cx + dx[i]
            if 0 <= ny < h and 0 <= nx < w:
                if not bg_mask[ny, nx] and is_bg_candidate[ny, nx]:
                    bg_mask[ny, nx] = True
                    q.append((ny, nx))
                    
    # Strict interior background pockets
    strict_seed = (g > 200) & (dom > 120) & (r < 40) & (b < 40)
    sy, sx = np.where(strict_seed & (~bg_mask))
    for y, x in zip(sy, sx):
        bg_mask[y, x] = True
        q.append((y, x))
        
    while q:
        cy, cx = q.popleft()
        for i in range(8):
            ny, nx = cy + dy[i], cx + dx[i]
            if 0 <= ny < h and 0 <= nx < w:
                if not bg_mask[ny, nx] and is_bg_candidate[ny, nx]:
                    bg_mask[ny, nx] = True
                    q.append((ny, nx))
                    
    # 2. Outer fringe choke: clean the 1px green transition halo touching the background
    dilated_bg_1 = bg_mask.copy()
    for i in range(8):
        dilated_bg_1 = dilated_bg_1 | np.roll(np.roll(bg_mask, dy[i], axis=0), dx[i], axis=1)
    
    fringe_to_erase = dilated_bg_1 & (~bg_mask) & (dom > 20)
    bg_mask = bg_mask | fringe_to_erase
    
    # 3. Alpha calculation
    alpha = np.where(bg_mask, 0, 255).astype(np.uint8)
    
    # 4. White Border Decontamination & Edge Despill:
    # 3px outer transition edge zone touching transparent background
    dilated_bg_3 = bg_mask.copy()
    for _ in range(3):
        temp = dilated_bg_3.copy()
        for i in range(8):
            temp = temp | np.roll(np.roll(dilated_bg_3, dy[i], axis=0), dx[i], axis=1)
        dilated_bg_3 = temp
    edge_zone = dilated_bg_3 & (~bg_mask)
    
    result_arr = arr.copy()
    
    # Decontaminate white border: any edge pixel with max_rb >= 90 becomes pure crisp white (255,255,255)
    white_edge = edge_zone & (np.maximum(result_arr[:, :, 0], result_arr[:, :, 2]) >= 90)
    result_arr[:, :, 0][white_edge] = 255
    result_arr[:, :, 1][white_edge] = 255
    result_arr[:, :, 2][white_edge] = 255
    
    # For darker outline pixels on the outer edge: clamp green to max_rb
    dark_edge_spill = edge_zone & (~white_edge) & (result_arr[:, :, 1] > np.maximum(result_arr[:, :, 0], result_arr[:, :, 2]))
    result_arr[:, :, 1][dark_edge_spill] = np.maximum(result_arr[:, :, 0], result_arr[:, :, 2])[dark_edge_spill]
    
    result_arr[:, :, 3] = alpha
    return Image.fromarray(result_arr, 'RGBA')

def make_even(n):
    """Ensure integer is even for LINE sticker compliance"""
    n = int(round(n))
    if n % 2 != 0:
        n -= 1
    return max(2, n)

def fit_line_sticker(sticker_img, max_w=370, max_h=320, padding=10, upscale=True):
    """
    Trims transparent borders, resizes proportionally within max_w x max_h (even dimensions),
    and centers on transparent canvas.
    """
    bbox = sticker_img.getbbox()
    if bbox:
        cropped = sticker_img.crop(bbox)
    else:
        cropped = sticker_img
        
    w, h = cropped.size
    avail_w = max_w - (padding * 2)
    avail_h = max_h - (padding * 2)
    
    # Calculate scale factor
    scale = min(avail_w / w, avail_h / h)
    if not upscale and scale > 1.0:
        scale = 1.0
        
    new_w = max(2, int(round(w * scale)))
    new_h = max(2, int(round(h * scale)))
    
    resized = cropped.resize((new_w, new_h), Image.Resampling.LANCZOS)
    
    target_canvas_w = make_even(min(max_w, new_w + padding * 2))
    target_canvas_h = make_even(min(max_h, new_h + padding * 2))
    
    canvas = Image.new('RGBA', (target_canvas_w, target_canvas_h), (0, 0, 0, 0))
    paste_x = (target_canvas_w - new_w) // 2
    paste_y = (target_canvas_h - new_h) // 2
    canvas.paste(resized, (paste_x, paste_y), resized)
    
    return canvas

def generate_html_gallery(output_dir, sticker_names):
    """Generates an instant visual gallery for user inspection"""
    gallery_html = """<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <title>LINE 貼圖去背分割結果 (20款壁虎台股貼圖)</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
        h1 { font-size: 1.5rem; text-align: center; margin-bottom: 8px; color: #38bdf8; }
        p.subtitle { text-align: center; color: #94a3b8; font-size: 0.9rem; margin-bottom: 24px; }
        .controls { display: flex; justify-content: center; gap: 12px; margin-bottom: 20px; }
        .btn { padding: 8px 16px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.2); background: #1e293b; color: white; cursor: pointer; font-size: 0.85rem; }
        .btn:hover { background: #334155; }
        .btn.active { background: #6366f1; border-color: #818cf8; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; max-width: 1200px; margin: 0 auto; }
        .card { background: #1e293b; border-radius: 12px; padding: 12px; text-align: center; border: 1px solid rgba(255,255,255,0.1); transition: transform 0.2s; }
        .card:hover { transform: translateY(-3px); border-color: #38bdf8; }
        .img-wrap { width: 100%; height: 180px; border-radius: 8px; display: flex; align-items: center; justify-content: center; overflow: hidden; margin-bottom: 8px; }
        .img-wrap img { max-width: 90%; max-height: 90%; object-fit: contain; filter: drop-shadow(0 4px 6px rgba(0,0,0,0.3)); }
        .filename { font-weight: bold; font-size: 0.9rem; color: #e2e8f0; }
        .size { font-size: 0.75rem; color: #64748b; margin-top: 2px; }
        
        .bg-checker {
            background-color: #1e2230;
            background-image: linear-gradient(45deg, #151822 25%, transparent 25%), linear-gradient(-45deg, #151822 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #151822 75%), linear-gradient(-45deg, transparent 75%, #151822 75%);
            background-size: 16px 16px;
            background-position: 0 0, 0 8px, 8px -8px, -8px 0px;
        }
        .bg-dark { background: #000000; }
        .bg-white { background: #ffffff; }
        .bg-line { background: #7494c0; }
    </style>
</head>
<body>
    <h1>🦎 LINE 貼圖 20 款台股壁虎 - 去背分割成果</h1>
    <p class="subtitle">已完全符合 LINE 官方規範：32-bit 透明 PNG、偶數尺寸、安全留白 10px、附帶 main.png (240x240) 與 tab.png (96x74)</p>
    
    <div class="controls">
        <button class="btn active" onclick="setBg('checker')">🏁 透明棋盤格</button>
        <button class="btn" onclick="setBg('dark')">⬛ 黑色背景</button>
        <button class="btn" onclick="setBg('white')">⬜ 白色背景</button>
        <button class="btn" onclick="setBg('line')">💬 LINE 聊天底色</button>
    </div>

    <div class="grid">
"""
    for name, sz in sticker_names:
        gallery_html += f"""
        <div class="card">
            <div class="img-wrap bg-checker">
                <img src="{name}" alt="{name}">
            </div>
            <div class="filename">{name}</div>
            <div class="size">{sz[0]} × {sz[1]} px</div>
        </div>"""
        
    gallery_html += """
    </div>
    <script>
        function setBg(type) {
            document.querySelectorAll('.img-wrap').forEach(el => {
                el.className = 'img-wrap bg-' + type;
            });
            document.querySelectorAll('.btn').forEach(b => b.classList.remove('active'));
            event.target.classList.add('active');
        }
    </script>
</body>
</html>
"""
    with open(os.path.join(output_dir, "preview_gallery.html"), "w", encoding="utf-8") as f:
        f.write(gallery_html)

def process_sticker_sheet(input_path, output_dir, cols=5, rows=4, main_idx=1, tab_idx=1):
    os.makedirs(output_dir, exist_ok=True)
    
    print(f"Loading image from: {input_path}")
    orig_img = Image.open(input_path)
    w, h = orig_img.size
    print(f"Image dimensions: {w}x{h}, Grid: {cols} columns x {rows} rows")
    
    # 1. First remove background from full sheet
    print("Performing high-precision Smart Background Removal (Edge-Connected Flood Fill)...")
    transparent_sheet = remove_green_background(orig_img, threshold=55, despill=True)
    transparent_sheet.save(os.path.join(output_dir, "transparent_full_sheet.png"))
    
    # 2. Slice into grid
    cell_w = w / cols
    cell_h = h / rows
    
    stickers_info = []
    saved_files = []
    sticker_crops = {}
    
    print("Splitting into individual stickers and formatting to LINE specs (Max 370x320)...")
    for r in range(rows):
        for c in range(cols):
            index = r * cols + c + 1
            left = int(c * cell_w)
            top = int(r * cell_h)
            right = int((c + 1) * cell_w) if c < cols - 1 else w
            bottom = int((r + 1) * cell_h) if r < rows - 1 else h
            
            cell_crop = transparent_sheet.crop((left, top, right, bottom))
            sticker_crops[index] = cell_crop
            line_sticker = fit_line_sticker(cell_crop, max_w=370, max_h=320, padding=10, upscale=True)
            
            filename = f"{index:02d}.png"
            filepath = os.path.join(output_dir, filename)
            line_sticker.save(filepath, "PNG")
            stickers_info.append((filename, line_sticker.size))
            saved_files.append(filepath)
            print(f"  [OK] Saved {filename} (Size: {line_sticker.size[0]}x{line_sticker.size[1]} px)")
            
    # 3. Create main.png (240x240) using selected main_idx (default 1)
    main_crop = sticker_crops.get(main_idx, sticker_crops[1])
    main_img = fit_line_sticker(main_crop, max_w=240, max_h=240, padding=10, upscale=True)
    main_canvas = Image.new('RGBA', (240, 240), (0, 0, 0, 0))
    mx = (240 - main_img.size[0]) // 2
    my = (240 - main_img.size[1]) // 2
    main_canvas.paste(main_img, (mx, my), main_img)
    main_path = os.path.join(output_dir, "main.png")
    main_canvas.save(main_path, "PNG")
    stickers_info.append(("main.png", (240, 240)))
    saved_files.append(main_path)
    print(f"  [OK] Saved main.png (240x240 px, from Sticker #{main_idx})")
    
    # 4. Create tab.png (96x74) using selected tab_idx (default 1)
    tab_crop = sticker_crops.get(tab_idx, sticker_crops[1])
    tab_img = fit_line_sticker(tab_crop, max_w=96, max_h=74, padding=4, upscale=True)
    tab_canvas = Image.new('RGBA', (96, 74), (0, 0, 0, 0))
    tx = (96 - tab_img.size[0]) // 2
    ty = (74 - tab_img.size[1]) // 2
    tab_canvas.paste(tab_img, (tx, ty), tab_img)
    tab_path = os.path.join(output_dir, "tab.png")
    tab_canvas.save(tab_path, "PNG")
    stickers_info.append(("tab.png", (96, 74)))
    saved_files.append(tab_path)
    print(f"  [OK] Saved tab.png (96x74 px, from Sticker #{tab_idx})")
    
    # 5. Create ZIP package
    zip_path = os.path.join(output_dir, "line_stickers_20_pack.zip")
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for f in saved_files:
            zipf.write(f, os.path.basename(f))
    print(f"  [OK] Packed ZIP: {zip_path}")
    
    # 6. Generate HTML Gallery
    generate_html_gallery(output_dir, stickers_info)
    print(f"  [OK] Generated Visual Preview Gallery: {os.path.join(output_dir, 'preview_gallery.html')}")
    
    print(f"\nAll done! Output available in: {os.path.abspath(output_dir)}")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="LINE Sticker Sheet Splitter & Background Remover")
    parser.add_argument("input", nargs="?", default="sample_stickers.jpg", help="Input image path")
    parser.add_argument("output", nargs="?", default="output_stickers", help="Output directory")
    parser.add_argument("--cols", type=int, default=5, help="Number of columns (default 5)")
    parser.add_argument("--rows", type=int, default=4, help="Number of rows (default 4)")
    parser.add_argument("--main", type=int, default=1, help="Index of sticker for main.png (1-20, default 1)")
    parser.add_argument("--tab", type=int, default=1, help="Index of sticker for tab.png (1-20, default 1)")
    args = parser.parse_args()
    
    process_sticker_sheet(args.input, args.output, cols=args.cols, rows=args.rows, main_idx=args.main, tab_idx=args.tab)
