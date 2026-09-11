/* data-actions.js —— 数据管理共享模块（20260911 需求「数据管理入口回归修复」）
 *
 * 背景：⑦ 导航整合后数据管理按钮仍留在 type.html，而导航与旧 URL 都不再指向它 → 入口丢失。
 * 本模块把「导入 / 备份迁移包 / 导出生成 / 管理类型 / 整理标签」的实现与面板 DOM 收拢一处，
 * 由页面挂载（mountDataActions），目录页与记录页共用同一套逻辑，避免再次漂移。
 *
 * 用法：import { mountDataActions } from './data-actions.js';
 *       const dataActions = mountDataActions({ onChange, getCurrentType });
 * 宿主页面提供 <button id="data-btn">（自动绑定打开数据面板）与可选 <p id="import-status">。
 */
import {
  getAllNotes, getAllBooks, getConceptCatalog, exportNotePackage,
  diffNotePackage, mergeNotePackage, getAllTags, renameTag, deleteTag,
} from './data.js';
import {
  filterNotesByScope, scopeLabel, buildPrintHtml, buildMarkdownDraft,
} from './print-export.js';

const PANELS_HTML = `
    <div id="tag-manage" class="type-manage" hidden>
      <h2>整理标签</h2>
      <p class="muted">重命名会把旧标签合并到新标签；删除会从所有本地记录移除。</p>
      <div id="tag-list"></div>
      <button class="btn ghost" id="tag-manage-close" type="button">关闭</button>
    </div>

    <!-- 类型管理面板 -->
    <div id="type-manage" class="type-manage" hidden>
      <h2>管理记录类型</h2>
      <div id="type-list"></div>
      <form id="type-add-form" class="type-add-form">
        <h3>新增自定义类型</h3>
        <label class="field">key（标识，小写字母/数字/连字符）
          <input id="t-key" type="text" placeholder="如：idea">
        </label>
        <label class="field">显示名
          <input id="t-label" type="text" placeholder="如：灵感">
        </label>
        <label class="field">图标（emoji）
          <input id="t-icon" type="text" placeholder="如：💡">
        </label>
        <div class="field">
          <span>附加字段</span>
          <div id="t-fields"></div>
        </div>
        <button class="btn primary" type="submit">添加</button>
        <button class="btn ghost" id="type-manage-close" type="button">关闭</button>
      </form>
    </div>

    <!-- 备份 / 迁移包面板（范围 + 含图片；纯 PWA 互传 / 回传电脑 / 备份） -->
    <div id="backup-panel" class="type-manage" hidden>
      <h2>备份 / 迁移包</h2>
      <p class="muted">导出本机数据为笔记包 JSON，三种用法：<b>① 纯 PWA 多端互传</b>（另一台设备「导入 JSON」即可，勾选含图片则照片随包迁移）；<b>② 回传电脑</b>（CLI <code>import-json</code> 写入 md 体系）；<b>③ 本地备份</b>。</p>
      <div class="export-scope">
        <label class="export-opt"><input type="radio" name="backup-scope" value="all" checked><span>全部记录</span></label>
        <label class="export-opt"><input type="radio" name="backup-scope" value="book"><span>某本书</span>
          <select id="backup-book"></select></label>
        <label class="export-opt"><input type="radio" name="backup-scope" value="type"><span>某类型</span>
          <select id="backup-type"></select></label>
        <label class="export-opt"><input type="radio" name="backup-scope" value="date"><span>日期区间</span>
          <input type="date" id="backup-from"><span class="muted">～</span><input type="date" id="backup-to"></label>
        <label class="export-opt"><input type="checkbox" id="backup-images" checked><span>☑ 含图片（默认开；图片随包迁移，换机/离线均可显示）</span></label>
      </div>
      <p class="muted" id="backup-stats"></p>
      <div class="editor-actions">
        <button class="btn primary" id="backup-export-btn" type="button">⬇ 导出笔记包</button>
        <button class="btn ghost" id="backup-close" type="button">关闭</button>
      </div>
    </div>

    <!-- 导出/生成面板（打印草稿 / 下载书稿 md） -->
    <div id="export-panel" class="type-manage" hidden>
      <h2>导出 / 生成</h2>
      <p class="muted">选择范围后生成：打印草稿在浏览器打印窗口另存为 PDF；书稿为 markdown 文本下载。</p>

      <div class="export-scope">
        <label class="export-opt">
          <input type="radio" name="export-scope" value="all" checked>
          <span>全部记录</span>
        </label>
        <label class="export-opt">
          <input type="radio" name="export-scope" value="book">
          <span>某本书</span>
          <select id="export-book"></select>
        </label>
        <label class="export-opt">
          <input type="radio" name="export-scope" value="type">
          <span>某类型</span>
          <select id="export-type"></select>
        </label>
        <label class="export-opt">
          <input type="radio" name="export-scope" value="date">
          <span>日期区间</span>
          <input type="date" id="export-from">
          <span class="muted">～</span>
          <input type="date" id="export-to">
        </label>
      </div>

      <div class="export-actions">
        <button class="btn primary" id="export-print-btn" type="button">🖨 打印草稿</button>
        <button class="btn ghost" id="export-md-btn" type="button">⬇ 下载书稿（md）</button>
        <button class="btn ghost" id="export-close" type="button">关闭</button>
      </div>
    </div>

    <!-- 导入对比面板 -->
    <div id="import-panel" class="type-manage" hidden>
      <h2>导入前对比</h2>
      <p class="muted" id="import-diff-text">正在计算差异…</p>
      <div id="import-strategy" class="import-strategy">
        <label class="strategy"><input type="radio" name="import-strategy" value="merge" checked> 智能合并<span class="muted">（新增 + 包内较新覆盖，本端较新的保留）</span></label>
        <label class="strategy"><input type="radio" name="import-strategy" value="new"> 仅新增<span class="muted">（不覆盖任何现有记录）</span></label>
        <label class="strategy"><input type="radio" name="import-strategy" value="replace"> 完整替换<span class="muted">（以导入包为准清空重建）</span></label>
      </div>
      <p class="muted">导入前会自动下载一份当前数据的备份文件。</p>
      <div class="strategy-actions">
        <button class="btn primary" id="import-confirm" type="button">确认导入</button>
        <button class="btn ghost" id="import-cancel" type="button">取消</button>
      </div>
    </div>

    <!-- 数据中枢（⚙️ 数据）：聚合数据管理入口（20260911 回归修复） -->
    <div id="data-hub" class="type-manage" hidden>
      <h2>⚙️ 数据</h2>
      <p class="muted">导入 / 备份 / 导出与整理入口集中在此；个人数据只在本机与你的设备间流转。</p>
      <div class="data-hub-actions">
        <button class="btn primary" id="data-sync" type="button">⇄ 从服务器导入</button>
        <button class="btn ghost" id="data-import" type="button">📥 导入文件</button>
        <button class="btn ghost" id="data-backup" type="button">⬇ 备份 / 迁移包</button>
        <button class="btn ghost" id="data-export" type="button">🖨 导出 / 生成</button>
        <button class="btn ghost" id="data-types" type="button">🗂 管理类型</button>
        <button class="btn ghost" id="data-tags" type="button">🏷 整理标签</button>
      </div>
      <p class="muted" id="data-hub-status"></p>
      <div class="editor-actions">
        <button class="btn ghost" id="data-close" type="button">关闭</button>
      </div>
    </div>

    <input type="file" id="import-file" accept=".json,application/json" hidden>
`;

const FIELD_KEYS = ['book', 'pages', 'done', 'due'];

let host = {};
let conceptCatalog = [];
let toastTimer = null;

const DQ = String.fromCharCode(34);
const SQ = String.fromCharCode(39);
const $ = (id) => document.getElementById(id);
const els = {};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(new RegExp(DQ, 'g'), '&quot;').replace(new RegExp(SQ, 'g'), '&#39;');
}

function toast(msg, ms = 3000) {
  const el = $('toast');
  if (!el) { console.log('[data-actions]', msg); return; }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function todayStr() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function renderTypeManager() {
  const rows = NoteTypes.getTypes(false).map((t) => {
    const tag = t.builtin
      ? '<span class="tag">内置</span>'
      : `<button class="btn ghost small danger" data-rm="${esc(t.key)}">删除</button>`;
    return `<div class="type-row">
        <span class="type-icon">${esc(t.icon)}</span>
        <span class="type-label">${esc(t.label)} <code>${esc(t.key)}</code></span>
        <span class="type-fields">${(t.fields || []).map(esc).join(' / ') || '—'}</span>
        ${tag}
      </div>`;
  }).join('');
  els.typeList.innerHTML = rows || '<p class="empty">暂无类型</p>';

  // 附加字段复选（新增表单）
  els.tFields.innerHTML = FIELD_KEYS.map((f) => {
    const m = NoteTypes.fieldMeta(f);
    return `<label class="chk"><input type="checkbox" value="${f}" checked> ${esc(m.label)}</label>`;
  }).join('');
}

function openManager() {
  renderTypeManager();
  els.manage.hidden = false;
}

/* ── 标签整理面板 ── */
async function renderTagManager() {
  const tags = await getAllTags();
  if (!tags.length) {
    els.tagList.innerHTML = '<p class="empty">暂无标签</p>';
    return;
  }
  els.tagList.innerHTML = tags.map((t) => `
    <div class="tag-row" data-tag="${esc(t.tag)}">
      <input class="tag-rename" value="${esc(t.tag)}" aria-label="重命名标签">
      <span class="tag-count">${t.count} 条</span>
      <button class="btn ghost small" data-act="rename" type="button">重命名</button>
      <button class="btn ghost small danger" data-act="delete" type="button">删除</button>
    </div>`).join('');
}

async function openTagManager() {
  await renderTagManager();
  els.tagManage.hidden = false;
}

/* ── 导入 / 导出 / 同步 ── */

/* ── 导入 / 导出 / 同步（含差异对比与策略选择）────────── */

/** 当前待确认的导入包（对话框打开期间缓存） */
let pendingImport = null;

function fmtCount(n) {
  return n == null || n === 0 ? 0 : n;
}

/** 下载当前本地数据备份（导入前自动执行） */
async function downloadBackup(prefix = '读书笔记-导入前备份') {
  const pkg = await exportNotePackage();
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${prefix}-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * 打开导入对比对话框：先 diff，展示统计与策略，确认后执行。
 * @param {object} pkg 导入包
 * @param {string} source 来源描述（从电脑导入 / 导入文件）
 */
let importSource = '';

async function openImportDialog(pkg, source) {
  importSource = source;
  const diff = await diffNotePackage(pkg);
  pendingImport = { pkg, diff };
  const list = Array.isArray(pkg.notes) ? pkg.notes : [];
  const at = pkg.exportedAt ? `（导出时间 ${String(pkg.exportedAt).slice(0, 16).replace('T', ' ')}）` : '';
  const stats = summarizePackage(pkg);   // 标签/概念规模（需求 20260905-批次一 F1）
  const catLine = (pkg && pkg.conceptCatalog && Array.isArray(pkg.conceptCatalog.concepts))
    ? `包内概念目录：${(pkg.conceptCatalog.domains || []).length} 域 · ${pkg.conceptCatalog.concepts.length} 概念（导入将增量并入本机，不动服务器）`
    : '';
  els.importDiffText.textContent =
    `来源：${source}，包内 ${list.length} 条${at}\n` +
    `新增 ${fmtCount(diff.added.length)} ｜ 更新 ${fmtCount(diff.updated.length)} ｜ ` +
    `本端更新 ${fmtCount(diff.localNewer.length)} ｜ 不变 ${fmtCount(diff.unchanged)} ｜ 本端独有 ${fmtCount(diff.localOnly)}\n` +
    `标签：${stats.tagRecords} 条记录 · ${stats.tagKinds} 个 ｜ 概念：${stats.conceptRecords} 条记录 · ${stats.conceptKinds} 个` +
    (catLine ? `\n${catLine}` : '');
  els.importPanel.hidden = false;
}

function closeImportDialog() {
  els.importPanel.hidden = true;
  pendingImport = null;
}

/**
 * 从电脑导入：拉取服务器上的 export.json（由 `cli sync` 生成），
 * 弹出差异对比对话框（可合并/仅新增/完整替换），确认后执行。
 * fetch 用 no-store 并依赖 SW 对 export.json 的 network-first，避免旧缓存。
 */
async function syncFromCli() {
  const resp = await fetch('./export.json', { cache: 'no-store' });
  if (!resp.ok) {
    throw new Error(`服务器上没有 export.json（HTTP ${resp.status}）——先在 CLI 运行「sync」命令生成`);
  }
  const pkg = await resp.json();
  const list = Array.isArray(pkg.notes) ? pkg.notes : [];
  if (!list.length) throw new Error('导出包为空');
  await openImportDialog(pkg, '从电脑导入');
}

async function doImport(file) {
  try {
    const json = JSON.parse(await file.text());
    const list = Array.isArray(json) ? json : (json && Array.isArray(json.notes) ? json.notes : []);
    if (!list.length) throw new Error('导入包为空');
    await openImportDialog(json, '导入文件');
  } catch (e) {
    toast(`导入失败：${e.message}`);
  }
}

/** 确认导入：备份 → 按所选策略应用 → 刷新 */
async function confirmImport() {
  if (!pendingImport) return;
  const { pkg, diff } = pendingImport;
  const strategy = document.querySelector('input[name="import-strategy"]:checked')?.value || 'merge';
  try {
    await downloadBackup();  // 导入前自动备份
    const { applied, catalogAdded, catalogDomainsAdded, catalogTotal } = await mergeNotePackage(pkg, strategy);
    await host.onChange?.();
    const kept = strategy === 'merge' ? `，保留本端更新 ${fmtCount(diff.localNewer.length)} 条` : '';
    const cat = catalogTotal > 0
      ? `｜ 概念目录：${(catalogAdded || catalogDomainsAdded)
        ? `并入 ${catalogAdded} 概念 / ${catalogDomainsAdded} 域（已存本机）`
        : '本端已齐，无新增'}`
      : '';
    const label = strategy === 'replace' ? '替换' : strategy === 'new' ? '仅新增' : '合并';
    toast(`已${label}导入 ${applied} 条${kept}${cat}`);
    if (els.importStatus) {
      els.importStatus.textContent = `✅ 已${label}导入 ${applied} 条${kept}${cat} ｜ 来源：${importSource}`;
      els.importStatus.hidden = false;
    }
  } catch (e) {
    toast(`导入失败：${e.message}`, 4200);
  } finally {
    closeImportDialog();
  }
}

/* ── 备份 / 迁移包（需求：PWA 图片自包含与同步语义）────────────── */

/** 打开面板：填充书/类型下拉与统计行 */
async function openBackupPanel() {
  const books = await getAllBooks();
  els.backupBook.innerHTML = '<option value="">（选择书）</option>' +
    books.map((b) => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join('');
  els.backupType.innerHTML = NoteTypes.getTypes(false)
    .map((t) => `<option value="${esc(t.key)}">${t.icon} ${esc(t.label)}</option>`).join('');
  const cur = host.getCurrentType?.(); if (cur) els.backupType.value = cur.key;
  els.backupPanel.hidden = false;
  await refreshBackupStats();
}

function readBackupScope() {
  const scope = document.querySelector('input[name="backup-scope"]:checked')?.value || 'all';
  return {
    scope,
    book: els.backupBook.value || '',
    type: els.backupType.value || '',
    dateFrom: els.backupFrom.value || '',
    dateTo: els.backupTo.value || '',
    label: scope === 'book' ? (els.backupBook.selectedOptions[0]?.textContent || '某本书')
      : scope === 'type' ? (NoteTypes.getType(els.backupType.value)?.label || '某类型')
      : scope === 'date' ? scopeLabel('date', { dateFrom: els.backupFrom.value, dateTo: els.backupTo.value })
      : '全部',
  };
}

/** 统计行：N 条记录 · M 张图片（范围内引用去重） */
async function refreshBackupStats() {
  const scope = readBackupScope();
  const all = await getAllNotes();
  const list = filterNotesByScope(all, scope);
  const imgCount = new Set();
  for (const n of list) for (const img of (n.images || [])) imgCount.add(String(img));
  const withImg = list.filter((n) => (n.images && n.images.length) || n.imageData).length;
  els.backupStats.textContent = `共 ${list.length} 条记录 ｜ ${imgCount.size} 张引用图片（${withImg} 条带图）`
    + (els.backupImages.checked ? ' ｜ ☑ 含图片' : ' ｜ 不含图片');
}

/** 导出迁移包：范围过滤 → exportNotePackage({notes, includeImages}) → 下载 */
async function doBackupExport() {
  try {
    const scope = readBackupScope();
    const all = await getAllNotes();
    const list = filterNotesByScope(all, scope);
    if (!list.length) { toast('范围内没有记录，无法导出'); return; }
    const includeImages = els.backupImages.checked;
    els.backupExportBtn.disabled = true;
    els.backupExportBtn.textContent = '打包中…';
    const pkg = await exportNotePackage({ notes: list, includeImages });
    const nImg = pkg.imageFiles ? Object.keys(pkg.imageFiles).length : 0;
    const fileLabel = String(scope.label).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-');
    const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `读书笔记-迁移包-${fileLabel}-${todayStr().replace(/-/g, '')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    els.backupPanel.hidden = true;
    toast(`已导出迁移包：${list.length} 条${includeImages ? `（含图片 ${nImg} 张）` : ''}`);
  } catch (e) {
    toast(`导出失败：${e.message}`, 4200);
  } finally {
    els.backupExportBtn.disabled = false;
    els.backupExportBtn.textContent = '⬇ 导出笔记包';
  }
}

/* ── 导出 / 生成（打印草稿 / 下载书稿 md）────────────── */

/** 概念目录转 catalogById（renderNoteDetail 用 id → 名称映射） */
function catalogByIdMap() {
  const map = {};
  conceptCatalog.forEach((c) => { map[c.id] = c; });
  return map;
}

/** 填充导出面板的书 / 类型下拉（打开时刷新） */
async function renderExportSelects() {
  const books = await getAllBooks();
  els.exportBook.innerHTML = '<option value="">（选择书）</option>' +
    books.map((b) => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join('');
  els.exportType.innerHTML = NoteTypes.getTypes(false)
    .map((t) => `<option value="${esc(t.key)}">${t.icon} ${esc(t.label)}</option>`).join('');
  const cur2 = host.getCurrentType?.(); if (cur2) els.exportType.value = cur2.key;
}

/** 读取当前选择的导出范围配置 */
function readExportScope() {
  const scope = document.querySelector('input[name="export-scope"]:checked')?.value || 'all';
  const book = els.exportBook.value || '';
  const type = els.exportType.value || '';
  const dateFrom = els.exportFrom.value || '';
  const dateTo = els.exportTo.value || '';
  let label = '全部';
  if (scope === 'book') {
    label = els.exportBook.selectedOptions[0]?.textContent || book;
  } else if (scope === 'type') {
    label = NoteTypes.getType(type)?.label || type;
  } else if (scope === 'date') {
    label = scopeLabel('date', { dateFrom, dateTo });
  }
  return { scope, book, type, dateFrom, dateTo, label };
}

/** 把打印 HTML 写入隐藏 iframe 并触发打印（避免弹窗拦截）；打印关闭后移除 */
function printHtmlFrame(html) {
  const frame = document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.right = '0';
  frame.style.bottom = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  document.body.appendChild(frame);
  const doc = frame.contentDocument || frame.contentWindow.document;
  doc.open();
  doc.write(html);
  // 注入 base 指向当前页面，让详情里的相对图片（assets/…）按 app/pwa/ 解析
  const base = doc.createElement('base');
  base.href = location.href;
  if (doc.head) doc.head.appendChild(base);
  doc.close();
  // 给样式/图片一点渲染时间；部分浏览器 print() 会阻塞到打印对话框关闭
  setTimeout(() => {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch (e) {
      toast(`打印失败：${e.message}`, 4200);
    }
    frame.remove();
  }, 200);
}

/** 打印草稿：按范围取数 → 组装可打印 HTML → 打印窗口（浏览器另存 PDF） */
async function doPrintDraft() {
  const scope = readExportScope();
  const all = await getAllNotes();
  const list = filterNotesByScope(all, scope);
  if (!list.length) {
    toast('范围内没有记录，无法生成打印草稿');
    return;
  }
  const title = `读书笔记 · ${scopeLabel(scope.scope, { label: scope.label, dateFrom: scope.dateFrom, dateTo: scope.dateTo })}`;
  const html = buildPrintHtml(list, title, catalogByIdMap());
  printHtmlFrame(html);
  els.exportPanel.hidden = true;
  toast('已打开打印窗口，可在打印对话框选择「另存为 PDF」');
}

/** 下载书稿（md）：按范围拼 markdown，文件名 书稿-<范围描述>-YYYYMMDD.md */
async function doDownloadMd() {
  const scope = readExportScope();
  const all = await getAllNotes();
  const list = filterNotesByScope(all, scope);
  if (!list.length) {
    toast('范围内没有记录，无法下载书稿');
    return;
  }
  const title = `读书笔记 · ${scopeLabel(scope.scope, { label: scope.label, dateFrom: scope.dateFrom, dateTo: scope.dateTo })}`;
  const md = buildMarkdownDraft(list, title);
  const fileLabel = String(scope.label).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-');
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `书稿-${fileLabel}-${todayStr().replace(/-/g, '')}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
  els.exportPanel.hidden = true;
  toast('已下载书稿 markdown');
}


/* ── 数据中枢与绑定 ── */

function openHub() {
  els.hub.hidden = false;
}

function bind() {
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  on('data-sync', () => { els.hub.hidden = true; syncFromCli().catch((e) => toast('同步失败：' + e.message, 4200)); });
  on('data-import', () => els.importFile.click());
  on('data-backup', () => { els.hub.hidden = true; openBackupPanel(); });
  on('data-export', () => { els.hub.hidden = true; renderExportSelects().then(() => { els.exportPanel.hidden = false; }); });
  on('data-types', () => { els.hub.hidden = true; openManager(); });
  on('data-tags', () => { els.hub.hidden = true; openTagManager(); });
  on('data-close', () => { els.hub.hidden = true; });
  on('import-confirm', confirmImport);
  on('import-cancel', closeImportDialog);
  on('export-print-btn', doPrintDraft);
  on('export-md-btn', doDownloadMd);
  on('export-close', () => { els.exportPanel.hidden = true; });
  on('backup-export-btn', doBackupExport);
  on('backup-close', () => { els.backupPanel.hidden = true; });
  on('type-manage-close', () => { els.manage.hidden = true; });
  on('tag-manage-close', () => { els.tagManage.hidden = true; });
  const fileEl = $('import-file');
  if (fileEl) fileEl.addEventListener('change', () => {
    if (fileEl.files[0]) doImport(fileEl.files[0]);
    fileEl.value = '';
  });
  ['backup-book', 'backup-type', 'backup-from', 'backup-to'].forEach((id) => {
    const el = $(id); if (el) el.addEventListener('change', refreshBackupStats);
  });
  const imgChk = $('backup-images');
  if (imgChk) imgChk.addEventListener('change', refreshBackupStats);
  // 类型管理：新增自定义类型 / 删除自定义类型（20260911 迁入）
  const typeForm = $('type-add-form');
  if (typeForm) typeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const fields = [...els.tFields.querySelectorAll('input:checked')].map((i) => i.value);
    try {
      const t = NoteTypes.addType({ key: els.tKey.value, label: els.tLabel.value, icon: els.tIcon.value, fields });
      toast('已添加类型「' + t.label + '」');
      els.tKey.value = ''; els.tLabel.value = ''; els.tIcon.value = '';
      renderTypeManager();
      host.onTypesChanged?.();
    } catch (err) {
      toast(err.message, 4200);
    }
  });
  const typeListEl = $('type-list');
  if (typeListEl) typeListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-rm]');
    if (!btn) return;
    const key = btn.dataset.rm;
    if (!confirm('删除自定义类型「' + key + '」？已有该类型的记录将不再出现在导航中（数据保留）。')) return;
    NoteTypes.removeType(key);
    renderTypeManager();
    host.onTypesChanged?.();
  });
  // 标签整理：重命名/合并、删除（20260911 迁入）
  const tagListEl = $('tag-list');
  if (tagListEl) tagListEl.addEventListener('click', async (e) => {
    const row = e.target.closest('.tag-row');
    const btn = e.target.closest('[data-act]');
    if (!row || !btn) return;
    const oldTag = row.dataset.tag;
    const input = row.querySelector('.tag-rename');
    if (btn.dataset.act === 'rename') {
      const newTag = (input.value || '').trim();
      if (!newTag) { toast('新标签不能为空'); return; }
      try {
        const n = await renameTag(oldTag, newTag);
        await renderTagManager();
        await host.onChange?.();
        toast('已重命名/合并 ' + n + ' 条记录到「' + newTag + '」');
      } catch (err) {
        toast('重命名失败：' + err.message, 4200);
      }
    } else if (btn.dataset.act === 'delete') {
      if (!confirm('从所有本地记录中删除标签「' + oldTag + '」？')) return;
      const n = await deleteTag(oldTag);
      await renderTagManager();
      await host.onChange?.();
      toast('已从 ' + n + ' 条记录删除「' + oldTag + '」');
    }
  });

}

/** 挂载：注入面板 DOM、建立 els、绑定事件；返回 API */
export function mountDataActions(hostCtx = {}) {
  host = hostCtx || {};
  if (!$('data-hub')) {
    const wrap = document.createElement('div');
    wrap.innerHTML = PANELS_HTML;
    while (wrap.firstChild) document.body.appendChild(wrap.firstChild);
  }
  Object.assign(els, {
    hub: $('data-hub'),
    importPanel: $('import-panel'),
    importStatus: $('import-status'),
    importFile: $('import-file'),
    importDiffText: $('import-diff-text'),
    backupPanel: $('backup-panel'),
    backupBook: $('backup-book'),
    backupType: $('backup-type'),
    backupFrom: $('backup-from'),
    backupTo: $('backup-to'),
    backupImages: $('backup-images'),
    backupStats: $('backup-stats'),
    backupExportBtn: $('backup-export-btn'),
    exportPanel: $('export-panel'),
    exportBook: $('export-book'),
    exportType: $('export-type'),
    exportFrom: $('export-from'),
    exportTo: $('export-to'),
    exportClose: $('export-close'),
    manage: $('type-manage'),
    typeList: $('type-list'),
    typeAddForm: $('type-add-form'),
    tKey: $('t-key'),
    tLabel: $('t-label'),
    tIcon: $('t-icon'),
    tFields: $('t-fields'),
    tagManage: $('tag-manage'),
    tagList: $('tag-list'),
  });
  bind();
  getConceptCatalog().then((cat) => { conceptCatalog = (cat && cat.concepts) || []; }).catch(() => {});
  const btn = $('data-btn');
  if (btn) btn.addEventListener('click', openHub);
  return { openHub, syncFromCli, openBackupPanel, openTagManager, openManager,
           openImportDialog, confirmImport, renderExportSelects, doPrintDraft, doDownloadMd };
}

export default { mountDataActions };
