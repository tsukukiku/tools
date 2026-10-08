import cv2
import numpy as np
import os
import zipfile
import tempfile
import gradio as gr

# ================= 核心算法逻辑 =================

def order_points(pts):
    """对输入的 4 个点按 [左上, 右上, 右下, 左下] 顺时针排序"""
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]  # TL
    rect[2] = pts[np.argmax(s)]  # BR

    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]  # TR
    rect[3] = pts[np.argmax(diff)]  # BL
    return rect

def detect_quad_corners(img, canny_low=50, canny_high=200, approx_coef=0.02, min_area_ratio=0.05):
    """自动检测梯形/矩形边缘的 4 个顶点"""
    h, w = img.shape[:2]
    img_area = h * w

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, canny_low, canny_high)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel)

    cnts, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None

    cnts = sorted(cnts, key=cv2.contourArea, reverse=True)

    for c in cnts[:5]:
        area = cv2.contourArea(c)
        if area < img_area * min_area_ratio:
            continue

        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, approx_coef * peri, True)

        if len(approx) == 4 and cv2.isContourConvex(approx):
            pts = approx.reshape(4, 2)
            return order_points(pts)

    return None

def calculate_homography_and_size(img_shape, src_pts):
    """计算全局透视变换矩阵，保证全图按比例变换且不被裁切"""
    h, w = img_shape[:2]
    tl, tr, br, bl = src_pts

    width_top = np.linalg.norm(tr - tl)
    width_bottom = np.linalg.norm(br - bl)
    target_w = max(int(width_top), int(width_bottom))

    height_left = np.linalg.norm(bl - tl)
    height_right = np.linalg.norm(br - tr)
    target_h = max(int(height_left), int(height_right))

    dst_pts = np.float32([
        [0, 0],
        [target_w, 0],
        [target_w, target_h],
        [0, target_h]
    ])

    H = cv2.getPerspectiveTransform(src_pts, dst_pts)

    img_corners = np.float32([[0, 0], [w, 0], [w, h], [0, h]]).reshape(-1, 1, 2)
    transformed_corners = cv2.perspectiveTransform(img_corners, H)

    x_coords = transformed_corners[:, 0, 0]
    y_coords = transformed_corners[:, 0, 1]

    x_min, x_max = np.min(x_coords), np.max(x_coords)
    y_min, y_max = np.min(y_coords), np.max(y_coords)

    new_w = int(np.ceil(x_max - x_min))
    new_h = int(np.ceil(y_max - y_min))

    T = np.array([
        [1, 0, -x_min],
        [0, 1, -y_min],
        [0, 0, 1]
    ], dtype=np.float32)

    H_final = T @ H
    return H_final, (new_w, new_h)

def warp_image_by_pts(img_bgr, pts):
    """通过指定的 4 点进行全图无损校正"""
    ordered_pts = order_points(np.float32(pts))
    H_final, new_size = calculate_homography_and_size(img_bgr.shape, ordered_pts)
    rectified_bgr = cv2.warpPerspective(
        img_bgr, H_final, new_size,
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(255, 255, 255)
    )
    return rectified_bgr

# ================= 辅助函数：绘制顺序选点 (用于UI极速交互) =================

def draw_sequential_points(img_bgr, pts):
    """在图像上按 1,2,3,4 顺序绘制点和连线"""
    img_drawn = img_bgr.copy()
    if len(pts) > 0:
        for i, p in enumerate(pts):
            cv2.circle(img_drawn, tuple(p), 8, (0, 0, 255), -1)  # 红点
            cv2.putText(img_drawn, str(i + 1), (p[0] + 12, p[1] + 12),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 0), 2)  # 绿字序号
        if len(pts) > 1:
            pts_arr = np.array(pts, dtype=np.int32)
            cv2.polylines(img_drawn, [pts_arr], isClosed=(len(pts) == 4), color=(255, 0, 0), thickness=2)
    return img_drawn

# ================= Web 交互逻辑 =================

def start_batch_processing(files, canny_low, canny_high, approx_coef, state):
    """限制最大 50 张，自动分类为成功组与待手动处理组"""
    if not files:
        return state, "⚠️ 请先上传图片！", gr.Dropdown(choices=[]), gr.Dropdown(choices=[]), []

    MAX_FILES = 50
    if len(files) > MAX_FILES:
        files = files[:MAX_FILES]
        msg_suffix = f"（已截取前 {MAX_FILES} 张）"
    else:
        msg_suffix = ""

    state = {
        "auto_success": {},
        "manual_queue": {},
        "saved_manual": {}
    }

    for file in files:
        file_path = file.name
        filename = os.path.basename(file_path)
        img_bgr = cv2.imread(file_path)

        if img_bgr is None: continue

        src_pts = detect_quad_corners(img_bgr, canny_low, canny_high, approx_coef)

        if src_pts is not None:
            rect_bgr = warp_image_by_pts(img_bgr, src_pts)
            state["auto_success"][filename] = {"path": file_path, "bgr": img_bgr, "rect_bgr": rect_bgr}
        else:
            state["manual_queue"][filename] = {"path": file_path, "bgr": img_bgr, "pts": [], "rect_bgr": None}

    success_keys = list(state["auto_success"].keys())
    manual_keys = list(state["manual_queue"].keys())
    gallery_imgs = [cv2.cvtColor(v["rect_bgr"], cv2.COLOR_BGR2RGB) for v in state["auto_success"].values()]
    status = f"✅ 分组完成！自动成功 {len(success_keys)} 张，待手动校正 {len(manual_keys)} 张。{msg_suffix}"

    return state, status, gr.Dropdown(choices=success_keys, value=success_keys[0] if success_keys else None), gr.Dropdown(choices=manual_keys, value=manual_keys[0] if manual_keys else None), gallery_imgs

def move_success_to_manual(selected_filename, state):
    if not selected_filename or selected_filename not in state["auto_success"]:
        return state, "⚠️ 请选择要转移的图片", gr.Dropdown(), gr.Dropdown(), []

    item = state["auto_success"].pop(selected_filename)
    state["manual_queue"][selected_filename] = {"path": item["path"], "bgr": item["bgr"], "pts": [], "rect_bgr": None}

    success_keys = list(state["auto_success"].keys())
    manual_keys = list(state["manual_queue"].keys())
    gallery_imgs = [cv2.cvtColor(v["rect_bgr"], cv2.COLOR_BGR2RGB) for v in state["auto_success"].values()]

    return state, f"已将 [{selected_filename}] 移入手动队列！", gr.Dropdown(choices=success_keys, value=success_keys[0] if success_keys else None), gr.Dropdown(choices=manual_keys, value=selected_filename), gallery_imgs

def load_manual_image(selected_filename, state):
    """加载图片并生成降分辨率轻量版用于UI显示（秒级响应核心）"""
    if not selected_filename or selected_filename not in state["manual_queue"]:
        return None, None, "未选择有效图片"

    item = state["manual_queue"][selected_filename]
    
    # 动态生成缩略图，告别网络传输卡顿
    orig_img = item["bgr"]
    h, w = orig_img.shape[:2]
    scale = min(1.0, 1024.0 / max(h, w))  # UI显示最长边控制在1024
    item["scale"] = scale
    item["disp_img"] = cv2.resize(orig_img, (int(w * scale), int(h * scale)))

    # 换算当前已有的真实坐标点为UI显示坐标
    disp_pts = [[int(p[0] * scale), int(p[1] * scale)] for p in item["pts"]]
    img_drawn = draw_sequential_points(item["disp_img"], disp_pts)
    img_rgb = cv2.cvtColor(img_drawn, cv2.COLOR_BGR2RGB)

    rect_rgb = cv2.cvtColor(item["rect_bgr"], cv2.COLOR_BGR2RGB) if item["rect_bgr"] is not None else None
    info = f"当前图片: {selected_filename} | 已选点数: {len(item['pts'])}/4 (请依次点击 4 个角)"

    return img_rgb, rect_rgb, info

def on_image_click(evt: gr.SelectData, selected_filename, state):
    """极速收集点击坐标（只做数据记录，不进行矩阵校正计算）"""
    if not selected_filename or selected_filename not in state["manual_queue"]:
        return None, state, "请先选择图片"

    item = state["manual_queue"][selected_filename]
    pts = item["pts"]

    if len(pts) >= 4:
        # 已满4点只刷新UI
        disp_pts = [[int(p[0]*item["scale"]), int(p[1]*item["scale"])] for p in pts]
        img_drawn = draw_sequential_points(item["disp_img"], disp_pts)
        return cv2.cvtColor(img_drawn, cv2.COLOR_BGR2RGB), state, "⚠️ 4点已选齐！请点击【▶️ 处理当前图片】执行校正。"

    # 将 UI 点击的缩略图坐标，映射回真实的高清原图坐标并保存
    x_disp, y_disp = evt.index[0], evt.index[1]
    scale = item.get("scale", 1.0)
    pts.append([x_disp / scale, y_disp / scale])

    disp_pts = [[int(p[0]*scale), int(p[1]*scale)] for p in pts]
    img_drawn = draw_sequential_points(item["disp_img"], disp_pts)
    img_rgb = cv2.cvtColor(img_drawn, cv2.COLOR_BGR2RGB)

    status_msg = f"已选取第 {len(pts)}/4 个点。"
    if len(pts) == 4:
        status_msg += " 🎉 4点集齐！点击【▶️ 处理当前图片】统一执行后台原图校正。"

    return img_rgb, state, status_msg

def undo_last_point(selected_filename, state):
    if not selected_filename or selected_filename not in state["manual_queue"]:
        return None, state, "请先选择图片"

    item = state["manual_queue"][selected_filename]
    if item["pts"]:
        item["pts"].pop()
        item["rect_bgr"] = None

    disp_pts = [[int(p[0]*item["scale"]), int(p[1]*item["scale"])] for p in item["pts"]]
    img_drawn = draw_sequential_points(item["disp_img"], disp_pts)
    return cv2.cvtColor(img_drawn, cv2.COLOR_BGR2RGB), state, f"已撤销一步，当前: {len(item['pts'])}/4"

def process_current_manual(selected_filename, state):
    """4点选完后，一次性集中读取坐标进行真正的高清原图处理"""
    if not selected_filename or selected_filename not in state["manual_queue"]:
        return None, "⚠️ 当前无选中的图片！", state

    item = state["manual_queue"][selected_filename]
    if len(item["pts"]) < 4:
        return None, f"⚠️ 请先选满 4 个点后再处理！", state

    # 在后台针对原始高清大图执行运算
    rect_bgr = warp_image_by_pts(item["bgr"], item["pts"])
    item["rect_bgr"] = rect_bgr
    rect_rgb = cv2.cvtColor(rect_bgr, cv2.COLOR_BGR2RGB)

    return rect_rgb, f"✅ [{selected_filename}] 高清原图校正完成！如满意请点击保存或直接套用下一张。", state

def process_next_with_same_pts(selected_filename, state):
    """【新功能】保存当前图片，并直接沿用当前的 4 个坐标点自动处理列表中的下一张图"""
    if not selected_filename or selected_filename not in state["manual_queue"]:
        return "⚠️ 当前无选中图片！", state, gr.Dropdown()

    item = state["manual_queue"][selected_filename]
    if len(item["pts"]) < 4:
        return "⚠️ 当前图片尚未选满4个点，无法沿用！", state, gr.Dropdown()

    # 1. 保存当前图片（如果还没处理，自动补全处理再保存）
    if item["rect_bgr"] is None:
        item["rect_bgr"] = warp_image_by_pts(item["bgr"], item["pts"])
    state["saved_manual"][selected_filename] = {"rect_bgr": item["rect_bgr"]}
    
    # 2. 拷贝当前的坐标点
    pts_to_copy = list(item["pts"])
    state["manual_queue"].pop(selected_filename)

    manual_keys = list(state["manual_queue"].keys())
    if not manual_keys:
        return "🎉 所有图片已全部处理完毕！", state, gr.Dropdown(choices=[], value=None)

    # 3. 读取下一张图片，套用坐标并自动处理
    next_filename = manual_keys[0]
    next_item = state["manual_queue"][next_filename]
    next_item["pts"] = pts_to_copy
    next_item["rect_bgr"] = warp_image_by_pts(next_item["bgr"], pts_to_copy)

    # UI Dropdown 值的变更会自动触发 `load_manual_image` 刷新界面展示新图片的预览
    status = f"💾 已保存上图，并成功沿用坐标自动处理下一张 [{next_filename}]！"
    return status, state, gr.Dropdown(choices=manual_keys, value=next_filename)

def save_single_manual_image(selected_filename, state):
    """仅保存当前单张"""
    if not selected_filename or selected_filename not in state["manual_queue"]:
        return "⚠️ 当前无选中的图片！", state, gr.Dropdown()

    item = state["manual_queue"][selected_filename]
    if item["rect_bgr"] is None:
        return f"⚠️ 尚未执行处理！请先选满4点点击『▶️ 处理当前图片』", state, gr.Dropdown()

    state["saved_manual"][selected_filename] = {"rect_bgr": item["rect_bgr"]}
    state["manual_queue"].pop(selected_filename)

    manual_keys = list(state["manual_queue"].keys())
    saved_count = len(state["saved_manual"])
    status = f"💾 成功保存！累计手动完成 {saved_count} 张。"
    
    return status, state, gr.Dropdown(choices=manual_keys, value=manual_keys[0] if manual_keys else None)

def export_zip_package(state):
    """导出打包（重命名为 Adj_xxx.jpg）"""
    if not state or (not state["auto_success"] and not state["saved_manual"]):
        return None, "⚠️ 尚无校正成功的图片可供打包！"

    temp_dir = tempfile.mkdtemp()
    zip_path = os.path.join(temp_dir, "rectified_images.zip")
    count = 0

    with zipfile.ZipFile(zip_path, 'w') as zipf:
        for fname, item in state["auto_success"].items():
            out_filename = f"Adj_{fname}"
            out_path = os.path.join(temp_dir, out_filename)
            cv2.imwrite(out_path, item["rect_bgr"], [int(cv2.IMWRITE_JPEG_QUALITY), 100])
            zipf.write(out_path, arcname=out_filename)
            count += 1

        for fname, item in state["saved_manual"].items():
            out_filename = f"Adj_{fname}"
            out_path = os.path.join(temp_dir, out_filename)
            cv2.imwrite(out_path, item["rect_bgr"], [int(cv2.IMWRITE_JPEG_QUALITY), 100])
            zipf.write(out_path, arcname=out_filename)
            count += 1

    return zip_path, f"🎉 导出完成！共打包 {count} 张图片（已重命名为 Adj_*.jpg）"

# ================= Gradio Web UI 构建 =================

with gr.Blocks(title="极速梯形校正（UI解耦+连拍同机位处理）", theme=gr.themes.Soft()) as demo:
    state = gr.State({})

    gr.Markdown("# 🖼️ 批量图片极速梯形校正工具")

    with gr.Row():
        files_input = gr.File(file_count="multiple", label="选择/拖拽上传图片（最多 50 张）")
        btn_start = gr.Button("🚀 1. 开始智能分组", variant="primary")

    status_global = gr.Textbox(label="系统运行状态", interactive=False)

    with gr.Tabs():
        with gr.TabItem("✅ 自动校正成功组"):
            with gr.Row():
                success_dropdown = gr.Dropdown(label="自动校正成功图片列表", choices=[])
                btn_move_manual = gr.Button("↪️ 效果不满意？移入待手动校正队列", variant="warning")
            gallery_success = gr.Gallery(label="自动成功图片预览", columns=4)

        with gr.TabItem("✍️ 待手动校正 (无延迟连拍极速模式)"):
            manual_dropdown = gr.Dropdown(label="待处理/修改图片列表", choices=[])
            manual_status = gr.Markdown("👉 **交互提示**：现在点击瞬间即响应。点齐4点后集中执行算法。")

            with gr.Row():
                img_manual_orig = gr.Image(label="原图标定区 (毫秒级响应)", type="numpy")
                img_manual_rect = gr.Image(label="高清校正效果预览", type="numpy")

            with gr.Row():
                btn_undo_pt = gr.Button("↩️ 撤销一点", variant="secondary")
                btn_process_current = gr.Button("▶️ 1. 处理当前图片", variant="primary")
                btn_save_single = gr.Button("💾 2. 保存当前图片", variant="primary")
            
            with gr.Row():
                btn_process_next_same = gr.Button("⏭️ 3. 沿用该坐标，保存并处理下一张 (同角度连拍专用)", variant="warning")

    gr.Markdown("---")
    with gr.Row():
        btn_export = gr.Button("📦 批量导出全部结果 (.zip)", variant="primary", size="lg")
        download_zip = gr.File(label="⬇️ 下载压缩包")

    # ================= 事件绑定 =================
    btn_start.click(
        start_batch_processing,
        inputs=[files_input, gr.State(50), gr.State(200), gr.State(0.02), state],
        outputs=[state, status_global, success_dropdown, manual_dropdown, gallery_success]
    )

    btn_move_manual.click(
        move_success_to_manual,
        inputs=[success_dropdown, state],
        outputs=[state, status_global, success_dropdown, manual_dropdown, gallery_success]
    )

    # 下拉框切换，加载并降采样显示图
    manual_dropdown.change(
        load_manual_image,
        inputs=[manual_dropdown, state],
        outputs=[img_manual_orig, img_manual_rect, manual_status]
    )

    # 极速收集坐标
    img_manual_orig.select(
        on_image_click,
        inputs=[manual_dropdown, state],
        outputs=[img_manual_orig, state, manual_status]
    )

    btn_undo_pt.click(
        undo_last_point,
        inputs=[manual_dropdown, state],
        outputs=[img_manual_orig, state, manual_status]
    )

    # 点击按钮时，统一进行高清原图计算
    btn_process_current.click(
        process_current_manual,
        inputs=[manual_dropdown, state],
        outputs=[img_manual_rect, status_global, state]
    )

    btn_save_single.click(
        save_single_manual_image,
        inputs=[manual_dropdown, state],
        outputs=[status_global, state, manual_dropdown]
    )

    # 核心新功能：同机位连拍极速处理
    btn_process_next_same.click(
        process_next_with_same_pts,
        inputs=[manual_dropdown, state],
        outputs=[status_global, state, manual_dropdown]
    )

    btn_export.click(
        export_zip_package,
        inputs=[state],
        outputs=[download_zip, status_global]
    )

if __name__ == "__main__":
    demo.launch(inbrowser=True, share=False)