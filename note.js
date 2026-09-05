/* note.js —— 笔记详情页（需求：PWA 笔记详情页）
 *
 * 全屏阅读单条记录（笔记/日记/日志/备忘/自定义类型通用）：
 *   ?id=<记录id> → getNoteById → note-detail 全量渲染（markdown/公式排版/图片自包含供图）
 *   「✏️ 编辑」→ type.html?t=<type>&edit=<id>（统一编辑器，保存后回跳本页）
 *   「← 返回」→ history.back()（无来源时回 type.html?t=<type>）
 *   返回顶部 FAB（需求 20260905-②）：下滑超 400px 淡入，点击平滑回顶（reduced-motion 直跳）
 */
import { getNoteById, getConceptCatalog } from './data.js';
import { renderNoteDetailInto } from './note-detail.js';
import { typesetInto } from './vendor/mathjax3/mathjax-boot.js';

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg, ms = 3000) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), ms);
}

/** 类型显示名（内置 4 类走 NoteTypes；自定义类型兜底显示 key） */
function typeLabel(key) {
  try {
    const t = window.NoteTypes && window.NoteTypes.getType(key);
    if (t) return t.label;
  } catch (e) { /* types.js 未就绪时兜底 */ }
  return key || '笔记';
}

/** 题头元信息行 */
function metaLine(n) {
  const parts = [];
  if (n.date) parts.push(esc(n.date));
  if (n.project) parts.push(`📁 ${esc(n.project)}`);
  if (n.book) parts.push(`《${esc(n.book)}》`);
  if (n.pages) parts.push(`第 ${esc(n.pages)} 页`);
  if (Array.isArray(n.tags) && n.tags.length) parts.push(n.tags.map((t) => `#${esc(t)}`).join(' '));
  return parts.join(' ｜ ');
}

/** 图片缺失诊断：渲染后对加载失败的 img 换成占位说明（含引用路径） */
function attachImageDiagnostics(container) {
  container.querySelectorAll('img.note-detail-img').forEach((img) => {
    img.addEventListener('error', () => {
      const path = img.getAttribute('data-path') || img.getAttribute('src') || '';
      const tip = document.createElement('p');
      tip.className = 'muted';
      tip.textContent = `⚠️ 图片缺失：${path}——可用「⬇ 备份 / 迁移包（含图片）」重新导入，或电脑端 cli sync 补齐`;
      img.replaceWith(tip);
    }, { once: true });
  });
}

async function load() {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    $('note-title').textContent = '缺少记录 id';
    $('note-missing').hidden = false;
    $('note-missing').textContent = '请从记录列表进入详情页（note.html?id=…）';
    return;
  }

  const note = await getNoteById(id);
  if (!note) {
    $('note-title').textContent = '没有找到这条记录';
    $('note-missing').hidden = false;
    $('note-missing').textContent = '可能尚未导入：请在记录页点「⇄ 从电脑导入」，或导入迁移包。';
    return;
  }

  document.title = `${note.title || '笔记详情'} · 读书笔记`;
  $('note-title').textContent = note.title || '未命名';
  $('note-meta').innerHTML = metaLine(note);
  const badge = $('note-type-badge');
  badge.textContent = typeLabel(note.type || 'note');
  badge.hidden = false;
  badge.style.background = '#c9a96e';

  const catalogById = {};
  try {
    const catalog = await getConceptCatalog();
    ((catalog && catalog.concepts) || []).forEach((c) => { catalogById[c.id] = c; });
  } catch (e) { /* 目录缺失时按 id 显示 */ }

  const body = $('note-body');
  await renderNoteDetailInto(body, note, catalogById);
  try { await typesetInto(body); } catch (e) { /* 公式排版失败不阻断 */ }
  attachImageDiagnostics(body);

  $('edit-btn').addEventListener('click', () => {
    location.href = `type.html?t=${encodeURIComponent(note.type || 'note')}&edit=${encodeURIComponent(note.id)}`;
  });
}

$('back-btn').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.href = 'type.html';
});

/* ── 阅读字号档位（需求 20260905-批次三：四档 popover）──
 * 选中即写 localStorage（reading-font.js 三页共用键 reading-font-size）并立即改 <html data-fs>。 */
const FS_KEY = 'reading-font-size';
const FS_LABEL = { small: '小', '': '标准', large: '大', xlarge: '特大' };

const fsBtn = $('fs-btn');
const fsPop = $('fs-pop');

function markFsSelection() {
  const current = document.documentElement.getAttribute('data-fs') || '';
  fsPop.querySelectorAll('[data-fs-pick]').forEach((b) => {
    const v = b.getAttribute('data-fs-pick');
    const mark = v === current ? '⭕' : '○';
    b.firstChild.textContent = `${mark} ${FS_LABEL[v]} `;
  });
  fsBtn.setAttribute('aria-expanded', String(!fsPop.hidden));
}

function toggleFsPop(force) {
  fsPop.hidden = typeof force === 'boolean' ? !force : !fsPop.hidden;
  markFsSelection();
}

function initFontSwitch() {
  fsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFsPop();
  });
  fsPop.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fs-pick]');
    if (!btn) return;
    const v = btn.getAttribute('data-fs-pick');
    try {
      if (v) localStorage.setItem(FS_KEY, v);
      else localStorage.removeItem(FS_KEY);
    } catch (err) { /* 存储不可用时仅本页生效 */ }
    if (v) document.documentElement.setAttribute('data-fs', v);
    else document.documentElement.removeAttribute('data-fs');
    markFsSelection();
    fsPop.hidden = true;
    // R9b：显示正文实际计算字号（设备兼容性自证——嵌套数学不支持的老内核会恒显 16px）
    let px = '';
    try { px = `（正文 ${getComputedStyle($('note-body')).fontSize}）`; } catch (e) { /* 忽略 */ }
    toast(`阅读字号：${FS_LABEL[v] || '标准'}${px}`);
    if (layout === 'spread') { spreadPage = 0; layoutSpread(); }   // 字号变了重排书页
  });
  // 点击外部关闭
  document.addEventListener('click', (e) => {
    if (!fsPop.hidden && !e.target.closest('.fs-switch')) toggleFsPop(false);
  });
  markFsSelection();
}

/* ── R7 书页模式（双页并排 + 翻页；CSS 多列分页，不拆 DOM）──
 * reading-layout ∈ 'scroll'（默认连续）| 'spread'（书页）；宽屏 2 列 / 窄屏 1 列；
 * 页宽固定，容器宽度按内容指数扩张+二分收紧求最小可容宽 → 总列数 → translateX 翻页。 */
const LS_LAYOUT = 'reading-layout';
let layout = 'scroll';
let spreadPage = 0;
let spreadPages = 1;
const viewBtn = $('view-btn');
const viewPop = $('view-pop');

function markViewSelection() {
  const current = layout;
  viewPop.querySelectorAll('[data-layout-pick]').forEach((b) => {
    const v = b.getAttribute('data-layout-pick');
    const mark = v === current ? '⭕' : '○';
    b.firstChild.textContent = mark === '⭕'
      ? (v === 'spread' ? '⭕ 📖 书页 ' : '⭕ ↕ 连续 ')
      : (v === 'spread' ? '○ 📖 书页 ' : '○ ↕ 连续 ');
  });
  viewBtn.setAttribute('aria-expanded', String(!viewPop.hidden));
}

function toggleViewPop(force) {
  viewPop.hidden = typeof force === 'boolean' ? !force : !viewPop.hidden;
  markViewSelection();
}

function visibleCols() { return window.innerWidth >= 1024 ? 2 : 1; }

/** 书页排版：定列宽/页高 → 求内容最小可容宽（指数+二分） → 总列数/页数 → 翻页位置 */
function layoutSpread() {
  const viewport = $('spread-viewport');
  const body = $('note-body');
  const gap = 48;
  const visible = visibleCols();
  const colW = Math.max(300, Math.floor((viewport.clientWidth - gap * (visible - 1)) / visible));
  const pageH = Math.max(420, window.innerHeight - 250);
  viewport.style.height = pageH + 'px';
  body.style.height = '100%';
  body.style.columnWidth = colW + 'px';
  body.style.columnGap = gap + 'px';
  body.style.columnFill = 'auto';

  let w = colW;
  body.style.width = w + 'px';
  let guard = 0;
  while (body.scrollWidth > w + 2 && guard < 40) {   // 指数扩张（log 步）
    w *= 2;
    body.style.width = w + 'px';
    guard++;
  }
  let lo = Math.max(colW, Math.floor(w / 2));
  let hi = w;
  while (hi - lo > colW && guard < 80) {             // 二分收紧到单列精度
    const mid = Math.floor((lo + hi) / 2);
    body.style.width = mid + 'px';
    if (body.scrollWidth > mid + 2) lo = mid; else hi = mid;
    guard++;
  }
  body.style.width = hi + 'px';
  const cols = Math.max(1, Math.round((hi + gap) / (colW + gap)));
  spreadPages = Math.max(1, Math.ceil(cols / visible));
  updateSpread();
}

function updateSpread() {
  const body = $('note-body');
  const viewport = $('spread-viewport');
  const gap = 48;
  const visible = visibleCols();
  const colW = Math.max(300, Math.floor((viewport.clientWidth - gap * (visible - 1)) / visible));
  const page = Math.min(spreadPage, spreadPages - 1);
  body.style.transform = `translateX(${-page * visible * (colW + gap)}px)`;
  $('spread-indicator').textContent = `第 ${page + 1}/${spreadPages} 屏`;
  $('spread-prev').disabled = page === 0;
  $('spread-next').disabled = page >= spreadPages - 1;
}

function resetSpreadStart() { spreadPage = 0; }

function applyLayout() {
  const page = document.querySelector('.note-page');
  const body = $('note-body');
  if (layout === 'spread') {
    page.classList.add('reading-spread');
    $('spread-nav').hidden = false;
    layoutSpread();
  } else {
    page.classList.remove('reading-spread');
    $('spread-nav').hidden = true;
    body.style.width = '';
    body.style.height = '';
    body.style.transform = '';
    body.style.columnWidth = '';
    body.style.columnGap = '';
    body.style.columnFill = '';
    spreadPage = 0;
  }
  markViewSelection();
}

function initViewSwitch() {
  try { layout = localStorage.getItem(LS_LAYOUT) === 'spread' ? 'spread' : 'scroll'; } catch (e) { /* 忽略 */ }
  viewBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleViewPop(); });
  viewPop.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-layout-pick]');
    if (!btn) return;
    const v = btn.getAttribute('data-layout-pick');
    layout = v === 'spread' ? 'spread' : 'scroll';
    try {
      if (layout === 'spread') localStorage.setItem(LS_LAYOUT, 'spread');
      else localStorage.removeItem(LS_LAYOUT);
    } catch (err) { /* 存储不可用仅本页生效 */ }
    viewPop.hidden = true;
    applyLayout();
    toast(layout === 'spread' ? '视图：📖 书页（双页翻页）' : '视图：↕ 连续');
  });
  document.addEventListener('click', (e) => {
    if (!viewPop.hidden && !e.target.closest('.fs-switch')) toggleViewPop(false);
  });
  $('spread-prev').addEventListener('click', () => { spreadPage = Math.max(0, spreadPage - 1); updateSpread(); });
  $('spread-next').addEventListener('click', () => { spreadPage = Math.min(spreadPages - 1, spreadPage + 1); updateSpread(); });
  document.addEventListener('keydown', (e) => {
    if (layout !== 'spread') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'ArrowLeft') { spreadPage = Math.max(0, spreadPage - 1); updateSpread(); }
    else if (e.key === 'ArrowRight') { spreadPage = Math.min(spreadPages - 1, spreadPage + 1); updateSpread(); }
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (layout !== 'spread') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resetSpreadStart(); layoutSpread(); }, 200);
  });
  // 图片异步加载会改变内容高度 → 重排
  $('note-body').addEventListener('load', () => {
    if (layout === 'spread') layoutSpread();
  }, true);   // 捕获阶段监听 img load（不冒泡）
  markViewSelection();
}

/* ── 返回顶部 FAB（需求 20260905-②：长文下拉后快速回顶） ──
 * 下滑超 400px 淡入，回顶后消失；prefers-reduced-motion 时直跳不滚动。 */
const backTopBtn = $('back-top-btn');
const BACK_TOP_THRESHOLD = 400;

function updateBackTop() {
  backTopBtn.classList.toggle('show', (window.scrollY || 0) > BACK_TOP_THRESHOLD);
}

backTopBtn.addEventListener('click', () => {
  const reduce = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
});

window.addEventListener('scroll', updateBackTop, { passive: true });
updateBackTop();

initFontSwitch();
initViewSwitch();

load().then(() => {
  // 内容渲染/公式排版完成后，书页模式才可准确测量分页
  if (layout === 'spread') layoutSpread();
});