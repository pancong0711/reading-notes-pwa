/* ============================================================
 * 阅读热力图组件（M4 · PWA 阅读端）
 * ------------------------------------------------------------
 * 纯 ES Module，零依赖、零构建。脚本加载后自动在挂载点
 * （优先 #heatmap-mount，其次 #heatmap）内构建：
 *   工具栏（年视图 / 近6月 / 近3年 / 近7日）+ 滚动容器 + SVG 热力图。
 *
 * 四档视图与 CLI 版 heatmap.py 逻辑一致：
 *   · 年视图（year）：当前自然年 53 周 × 7 天按天网格
 *     （周日为每周第一行，月份标签标在每月 1 号所在列）
 *   · 近6月（6m）  ：26 个周格子一行，每周聚合笔记数，
 *     顶部月份标签 + 每 4 周标周起始日期
 *   · 近3年（3y）  ：3 行 × 12 列月格子，格内显示当月笔记数
 *   · 近7日（7d）  ：最近 7 天逐日明细条（日期/星期/笔记数/强度条）
 *
 * 交互：
 *   1. 左右平移——容器 overflow-x 滚动条 + 指针拖拽
 *   2. 缩放——滚轮改变格子尺寸（8px ~ 20px，以鼠标为锚点）
 *   3. hover——悬停格子显示日期 + 笔记数 tooltip（跟随鼠标）
 *
 * 数据源：window.__ACTIVITY__ = [{date, notes, images, pages}]；
 * 未注入时使用内置确定性伪随机示例（近 90 天，线性同余可复现）。
 *
 * 注意：ES Module 在 file:// 直开时会被浏览器 CORS 拦截（模块
 * 特性所致），请在 app/pwa/ 下起静态服务后访问，例如：
 *   cd app/pwa && python3 -m http.server 8000
 * ============================================================ */

// —— 常量：颜色分档与版式（与 heatmap.py 保持一致） ——
const SVG_NS = 'http://www.w3.org/2000/svg';
const COLORS = ['#ebedf0', '#9be9a8', '#40c463', '#216e39']; // 0 / 1 / 2-3 / 4+
const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']; // 周日第一行
const MIN_CELL = 8;        // 缩放格子尺寸下限（px）
const MAX_CELL = 20;       // 缩放格子尺寸上限（px）
const DEFAULT_CELL = 11;   // 默认格子尺寸（与 CLI 的 CELL=11 一致）
const GAP = 2;             // 格子间距（与 CLI 的 GAP=2 一致）
const YEAR_LEFT = 36;      // 年视图：左侧星期标签区宽度
const WEEK_LEFT = 10;      // 6月视图：左侧留白
const MONTH_LEFT = 46;     // 3年视图：行首年份标签列宽
const YEAR_GRID_TOP = 22;  // 年视图：网格顶部 y（上方留月份标签区）
const WEEK_TOP = 24;       // 6月视图：格子顶部 y
const MONTH_TOP = 26;      // 3年视图：网格顶部 y（下方为网格）
const DAY_TOP = 12;        // 7日视图：首行 y
const DAY_LEFT = 62;       // 7日视图：日期(38) + 星期(24) 左列宽
const DAY_BAR_W = 150;     // 7日视图：强度条轨道最大宽度
const MS_DAY = 86400000;   // 一天的毫秒数
const VIEWS = [
  { id: 'year', label: '年视图' },
  { id: '6m', label: '近6月' },
  { id: '3y', label: '近3年' },
  { id: '7d', label: '近7日' },
];

// —— 组件状态 ——
let activity = [];     // 聚合后的活动数据
let view = 'year';     // 当前视图：year | 6m | 3y | 7d
let cellSize = DEFAULT_CELL;
let scroller = null;   // 横向滚动容器
let tooltip = null;    // 提示层（挂 body，避免被容器裁剪）
let gridLeft = 0;      // 当前视图网格左起点 x（缩放锚点用）
let gridPitch = 0;     // 当前视图每列间距 px（缩放锚点用）
let gridStart = null;  // 年视图网格首日（周日），初始居中用
let dragging = false;  // 是否正在拖拽平移

// —— 小工具 ——
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pad2 = (n) => String(n).padStart(2, '0');

// —— 日期工具（一律用本地时区，避免 UTC 偏移错一天） ——
function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function fmtISO(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function weekSunday(d) {
  // 周日视为一周第一天：向前回退 getDay() 天
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
}

// —— 数据源 ——
function makeSampleData() {
  // 确定性伪随机：线性同余生成器（固定种子 → 结果可复现）
  let seed = 20260730;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const data = [];
  const today = new Date();
  for (let i = 89; i >= 0; i--) {             // 近 90 天
    const d = addDays(today, -i);
    if (rnd() < 0.42) continue;               // 约 42% 的日子有阅读活动
    const r = rnd();
    let notes;
    if (r < 0.35) notes = 1;                          // 档位 1
    else if (r < 0.75) notes = 2 + Math.floor(rnd() * 2); // 档位 2-3
    else notes = 4 + Math.floor(rnd() * 3);           // 档位 4+
    data.push({
      date: fmtISO(d),
      notes,
      images: Math.floor(rnd() * 3),
      pages: String(10 + Math.floor(rnd() * 51)),
    });
  }
  return data.sort((a, b) => (a.date < b.date ? -1 : 1));
}

function getActivity() {
  const raw = window.__ACTIVITY__;
  if (Array.isArray(raw)) {
    // 已注入真实数据（含空数组 → 全灰热力图）。
    // 不再回退到伪随机示例数据，避免把演示数据当成真实阅读量。
    return raw
      .filter((d) => d && d.date)
      .map((d) => ({
        date: d.date,
        notes: Number(d.notes) || 0,
        images: Number(d.images) || 0,
        pages: String(d.pages ?? ''),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  return makeSampleData(); // 仅当页面完全未注入 __ACTIVITY__ 时兜底（开发预览用）
}

// —— 颜色分档（与 heatmap.py _color_for 一致） ——
function colorFor(level) {
  if (level <= 0) return COLORS[0];
  if (level === 1) return COLORS[1];
  if (level <= 3) return COLORS[2];
  return COLORS[3];
}

// —— SVG 构建辅助 ——
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}
function textEl(x, y, content, attrs) {
  const t = svgEl('text', Object.assign({ x, y }, attrs || {}));
  t.textContent = content;
  return t;
}

// —— 窗口与聚合 ——
function yearWindow() {
  // 年视图窗口 = 当前自然年（1 月 1 日 ~ 12 月 31 日，整 12 个月）
  const y = new Date().getFullYear();
  return { start: new Date(y, 0, 1), end: new Date(y, 11, 31) };
}

function weekAgg(weeks = 26) {
  // 近 N 周聚合：周日为一周起点，统计每周笔记总数
  const curSunday = weekSunday(new Date());
  const startSunday = addDays(curSunday, -(weeks - 1) * 7);
  const sum = {};
  for (const d of activity) {
    const ws = weekSunday(parseISO(d.date));
    if (ws >= startSunday && ws <= curSunday) {
      const k = fmtISO(ws);
      sum[k] = (sum[k] || 0) + d.notes;
    }
  }
  return { startSunday, curSunday, sum };
}

function monthAgg() {
  // 近 3 年按月聚合：内部键 = '年-月'（月从 0 计，仅作键用）
  const cy = new Date().getFullYear();
  const sum = {};
  for (const d of activity) {
    const dt = parseISO(d.date);
    const k = `${dt.getFullYear()}-${dt.getMonth()}`;
    sum[k] = (sum[k] || 0) + d.notes;
  }
  const yearList = [];
  for (let y = cy - 2; y <= cy; y++) yearList.push(y);
  return { yearList, sum };
}

// —— 视图一：年视图（53 周 × 7 天按天网格） ——
function buildYear(svg) {
  const { start, end } = yearWindow();
  const gs = weekSunday(start);                  // 网格首日 = 起点所在周的周日
  const totalDays = Math.round((end - gs) / MS_DAY) + 1;
  const cols = Math.ceil(totalDays / 7);         // 列数 = 周数（向上取整，余周补灰）
  const pitch = cellSize + GAP;
  const rows = 7;
  gridLeft = YEAR_LEFT;
  gridPitch = pitch;
  gridStart = gs;

  const intensity = {};
  for (const d of activity) intensity[d.date] = d;

  // 月份标签：标在每月 1 号所在列
  for (let m = 0; m < 12; m++) {
    const first = new Date(start.getFullYear(), m, 1);
    const col = Math.floor((first - gs) / (7 * MS_DAY));
    if (col >= 0 && col < cols) {
      svg.appendChild(textEl(YEAR_LEFT + col * pitch + 1, 14, `${m + 1}月`, {
        'font-size': 10, fill: '#767676',
      }));
    }
  }
  // 星期标签（左列，右对齐，周日最上）
  for (let r = 0; r < rows; r++) {
    svg.appendChild(textEl(YEAR_LEFT - 6, YEAR_GRID_TOP + r * pitch + cellSize * 0.75,
      WEEKDAY_LABELS[r], { 'font-size': 9, fill: '#767676', 'text-anchor': 'end' }));
  }
  // 格子：完整列网格（窗口外余数周也渲染灰色，GitHub 风格）
  for (let i = 0; i < cols * rows; i++) {
    const day = addDays(gs, i);
    const col = Math.floor(i / rows);
    const row = i % rows;
    const key = fmtISO(day);
    const act = intensity[key];
    const rect = svgEl('rect', {
      class: 'hm-cell',
      x: YEAR_LEFT + col * pitch,
      y: YEAR_GRID_TOP + row * pitch,
      width: cellSize,
      height: cellSize,
      rx: 2,
      fill: colorFor(act ? act.notes : 0),
    });
    // tooltip 文案：日期 + 笔记数（有图 / 页时一并展示）
    if (day >= start && day <= end) {
      if (act) {
        const parts = [`${key} · 笔记 ${act.notes}`];
        if (act.images > 0) parts.push(`图 ${act.images}`);
        if (Number(act.pages) > 0) parts.push(`页 ${act.pages}`);
        rect.dataset.tip = parts.join(' · ');
      } else {
        rect.dataset.tip = `${key} · 笔记 0`;
      }
    } else {
      rect.dataset.tip = `${key}（窗口外）`;
    }
    svg.appendChild(rect);
  }
  return {
    width: YEAR_LEFT + cols * pitch + 10,
    height: YEAR_GRID_TOP + rows * pitch + 8,
  };
}

// —— 视图二：近 6 月（26 个周格子一行，每周聚合） ——
function build6m(svg) {
  const { startSunday, sum } = weekAgg(26);
  const cellW = cellSize + 6;    // 周格子略宽（默认 17px，与 CLI 18px 接近）
  const cellH = cellSize;
  const pitch = cellW + GAP;
  const weeks = 26;
  gridLeft = WEEK_LEFT;
  gridPitch = pitch;
  gridStart = null;

  // 顶部月份标签：该周跨月时标新月份（与 CLI render_week_view 一致）
  let prevMonth = null;
  for (let i = 0; i < weeks; i++) {
    const ws = addDays(startSunday, i * 7);
    const we = addDays(ws, 6);
    const ml = ws.getMonth() !== we.getMonth() ? we.getMonth() : ws.getMonth();
    if (ml !== prevMonth) {
      svg.appendChild(textEl(WEEK_LEFT + i * pitch + 1, WEEK_TOP - 10, `${ml + 1}月`, {
        'font-size': 9, fill: '#767676',
      }));
    }
    prevMonth = ml;
  }
  // 格子 + 每 4 周标周起始日期（mm-dd）
  for (let i = 0; i < weeks; i++) {
    const ws = addDays(startSunday, i * 7);
    const we = addDays(ws, 6);
    const n = sum[fmtISO(ws)] || 0;
    const x = WEEK_LEFT + i * pitch;
    const rect = svgEl('rect', {
      class: 'hm-cell',
      x, y: WEEK_TOP, width: cellW, height: cellH, rx: 2, fill: colorFor(n),
    });
    rect.dataset.tip = `${fmtISO(ws)} ~ ${fmtISO(we)} · 本周笔记 ${n}`;
    svg.appendChild(rect);
    if (i % 4 === 0) {
      svg.appendChild(textEl(x + 1, WEEK_TOP + cellH + 12,
        `${pad2(ws.getMonth() + 1)}-${pad2(ws.getDate())}`, {
          'font-size': 8, fill: '#999',
        }));
    }
  }
  return {
    width: WEEK_LEFT + weeks * pitch + 10,
    height: WEEK_TOP + cellH + 18,
  };
}

// —— 视图三：近 3 年（3 行 × 12 列月格子，格内显示当月笔记数） ——
function build3y(svg) {
  const { yearList, sum } = monthAgg();
  const k = cellSize / DEFAULT_CELL;                 // 缩放系数（默认 11px 时为 1）
  const cellW = Math.max(24, Math.round(40 * k));
  const cellH = Math.max(14, Math.round(24 * k));
  const gap = Math.max(2, Math.round(4 * k));
  const pitch = cellW + gap;
  const rows = yearList.length;
  gridLeft = MONTH_LEFT;
  gridPitch = pitch;
  gridStart = null;

  // 顶部列标：1月 ~ 12月
  for (let m = 0; m < 12; m++) {
    svg.appendChild(textEl(MONTH_LEFT + m * pitch + cellW / 2, MONTH_TOP - 8,
      `${m + 1}月`, { 'font-size': 9, fill: '#767676', 'text-anchor': 'middle' }));
  }
  // 每行：年份 + 12 个月格子
  yearList.forEach((y, yi) => {
    const y0 = MONTH_TOP + yi * (cellH + gap);
    svg.appendChild(textEl(MONTH_LEFT - 6, y0 + cellH - 6, String(y), {
      'font-size': 11, fill: '#1a1a1a', 'text-anchor': 'end',
    }));
    for (let m = 0; m < 12; m++) {
      const x = MONTH_LEFT + m * pitch;
      const n = sum[`${y}-${m}`] || 0;
      const rect = svgEl('rect', {
        class: 'hm-cell',
        x, y: y0, width: cellW, height: cellH, rx: 3, fill: colorFor(n),
      });
      rect.dataset.tip = `${y}年${m + 1}月 · 笔记 ${n}`;
      svg.appendChild(rect);
      if (n > 0) {
        svg.appendChild(textEl(x + cellW / 2, y0 + cellH / 2 + 4, String(n), {
          'font-size': 11, fill: '#1a1a1a', 'text-anchor': 'middle',
        }));
      }
    }
  });
  return {
    width: MONTH_LEFT + 12 * pitch + 10,
    height: MONTH_TOP + rows * (cellH + gap) + 8,
  };
}

// —— 视图四：近 7 日（逐日明细条，最旧在上、今天在底） ——
function renderDayView(svg) {
  const DAYS = 7;
  const rowH = cellSize + 12;                       // 行高（随缩放联动）
  const intensity = {};
  for (const d of activity) intensity[d.date] = d;

  // 收集近 7 天（含今天）并求最大笔记数（强度条归一化基准）
  const today = new Date();
  const rows = [];
  let maxNotes = 0;
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    const act = intensity[fmtISO(d)];
    const notes = act ? act.notes : 0;
    if (notes > maxNotes) maxNotes = notes;
    rows.push({ d, act, notes });
  }

  gridLeft = DAY_LEFT;
  gridPitch = rowH;
  gridStart = null;

  rows.forEach((row, r) => {
    const y = DAY_TOP + r * rowH;
    const { d, act, notes } = row;
    // 日期（MM-DD）+ 星期（周日在 WEEKDAY_LABELS 首位，与年视图一致）
    svg.appendChild(textEl(0, y + cellSize - 1, `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`, {
      'font-size': 11, fill: '#333',
    }));
    svg.appendChild(textEl(DAY_LEFT - 24, y + cellSize - 1, `周${WEEKDAY_LABELS[d.getDay()]}`, {
      'font-size': 9, fill: '#767676',
    }));
    if (notes > 0) {
      // 强度条：宽度按最大笔记数归一化（至少 4px 保证可见），颜色沿用热力图色系
      const bw = Math.max(4, Math.round((notes / maxNotes) * DAY_BAR_W));
      const rect = svgEl('rect', {
        class: 'hm-cell',
        x: DAY_LEFT, y: y + 1, width: bw, height: cellSize, rx: 2,
        fill: colorFor(notes),
      });
      const parts = [`${fmtISO(d)} · 笔记 ${notes}`];
      if (act.images > 0) parts.push(`图 ${act.images}`);
      if (Number(act.pages) > 0) parts.push(`页 ${act.pages}`);
      rect.dataset.tip = parts.join(' · ');
      svg.appendChild(rect);
      svg.appendChild(textEl(DAY_LEFT + DAY_BAR_W + 10, y + cellSize - 1, `笔记 ${notes}`, {
        'font-size': 10, fill: '#555',
      }));
    } else {
      svg.appendChild(textEl(DAY_LEFT, y + cellSize - 1, '无记录', {
        'font-size': 10, fill: '#bbb',
      }));
    }
  });

  return {
    width: DAY_LEFT + DAY_BAR_W + 64,
    height: DAY_TOP + DAYS * rowH + 6,
  };
}

// —— 渲染入口：按当前视图重建 SVG（每次切换 / 缩放都重建） ——
function render(centerOnToday) {
  const svg = svgEl('svg', { class: 'hm-svg' });
  let size;
  if (view === 'year') size = buildYear(svg);
  else if (view === '6m') size = build6m(svg);
  else if (view === '3y') size = build3y(svg);
  else size = renderDayView(svg);   // 7d 近7日
  svg.setAttribute('width', size.width);
  svg.setAttribute('height', size.height);
  svg.addEventListener('mousemove', onSvgMove);
  svg.addEventListener('mouseleave', hideTooltip);
  scroller.replaceChildren(svg);

  // 滚动定位：切换视图时把"当前"放到可视区
  const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  if (centerOnToday) {
    if (view === 'year' && gridStart) {
      // 年视图：以今天所在列为中心（向左平移可回看年初历史）
      const col = Math.floor((new Date() - gridStart) / (7 * MS_DAY));
      scroller.scrollLeft = clamp(col * gridPitch + gridLeft - scroller.clientWidth / 2, 0, maxScroll);
    } else {
      // 6月 / 3年：滚到最右（最新周 / 月在最右）
      scroller.scrollLeft = maxScroll;
    }
  } else {
    scroller.scrollLeft = clamp(scroller.scrollLeft, 0, maxScroll);
  }
  hideTooltip();
}

// —— 交互 3：hover tooltip（跟随鼠标） ——
function onSvgMove(e) {
  if (dragging) { hideTooltip(); return; } // 拖拽中不显示
  const cell = e.target.closest ? e.target.closest('rect.hm-cell') : null;
  if (!cell || !cell.dataset.tip) { hideTooltip(); return; }
  tooltip.textContent = cell.dataset.tip;
  tooltip.classList.add('show');
  positionTooltip(e.clientX, e.clientY);
}
function hideTooltip() {
  if (tooltip) tooltip.classList.remove('show');
}
function positionTooltip(cx, cy) {
  const pad = 14;
  let x = cx + pad;
  let y = cy + pad;
  const tw = tooltip.offsetWidth;
  const th = tooltip.offsetHeight;
  if (x + tw > window.innerWidth - 8) x = cx - tw - pad;  // 右侧越界 → 移到鼠标左侧
  if (y + th > window.innerHeight - 8) y = cy - th - pad; // 底部越界 → 移到鼠标上方
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

// —— 交互 1：指针拖拽平移（配合 overflow-x 滚动条） ——
function setupDrag() {
  let drag = null;
  scroller.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // 仅鼠标左键 / 触摸
    drag = { id: e.pointerId, startX: e.clientX, startLeft: scroller.scrollLeft };
    scroller.setPointerCapture(e.pointerId);
    scroller.classList.add('hm-dragging');
    dragging = true;
    hideTooltip();
  });
  scroller.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    // 记录起点偏移，反向跟随 → 内容随指针平移
    scroller.scrollLeft = drag.startLeft - (e.clientX - drag.startX);
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    dragging = false;
    scroller.classList.remove('hm-dragging');
  };
  scroller.addEventListener('pointerup', endDrag);
  scroller.addEventListener('pointercancel', endDrag);
}

// —— 交互 2：滚轮缩放（8~20px，以鼠标所在列为锚点） ——
function setupZoom() {
  scroller.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1; // 上滚放大、下滚缩小
    const next = clamp(Math.round(cellSize * factor), MIN_CELL, MAX_CELL);
    if (next === cellSize) return;
    // 记录鼠标当前所在的列（锚点，按旧尺寸计算）
    const rect = scroller.getBoundingClientRect();
    const viewportX = e.clientX - rect.left;
    const colUnder = (scroller.scrollLeft + viewportX - gridLeft) / gridPitch;
    cellSize = next;
    render(false);
    // 重建后把锚点列重新对齐到鼠标位置
    const target = colUnder * gridPitch + gridLeft - viewportX;
    scroller.scrollLeft = clamp(target, 0, Math.max(0, scroller.scrollWidth - scroller.clientWidth));
  }, { passive: false });
}

// —— 初始化 ——
async function init() {
  // 优先使用 index.html 的挂载点，兼容任务约定的 #heatmap
  const host = document.getElementById('heatmap-mount') || document.getElementById('heatmap');
  if (!host) {
    console.warn('[heatmap] 未找到挂载点 #heatmap-mount / #heatmap');
    return;
  }
  // 等真实数据注入完成（activity.js 提供），避免拿不到 __ACTIVITY__
  if (window.__ACTIVITY_READY__) {
    try {
      await window.__ACTIVITY_READY__;
    } catch (e) {
      console.warn('[heatmap] 等待活动数据超时/失败：', e);
    }
  }
  // 自加载样式（index.html 未直接引入 heatmap.css 时保证组件样式完整）
  if (!document.querySelector('link[href="heatmap.css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'heatmap.css';
    document.head.appendChild(link);
  }

  activity = getActivity();

  // 工具栏：三个视图切换按钮 + 操作提示
  const toolbar = document.createElement('div');
  toolbar.className = 'hm-toolbar';
  for (const v of VIEWS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hm-btn' + (v.id === view ? ' active' : '');
    btn.textContent = v.label;
    btn.dataset.view = v.id;
    btn.addEventListener('click', () => {
      view = v.id;
      toolbar.querySelectorAll('.hm-btn').forEach((b) =>
        b.classList.toggle('active', b === btn));
      render(true); // 切换视图后重新居中
    });
    toolbar.appendChild(btn);
  }
  const hint = document.createElement('span');
  hint.className = 'hm-hint';
  hint.textContent = '拖拽平移 · 滚轮缩放 · 悬停看详情';
  toolbar.appendChild(hint);
  host.appendChild(toolbar);

  // 滚动容器（overflow-x 滚动条 + 拖拽平移）
  scroller = document.createElement('div');
  scroller.className = 'hm-scroll';
  host.appendChild(scroller);

  // 提示层挂到 body，避免被容器裁剪
  tooltip = document.createElement('div');
  tooltip.className = 'hm-tooltip';
  document.body.appendChild(tooltip);

  setupDrag();
  setupZoom();
  render(true);
}

// 模块加载时自动初始化（index.html 以 type=module 引入本文件）
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
