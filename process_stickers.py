import os
import sys
import zipfile
import math
import numpy as np
from PIL import Image

def remove_green_background(img, mode='outer', tol=80):
    """
    CODEX-grade Chroma Key & Decontamination Engine:
    1. 3D Euclidean distance in RGB: Math.hypot(r, 255-g, b) < tol and g - max(r, b) > 28 and g > 110
    2. Dual mode:
       - 'outer': 4-edge BFS flood-fill only, 100% preserves interior green charts, radar, money, green text
       - 'all': cleans all matching green including interior closed voids
    3. 2-pixel sub-pixel boundary decontamination & despill:
       - Reconstructs alpha fade and clamps green spill to max(r,b) without harsh pixelation.
    """
    img = img.convert('RGBA')
    w, h = img.size
    arr = np.array(img, dtype=np.uint8)
    
    r = arr[:, :, 0].astype(np.float32)
    g = arr[:, :, 1].astype(np.float32)
    b = arr[:, :, 2].astype(np.float32)
    
    max_rb = np.maximum(r, b)
    green_diff = g - max_rb
    
    # Euclidean color distance from pure green (0, 255, 0)
    color_dist = np.sqrt(r * r + (255.0 - g) * (255.0 - g) + b * b)
    is_chroma = (g > 110) & (green_diff > 28) & (color_dist < tol)
    
    bg_mask = np.zeros((h, w), dtype=bool)
    
    if mode == 'all':
        bg_mask = is_chroma.copy()
    else:
        # Outer mode: BFS Flood Fill from 4 borders only
        from collections import deque
        q = deque()
        
        for y in range(h):
            if is_chroma[y, 0] and not bg_mask[y, 0]:
                bg_mask[y, 0] = True
                q.append((y, 0))
            if is_chroma[y, w - 1] and not bg_mask[y, w - 1]:
                bg_mask[y, w - 1] = True
                q.append((y, w - 1))
        for x in range(w):
            if is_chroma[0, x] and not bg_mask[0, x]:
                bg_mask[0, x] = True
                q.append((0, x))
            if is_chroma[h - 1, x] and not bg_mask[h - 1, x]:
                bg_mask[h - 1, x] = True
                q.append((h - 1, x))
                
        dy = [-1, 1, 0, 0]
        dx = [0, 0, -1, 1]
        
        while q:
            cy, cx = q.popleft()
            for i in range(4):
                ny, nx = cy + dy[i], cx + dx[i]
                if 0 <= ny < h and 0 <= nx < w:
                    if not bg_mask[ny, nx] and is_chroma[ny, nx]:
                        bg_mask[ny, nx] = True
                        q.append((ny, nx))
    
    # Decontaminate 2-pixel boundary next to deleted background
    dilated_bg = bg_mask.copy()
    for dy_offset in [-1, 0, 1]:
        for dx_offset in [-1, 0, 1]:
            if dy_offset == 0 and dx_offset == 0:
                continue
            dilated_bg = dilated_bg | np.roll(np.roll(bg_mask, dy_offset, axis=0), dx_offset, axis=1)
    
    # 2px dilation
    dilated_bg_2 = dilated_bg.copy()
    for dy_offset in [-1, 0, 1]:
        for dx_offset in [-1, 0, 1]:
            if dy_offset == 0 and dx_offset == 0:
                continue
            dilated_bg_2 = dilated_bg_2 | np.roll(np.roll(dilated_bg, dy_offset, axis=0), dx_offset, axis=1)
            
    near_bg = dilated_bg_2 & (~bg_mask)
    
    result_arr = arr.copy()
    
    # Apply transparency to deleted background
    result_arr[:, :, 3][bg_mask] = 0
    
    # Despill: clean 2px boundary where green dominates
    spill_pixels = near_bg & (result_arr[:, :, 1] > np.maximum(result_arr[:, :, 0], result_arr[:, :, 2]) + 8)
    if np.any(spill_pixels):
        r_spill = result_arr[:, :, 0][spill_pixels].astype(np.float32)
        g_spill = result_arr[:, :, 1][spill_pixels].astype(np.float32)
        b_spill = result_arr[:, :, 2][spill_pixels].astype(np.float32)
        max_rb_spill = np.maximum(r_spill, b_spill)
        
        a = 1.0 - (g_spill - max_rb_spill) / 255.0
        a = np.clip(a, 0.0, 1.0)
        
        # Transparent cut-off
        is_transparent = a < 0.08
        
        new_r = np.clip(r_spill / np.maximum(0.001, a), 0, 255).astype(np.uint8)
        new_b = np.clip(b_spill / np.maximum(0.001, a), 0, 255).astype(np.uint8)
        new_g = max_rb_spill.astype(np.uint8)
        new_a = np.round(result_arr[:, :, 3][spill_pixels].astype(np.float32) * a).astype(np.uint8)
        
        new_a[is_transparent] = 0
        
        result_arr[:, :, 0][spill_pixels] = new_r
        result_arr[:, :, 1][spill_pixels] = new_g
        result_arr[:, :, 2][spill_pixels] = new_b
        result_arr[:, :, 3][spill_pixels] = new_a
        
    return Image.fromarray(result_arr, 'RGBA')

def find_lines(alpha_arr, cols=5, rows=4):
    """
    CODEX-grade Projection Valley Seam Search:
    Projects non-transparent pixel alpha across columns and rows,
    then locates the lowest-density gutter (valley) within +/-20% of theoretical grid intervals.
    """
    h, w = alpha_arr.shape
    
    def axis_seams(n, other, count, vertical=True):
        sums = np.sum(alpha_arr > 16, axis=0 if vertical else 1).astype(np.float64)
        seams = [0]
        
        for j in range(1, count):
            target = n * j / count
            search_range = n / count * 0.2
            min_k = max(1, int(math.floor(target - search_range)))
            max_k = min(n - 1, int(math.ceil(target + search_range)))
            
            best_k = int(round(target))
            best_score = float('inf')
            
            for k in range(min_k, max_k):
                # 3-tap smoothed density + distance penalty
                k_prev = sums[k - 1] if k > 0 else sums[k]
                k_next = sums[k + 1] if k < n - 1 else sums[k]
                s = (k_prev + sums[k] + k_next) / 3.0 + abs(k - target) / n * other * 0.03
                if s < best_score:
                    best_score = s
                    best_k = k
            seams.append(best_k)
            
        seams.append(n)
        return seams

    xs = axis_seams(w, h, cols, vertical=True)
    ys = axis_seams(h, w, rows, vertical=False)
    return xs, ys

def geom_fit(content_w, content_h, target_w=370, target_h=320, padding=10, scale_factor=1.0):
    """
    CODEX-grade Safe Frame Geometry Constraint (geom):
    Scales sticker proportionally to fit max safe bounds (W - 2*P, H - 2*P).
    Guarantees no sticker ever overflows the safety margin.
    """
    avail_w = max(2, target_w - 2 * padding)
    avail_h = max(2, target_h - 2 * padding)
    
    base_scale = min(avail_w / content_w, avail_h / content_h)
    s = base_scale * scale_factor
    
    fit_w = max(2, int(round(content_w * s)))
    fit_h = max(2, int(round(content_h * s)))
    
    # Ensure even dimensions
    if fit_w % 2 != 0: fit_w -= 1
    if fit_h % 2 != 0: fit_h -= 1
    fit_w = max(2, fit_w)
    fit_h = max(2, fit_h)
    
    return s, fit_w, fit_h

def render_line_sticker(tile_img, target_w=370, target_h=320, padding=10):
    bbox = tile_img.getbbox()
    if bbox:
        cropped = tile_img.crop(bbox)
    else:
        cropped = tile_img
        
    cw, ch = cropped.size
    s, fit_w, fit_h = geom_fit(cw, ch, target_w, target_h, padding)
    
    resized = cropped.resize((fit_w, fit_h), Image.Resampling.LANCZOS)
    
    canvas = Image.new('RGBA', (target_w, target_h), (0, 0, 0, 0))
    paste_x = (target_w - fit_w) // 2
    paste_y = (target_h - fit_h) // 2
    canvas.paste(resized, (paste_x, paste_y), resized)
    return canvas

def generate_html_gallery(output_dir, sticker_names):
    gallery_html = """<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <title>貼圖工坊 · 去背分割結果</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
        h1 { font-size: 1.4rem; text-align: center; margin-bottom: 6px; color: #38bdf8; }
        p.subtitle { text-align: center; color: #94a3b8; font-size: 0.85rem; margin-bottom: 20px; }
        .controls { display: flex; justify-content: center; gap: 10px; margin-bottom: 20px; }
        .btn { padding: 6px 14px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.2); background: #1e293b; color: white; cursor: pointer; font-size: 0.8rem; }
        .btn:hover { background: #334155; }
        .btn.active { background: #6366f1; border-color: #818cf8; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 14px; max-width: 1200px; margin: 0 auto; }
        .card { background: #1e293b; border-radius: 10px; padding: 10px; text-align: center; border: 1px solid rgba(255,255,255,0.1); }
        .img-wrap { width: 100%; height: 160px; border-radius: 6px; display: flex; align-items: center; justify-content: center; overflow: hidden; margin-bottom: 6px; }
        .img-wrap img { max-width: 90%; max-height: 90%; object-fit: contain; }
        .filename { font-weight: bold; font-size: 0.85rem; color: #e2e8f0; }
        .size { font-size: 0.75rem; color: #64748b; margin-top: 2px; }
        .bg-checker { background-color: #ffffff; background-image: linear-gradient(45deg, #c9ced1 25%, transparent 25%), linear-gradient(-45deg, #c9ced1 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #c9ced1 75%), linear-gradient(-45deg, transparent 75%, #c9ced1 75%); background-size: 16px 16px; background-position: 0 0, 0 8px, 8px -8px, -8px 0px; }
        .bg-dark { background: #080c14; }
        .bg-white { background: #ffffff; }
        .bg-line { background: #849ebf; }
    </style>
</head>
<body>
    <h1>貼圖工坊 · 20格分割去背結果 (CODEX 演算法)</h1>
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

def process_sticker_sheet(input_path, output_dir, cols=5, rows=4, mode='outer', tol=80, main_idx=1, tab_idx=1):
    os.makedirs(output_dir, exist_ok=True)
    
    print(f"Loading image from: {input_path}")
    orig_img = Image.open(input_path)
    w, h = orig_img.size
    print(f"Image dimensions: {w}x{h}, Grid: {cols} cols x {rows} rows")
    
    # 1. First remove background from full sheet using CODEX Chroma Key
    print(f"Applying CODEX Euclidean Chroma Key ({mode} mode, tol={tol}, 2px sub-pixel despill)...")
    transparent_sheet = remove_green_background(orig_img, mode=mode, tol=tol)
    transparent_sheet.save(os.path.join(output_dir, "transparent_full_sheet.png"))
    
    # 2. Find grid lines via projection valley search
    print("Finding grid seams via alpha projection valley search (find_lines)...")
    alpha_arr = np.array(transparent_sheet)[:, :, 3]
    xs, ys = find_lines(alpha_arr, cols=cols, rows=rows)
    print(f"  Detected X seams: {xs}")
    print(f"  Detected Y seams: {ys}")
    
    stickers_info = []
    saved_files = []
    sticker_tiles = {}
    
    print("Splitting into individual stickers and formatting to LINE specs (370x320, even, 10px safe margin)...")
    count = 0
    for r in range(rows):
        for c in range(cols):
            count += 1
            left = xs[c]
            top = ys[r]
            right = xs[c + 1]
            bottom = ys[r + 1]
            
            cell_crop = transparent_sheet.crop((left, top, right, bottom))
            sticker_tiles[count] = cell_crop
            
            line_sticker = render_line_sticker(cell_crop, target_w=370, target_h=320, padding=10)
            filename = f"{count:02d}.png"
            filepath = os.path.join(output_dir, filename)
            line_sticker.save(filepath, "PNG")
            
            stickers_info.append((filename, line_sticker.size))
            saved_files.append(filepath)
            print(f"  [OK] Saved {filename} (Size: {line_sticker.size[0]}x{line_sticker.size[1]} px)")
            
    # 3. Create main.png (240x240)
    main_tile = sticker_tiles.get(main_idx, sticker_tiles[1])
    main_img = render_line_sticker(main_tile, target_w=240, target_h=240, padding=10)
    main_path = os.path.join(output_dir, "main.png")
    main_img.save(main_path, "PNG")
    stickers_info.append(("main.png", (240, 240)))
    saved_files.append(main_path)
    print(f"  [OK] Saved main.png (240x240 px, from Sticker #{main_idx})")
    
    # 4. Create tab.png (96x74)
    tab_tile = sticker_tiles.get(tab_idx, sticker_tiles[1])
    tab_img = render_line_sticker(tab_tile, target_w=96, target_h=74, padding=4)
    tab_path = os.path.join(output_dir, "tab.png")
    tab_img.save(tab_path, "PNG")
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
    parser = argparse.ArgumentParser(description="LINE Sticker Sheet Splitter & Background Remover (CODEX Algorithm)")
    parser.add_argument("input", nargs="?", default="sample_stickers.jpg", help="Input image path")
    parser.add_argument("output", nargs="?", default="output_stickers", help="Output directory")
    parser.add_argument("--cols", type=int, default=5, help="Number of columns (default 5)")
    parser.add_argument("--rows", type=int, default=4, help="Number of rows (default 4)")
    parser.add_argument("--mode", type=str, default="outer", choices=["outer", "all"], help="Chroma key mode: outer or all")
    parser.add_argument("--tol", type=int, default=80, help="Chroma tolerance (20-160, default 80)")
    parser.add_argument("--main", type=int, default=1, help="Index of sticker for main.png (1-20, default 1)")
    parser.add_argument("--tab", type=int, default=1, help="Index of sticker for tab.png (1-20, default 1)")
    args = parser.parse_args()
    
    process_sticker_sheet(args.input, args.output, cols=args.cols, rows=args.rows, mode=args.mode, tol=args.tol, main_idx=args.main, tab_idx=args.tab)
