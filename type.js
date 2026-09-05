/**
 * type.js —— 统一记录页逻辑（B 阶段：类型注册表驱动）
 *
 * 单一页面 type.html?t=<key> 处理所有记录类型：
 *   - 列表：按当前类型过滤展示（icon + 类型标签 + 特有字段）
 *   - 编辑器：字段随类型 fields 动态增减（book/pages/done/due…）
 *   - 类型管理：内置类型 + 自定义类型增删（导航随之更新）
 *
 * 记录统一模型（见 data.js normalizeNote）：
 *   { id, type, title, date, content, readerNote, aiNote, imageData, meta, … }
 */
import {
  getAllNotes,
  addNote,
  deleteNote,
  importNotePackage,
  exportNotePackage,
  diffNotePackage,
  mergeNotePackage,
  summarizePackage,
  getAllTags,
  renameTag,
  deleteTag,
  getAllProjects,
} from './data.js';
import { renderNoteDetailInto } from './note-detail.js';
import { filterNotesByScope, buildPrintHtml, buildMarkdownDraft, scopeLabel } from './print-export.js';
import { BUTTONS, wrapSelection, renderPreview } from './md-toolbar.js';
import { typesetInto } from './vendor/mathjax3/mathjax-boot.js';

const $ = (id) => document.getElementById(id);

/* 可用附加字段（与 types.js FIELD_META 对应） */
const FIELD_KEYS = ['book', 'pages', 'done', 'due'];

const els = {
  nav: $('main-nav'),
  typeTitle: $('type-title'),
  typeHint: $('type-hint'),
  count: $('record-count'),
  searchInput: $('search-input'),
  list: $('record-list'),
  empty: $('empty-state'),
  emptyTitle: $('empty-title'),
  emptyHint: $('empty-hint'),
  editor: $('editor'),
  editorTitle: $('editor-title'),
  newBtn: $('new-btn'),
  emptyNewBtn: $('empty-new-btn'),
  manageBtn: $('manage-btn'),
  manage: $('type-manage'),
  tagManageBtn: $('tag-manage-btn'),
  tagManage: $('tag-manage'),
  tagList: $('tag-list'),
  tagManageClose: $('tag-manage-close'),
  typeList: $('type-list'),
  typeAddForm: $('type-add-form'),
  tKey: $('t-key'),
  tLabel: $('t-label'),
  tIcon: $('t-icon'),
  tFields: $('t-fields'),
  manageClose: $('type-manage-close'),
  exportBtn: $('export-btn'),
  backupPanel: $('backup-panel'),
  backupBook: $('backup-book'),
  backupType: $('backup-type'),
  backupFrom: $('backup-from'),
  backupTo: $('backup-to'),
  backupImages: $('backup-images'),
  backupStats: $('backup-stats'),
  backupExportBtn: $('backup-export-btn'),
  backupClose: $('backup-close'),
  exportPdfBtn: $('export-pdf-btn'),
  exportPanel: $('export-panel'),
  exportBook: $('export-book'),
  exportType: $('export-type'),
  exportFrom: $('export-from'),
  exportTo: $('export-to'),
  exportPrintBtn: $('export-print-btn'),
  exportMdBtn: $('export-md-btn'),
  exportClose: $('export-close'),
  importBtn: $('import-btn'),
  importFile: $('import-file'),
  syncBtn: $('sync-btn'),
  importPanel: $('import-panel'),
  importDiffText: $('import-diff-text'),
  importConfirm: $('import-confirm'),
  importCancel: $('import-cancel'),
  photoInput: $('photo-input'),
  photoBtn: $('photo-btn'),
  photoPreview: $('photo-preview'),
  typeFields: $('type-fields'),
  fDate: $('f-date'),
  fTags: $('f-tags'),
  fTitle: $('f-title'),
  fContent: $('f-content'),
  fProject: $('f-project'),
  projectList: $('project-list'),
  filterBar: $('filter-bar'),
  filterProject: $('filter-project'),
  filterBook: $('filter-book'),
  filterFrom: $('filter-from'),
  filterTo: $('filter-to'),
  mdToolbar: $('md-toolbar'),
  mdPreview: $('md-preview'),
  mdPreviewToggle: $('md-preview-toggle'),
  fReader: $('f-reader'),
  fAi: $('f-ai'),
  askAiBtn: $('ask-ai-btn'),
  conceptField: $('concept-field'),
  conceptSelect: $('concept-select'),
  saveBtn: $('save-btn'),
  cancelBtn: $('cancel-btn'),
  toast: $('toast'),
};

/* ── 状态 ── */
let currentType = null;      // 当前记录类型（NoteTypes 条目）
let editingId = null;        // 正在编辑的记录 id（null = 新建）
let photoData = '';          // 压缩 base64
let notesCache = [];         // 当前类型列表缓存
let searchQuery = '';        // 搜索框当前关键词（空 = 显示全量）
let listFilters = { project: '', book: '', dateFrom: '', dateTo: '' };  // 筛选栏状态（与搜索 AND 叠加）
let toastTimer = null;
let conceptCatalog = [];     // graph.json 概念目录 [{id,name,domain}]
let conceptDomainNames = {}; // domain_id -> domain_name
let selectedConcepts = new Map(); // concept_id -> source（保存时保留原 source，新选默认 user）

/* ── 工具 ── */
function toast(msg, ms = 2600) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function summary(text, len = 80) {
  const t = (text || '').trim().replace(/\s+/g, ' ');
  return t.length > len ? `${t.slice(0, len)}…` : t;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 从输入框解析标签：兼容中英文逗号/顿号/空格，去空白、去重、过滤图片路径噪音 */
function parseTagsInput(value) {
  const raw = String(value || '')
    .split(/[,，、;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    if (/(^|[\\/])assets[\\/]/i.test(t) || /\.(jpe?g|png|gif|webp|bmp|svg|avif)$/i.test(t) || /^img_\w+\.\w+$/i.test(t)) {
      continue;
    }
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function compressImage(file, maxW = 900) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => reject(new Error('图片解析失败'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

/* ── 导航与标题 ── */
function renderHeader() {
  els.nav.innerHTML = NoteTypes.renderNav(currentType.key);
  els.typeTitle.textContent = `${currentType.icon} ${currentType.label}`;
  els.typeHint.textContent = currentType.hint || '';
}

/* ── 概念标签选择器（从 graph.json 读取概念目录） ── */

async function loadConceptCatalog() {
  try {
    const resp = await fetch('graph.json', { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    conceptCatalog = (data.concepts || []).map((c) => ({
      id: String(c.id || ''),
      name: String(c.name || c.id || ''),
      domain: String(c.domain || ''),
    })).filter((c) => c.id);
    conceptDomainNames = {};
    (data.domains || []).forEach((d) => {
      conceptDomainNames[String(d.id || '')] = String(d.name || d.id || '');
    });
  } catch (err) {
    console.warn('[type] 加载 graph.json 概念目录失败:', err);
    conceptCatalog = [];
    conceptDomainNames = {};
  }
  if (!els.editor.hidden) renderConceptSelector();
  if (typeof applySearch === 'function') applySearch();  // 重新渲染卡片，显示概念名称而非 id
}

function renderConceptSelector() {
  const show = currentType.key === 'note' || currentType.key === 'diary';
  els.conceptField.hidden = !show;
  if (!show) return;
  if (!conceptCatalog.length) {
    els.conceptSelect.innerHTML = '<p class="muted">未找到 graph.json 概念目录，请先在 CLI 运行 <code>graph build</code> 并复制到 app/pwa/。</p>';
    return;
  }
  const byDomain = new Map();
  for (const c of conceptCatalog) {
    const arr = byDomain.get(c.domain) || [];
    arr.push(c);
    byDomain.set(c.domain, arr);
  }
  els.conceptSelect.innerHTML = [...byDomain.entries()].map(([domain, list]) => {
    const dname = conceptDomainNames[domain] || domain || '未归域';
    const items = list.map((c) => {
      const checked = selectedConcepts.has(c.id) ? ' checked' : '';
      const src = selectedConcepts.get(c.id);
      const srcTag = src && src !== 'user' ? ` <span class="tag">${esc(src)}</span>` : '';
      return `<label class="concept-option"><input type="checkbox" data-concept="${esc(c.id)}"${checked}> ${esc(c.name)}${srcTag}</label>`;
    }).join('');
    return `<div class="concept-group"><div class="concept-group-name">${esc(dname)}</div><div class="concept-options">${items}</div></div>`;
  }).join('');
  els.conceptSelect.querySelectorAll('input[data-concept]').forEach((input) => {
    input.addEventListener('change', () => {
      const id = input.dataset.concept;
      if (input.checked) {
        if (!selectedConcepts.has(id)) selectedConcepts.set(id, 'user');
      } else {
        selectedConcepts.delete(id);
      }
    });
  });
}

/* ── 列表渲染 ── */
function fieldChips(rec) {
  const chips = [];
  if (rec.book) chips.push(esc(rec.book));
  if (rec.pages) chips.push(`页 ${esc(rec.pages)}`);
  const meta = rec.meta || {};
  if (meta.due) chips.push(`截止 ${esc(meta.due)}`);
  return chips;
}

function renderList(notes) {
  els.list.innerHTML = '';
  for (const n of notes) {
    const card = document.createElement('article');
    card.className = 'note-card' + ((n.meta && n.meta.done) ? ' done' : '');

    const thumb = n.imageData
      ? `<img class="note-thumb" src="${n.imageData}" alt="照片">`
      : `<div class="note-thumb note-thumb-empty">${esc((currentType.icon) || '📝')}</div>`;

    const chips = fieldChips(n);
    const typeLabelNow = currentType.key === 'all' ? (NoteTypes.getType(n.type || 'note')?.label || n.type) : currentType.label;
    const metaLine = `<div class="note-meta">${esc(typeLabelNow)} · ${esc(n.date || '无日期')}${n.project ? ' · 📁 ' + esc(n.project) : ''}${chips.length ? ' · ' + chips.join(' · ') : ''}</div>`;
    const readerHtml = n.readerNote
      ? `<p class="note-note reader"><span>读者注</span>${esc(summary(n.readerNote))}</p>` : '';
    const aiHtml = n.aiNote
      ? `<p class="note-note ai"><span>AI注</span>${esc(summary(n.aiNote))}</p>` : '';
    const contentHtml = n.content
      ? `<p class="note-note content">${esc(summary(n.content))}</p>` : '';
    const tagHtml = Array.isArray(n.tags) && n.tags.length
      ? `<div class="note-tags">${n.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>`
      : '';
    const conceptNames = (n.concepts || [])
      .map((c) => {
        const found = conceptCatalog.find((cc) => cc.id === c.id);
        return found ? found.name : c.id;
      })
      .filter(Boolean);
    const conceptHtml = conceptNames.length
      ? `<div class="note-tags note-concepts">${conceptNames.map((c) => `<span class="tag concept">${esc(c)}</span>`).join('')}</div>`
      : '';

    card.innerHTML = `
      ${thumb}
      <div class="note-body">
        ${metaLine}
        <h3 class="note-title">${esc(n.title || '未命名')}</h3>
        ${contentHtml}
        ${readerHtml}
        ${aiHtml}
        ${tagHtml}
        ${conceptHtml}
      </div>
      <div class="note-actions">
        <button class="btn ghost small" data-act="edit">编辑</button>
        <button class="btn ghost small danger" data-act="del">删除</button>
      </div>`;
    card.dataset.id = n.id;
    els.list.appendChild(card);
  }
  els.empty.hidden = notes.length > 0;
}

async function refresh() {
  notesCache = await getAllNotes(currentType.key);
  applySearch();
}

/* ── 搜索过滤 ── */

/** 匹配字段：标题 / 内容 / 读者注 / AI注 / 标签（toLowerCase 包含匹配） */
function matchesQuery(n, q) {
  const fields = [n.title, n.content, n.readerNote, n.aiNote, n.project,
    ...(Array.isArray(n.tags) ? n.tags : []),
    ...(Array.isArray(n.concepts) ? n.concepts.map((c) => c.id) : []),
    ...(Array.isArray(n.concepts) ? n.concepts.map((c) => {
      const found = conceptCatalog.find((cc) => cc.id === c.id);
      return found ? found.name : '';
    }) : [])];
  if (typeFilter && String(n.type || 'note') !== typeFilter) return false;
  return fields.some((f) => String(f ?? '').toLowerCase().includes(q));
}

/**
 * 按当前搜索词过滤 notesCache 并重渲染列表与计数：
 * 有词 → “匹配 M / 共 N 条”；空词 → 全量 “N 条”。
 */
function applySearch() {
  const q = searchQuery.trim().toLowerCase();
  let list = q ? notesCache.filter((n) => matchesQuery(n, q)) : notesCache.slice();
  const f = listFilters;
  if (f.project) list = list.filter((n) => String(n.project || '') === f.project);
  if (f.book) list = list.filter((n) => String(n.book || '') === f.book);
  if (f.dateFrom) list = list.filter((n) => String(n.date || '') >= f.dateFrom);
  if (f.dateTo) list = list.filter((n) => String(n.date || '') <= f.dateTo);
  els.count.textContent = q
    ? `匹配 ${list.length} / 共 ${notesCache.length} 条`
    : `${notesCache.length} 条`;
  renderList(list);
  // 空状态：搜索无结果时提示换关键词，否则恢复默认引导文案（清空搜索即复原）
  const searching = list.length === 0 && q.length > 0;
  els.emptyTitle.textContent = searching
    ? '没有匹配的记录'
    : `还没有${currentType.label}`;
  els.emptyHint.textContent = searching
    ? `未找到包含「${searchQuery.trim()}」的${currentType.label}，换个关键词试试。`
    : `点「写一篇」开始记录${currentType.label}。`;
  els.emptyNewBtn.hidden = searching;
}

/* ── 编辑器：动态类型字段 ── */
function buildTypeFields(rec, typeDef = currentType) {
  const wrap = els.typeFields;
  wrap.innerHTML = '';
  const existing = rec || {};
  const meta = existing.meta || {};
  for (const f of typeDef.fields) {
    const metaInfo = NoteTypes.fieldMeta(f);
    const field = document.createElement('label');
    field.className = 'field';
    if (metaInfo.type === 'checkbox') {
      field.innerHTML = `<span class="field-head"><span>${esc(metaInfo.label)}</span></span>`;
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = !!meta.done;
      chk.id = `f-${f}`;
      chk.className = 'field-check';
      field.appendChild(chk);
      wrap.appendChild(field);
      continue;
    }
    field.innerHTML = `<span>${esc(metaInfo.label)}</span>`;
    const input = document.createElement('input');
    input.type = metaInfo.type || 'text';
    input.placeholder = metaInfo.placeholder || '';
    input.id = `f-${f}`;
    if (f === 'book') input.value = existing.book || '';
    if (f === 'pages') input.value = existing.pages || '';
    if (f === 'due') input.value = meta.due || '';
    field.appendChild(input);
    wrap.appendChild(field);
  }
}

function collectTypeFields(rec, typeDef = currentType) {
  const out = { meta: { ...((rec && rec.meta) || {}) } };
  for (const f of typeDef.fields) {
    const el = $(`f-${f}`);
    if (!el) continue;
    if (f === 'book') out.book = el.value.trim();
    else if (f === 'pages') out.pages = el.value.trim();
    else if (f === 'done') out.meta.done = el.checked;
    else if (f === 'due') out.meta.due = el.value;
  }
  return out;
}

function openEditor(rec) {
  editingId = rec ? rec.id : null;
  const effType = (currentType.key === 'all' && rec) ? NoteTypes.getType(rec.type || 'note') : currentType;
  const eff = effType || currentType;
  photoData = rec?.imageData || '';
  const verb = rec ? '编辑' : '写';
  els.editorTitle.textContent = `${verb}${eff.label}`;
  els.fDate.value = rec?.date || todayStr();
  els.fTitle.value = rec?.title || '';
  els.fTags.value = (rec?.tags || []).join(', ');
  els.fContent.value = rec?.content || '';
  els.fProject.value = rec?.project || '';
  els.mdPreview.hidden = true;
  els.fReader.value = rec?.readerNote || '';
  els.fAi.value = rec?.aiNote || '';
  selectedConcepts = new Map((rec?.concepts || []).map((c) => [String(c.id || ''), String(c.source || 'user')]).filter(([id]) => id));
  buildTypeFields(rec, eff);
  renderConceptSelector();
  if (photoData) {
    els.photoPreview.src = photoData;
    els.photoPreview.hidden = false;
  } else {
    els.photoPreview.hidden = true;
  }
  els.editor.hidden = false;
  els.editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeEditor() {
  els.editor.hidden = true;
  editingId = null;
  photoData = '';
  els.photoInput.value = '';
  els.photoPreview.hidden = true;
  els.fTags.value = '';
  els.mdPreview.hidden = true;
  selectedConcepts = new Map();
}

async function saveRecord() {
  const existing = editingId ? notesCache.find((n) => n.id === editingId) : null;
  const effType = (currentType.key === 'all') ? (NoteTypes.getType(existing?.type || 'note') || currentType) : currentType;
  const title = els.fTitle.value.trim();
  const date = els.fDate.value || todayStr();
  const rec = {
    ...existing,                       // 保留未编辑的其它字段
    id: editingId || undefined,
    type: (currentType.key === 'all' ? (existing?.type || 'note') : currentType.key),
    title: title || `${currentType.label} · ${date}`,
    date,
    tags: parseTagsInput(els.fTags.value),
    concepts: [...selectedConcepts.entries()].map(([id, source]) => ({ id, source: source || 'user' })),
    content: els.fContent.value.trim(),
    project: els.fProject.value.trim(),
    readerNote: els.fReader.value.trim(),
    aiNote: els.fAi.value.trim(),
    imageData: photoData,
    ...collectTypeFields(existing, effType),    // book/pages/meta 按类型字段覆盖
  };
  await addNote(rec);
  const savedId = editingId;
  const fromDetail = editingFromDetail;
  closeEditor();
  await refresh();
  toast(fromDetail ? '已保存，返回详情' : (savedId ? '已更新' : '已保存'));
}

/* ── AI 咨询（同 notes.js，OpenAI 兼容端点） ── */
async function askAI() {
  const endpoint = localStorage.getItem('aiEndpoint');
  if (!endpoint) {
    throw new Error('未配置 AI 服务地址：请在浏览器控制台设置 localStorage.aiEndpoint（OpenAI 兼容接口地址）');
  }
  const model = localStorage.getItem('aiModel') || 'deepseek-v4-flash';
  const question = els.fReader.value.trim() || '请简要介绍这一页内容';
  const payload = {
    model,
    messages: [
      {
        role: 'system',
        content: '你是读书笔记助手。根据照片与读者的疑问，给出准确、简洁、条理清晰的中文解答；若图片无法辨识或问题超出依据，请如实说明。',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `读者的疑问/要求：${question}` },
          ...(photoData ? [{ type: 'image_url', image_url: { url: photoData } }] : []),
        ],
      },
    ],
  };
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`AI 服务响应 ${resp.status}${text ? `：${text.slice(0, 120)}` : ''}`);
  }
  const data = await resp.json();
  const answer = data.choices?.[0]?.message?.content;
  if (!answer) throw new Error('AI 服务返回为空');
  return answer.trim();
}

/* ── 类型管理面板 ── */
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
async function openImportDialog(pkg, source) {
  const diff = await diffNotePackage(pkg);
  pendingImport = { pkg, diff };
  const list = Array.isArray(pkg.notes) ? pkg.notes : [];
  const at = pkg.exportedAt ? `（导出时间 ${String(pkg.exportedAt).slice(0, 16).replace('T', ' ')}）` : '';
  const stats = summarizePackage(pkg);   // 标签/概念规模（需求 20260905-批次一 F1）
  els.importDiffText.textContent =
    `来源：${source}，包内 ${list.length} 条${at}\n` +
    `新增 ${fmtCount(diff.added.length)} ｜ 更新 ${fmtCount(diff.updated.length)} ｜ ` +
    `本端更新 ${fmtCount(diff.localNewer.length)} ｜ 不变 ${fmtCount(diff.unchanged)} ｜ 本端独有 ${fmtCount(diff.localOnly)}\n` +
    `标签：${stats.tagRecords} 条记录 · ${stats.tagKinds} 个 ｜ 概念：${stats.conceptRecords} 条记录 · ${stats.conceptKinds} 个`;
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
    const { applied } = await mergeNotePackage(pkg, strategy);
    await refresh();
    const kept = strategy === 'merge' ? `，保留本端更新 ${fmtCount(diff.localNewer.length)} 条` : '';
    toast(`已${strategy === 'replace' ? '替换' : strategy === 'new' ? '仅新增' : '合并'}导入 ${applied} 条${kept}`);
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
  if (currentType) els.backupType.value = currentType.key;
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
  if (currentType) els.exportType.value = currentType.key;  // 默认选中当前类型
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

/* ── 富文本工具栏 / 预览（A1：md-toolbar 纯函数驱动）────────────── */

function renderMdToolbar() {
  els.mdToolbar.innerHTML = BUTTONS.map((b) =>
    `<button type="button" data-md="${esc(b.key)}" title="${esc(b.title)}">${esc(b.label)}</button>`).join('');
}

function onMdBtn(key) {
  const cfg = BUTTONS.find((b) => b.key === key);
  if (!cfg || !els.fContent) return;
  const t = els.fContent;
  const r = wrapSelection(t.value, t.selectionStart || 0, t.selectionEnd || 0, cfg);
  t.value = r.value;
  t.focus();
  t.setSelectionRange(r.selStart, r.selEnd);
}

async function toggleMdPreview() {
  const show = els.mdPreview.hidden;
  els.mdPreview.hidden = !show;
  if (show) {
    els.mdPreview.innerHTML = renderPreview(els.fContent.value || '');
    try { await typesetInto(els.mdPreview); } catch (e) { /* 公式排版失败不阻断预览 */ }
  }
}

els.mdToolbar.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-md]');
  if (btn) onMdBtn(btn.getAttribute('data-md'));
});
els.mdPreviewToggle.addEventListener('click', toggleMdPreview);

/* ── 筛选栏（项目/书名/日期区间 + 快捷；与搜索 AND 叠加）────────────── */

async function initFilterBar() {
  const projects = await getAllProjects();
  els.filterProject.innerHTML = '<option value="">全部项目</option>' +
    projects.map((p2) => `<option value="${esc(p2)}">${esc(p2)}</option>`).join('');
  const books = await getAllBooks();
  els.filterBook.innerHTML = '<option value="">全部书名</option>' +
    books.map((b) => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join('');
  // 「全部」伪类型页：追加类型筛选 chips
  if (currentType.key === 'all') {
    const chips = document.createElement('div');
    chips.className = 'filter-type-chips';
    chips.innerHTML = ['all', 'note', 'diary', 'log', 'memo']
      .map((k) => { const tt = NoteTypes.getType(k); return `<button type="button" class="btn ghost small type-chip${k === 'all' ? ' active' : ''}" data-type-chip="${k}">${tt ? tt.icon + ' ' + esc(tt.label) : k}</button>`; }).join('');
    els.filterBar.appendChild(chips);
    chips.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-type-chip]');
      if (!btn) return;
      const k = btn.getAttribute('data-type-chip');
      typeFilter = k === 'all' ? '' : k;
      chips.querySelectorAll('.type-chip').forEach((b2) => b2.classList.toggle('active', b2 === btn));
      applySearch();
    });
  }
}

function readFilters() {
  listFilters = {
    project: els.filterProject.value || '',
    book: els.filterBook.value || '',
    dateFrom: els.filterFrom.value || '',
    dateTo: els.filterTo.value || '',
  };
  applySearch();
}

function applyQuickFilter(kind) {
  const today = todayStr();
  if (kind === 'month') {
    els.filterFrom.value = today.slice(0, 8) + '01';
    els.filterTo.value = today;
  } else if (kind === 'year') {
    els.filterFrom.value = today.slice(0, 4) + '-01-01';
    els.filterTo.value = today;
  } else {
    els.filterFrom.value = '';
    els.filterTo.value = '';
  }
  readFilters();
}

let typeFilter = '';   // 「全部」页的类型筛选（'' = 全部）

els.filterProject.addEventListener('change', readFilters);
els.filterBook.addEventListener('change', readFilters);
els.filterFrom.addEventListener('change', readFilters);
els.filterTo.addEventListener('change', readFilters);
els.filterBar.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-quick]');
  if (btn) applyQuickFilter(btn.getAttribute('data-quick'));
});

/* ── 事件绑定 ── */
els.newBtn.addEventListener('click', () => openEditor());
els.emptyNewBtn.addEventListener('click', () => openEditor());
els.searchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value;
  applySearch();
});
els.cancelBtn.addEventListener('click', closeEditor);
els.saveBtn.addEventListener('click', saveRecord);
els.manageBtn.addEventListener('click', openManager);
els.manageClose.addEventListener('click', () => { els.manage.hidden = true; });
els.tagManageBtn.addEventListener('click', openTagManager);
els.tagManageClose.addEventListener('click', () => { els.tagManage.hidden = true; });

els.typeAddForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const fields = [...els.tFields.querySelectorAll('input:checked')].map((i) => i.value);
  try {
    const t = NoteTypes.addType({
      key: els.tKey.value,
      label: els.tLabel.value,
      icon: els.tIcon.value,
      fields,
    });
    toast(`已添加类型「${t.label}」`);
    els.tKey.value = ''; els.tLabel.value = ''; els.tIcon.value = '';
    renderTypeManager();
    renderHeader();
  } catch (err) {
    toast(err.message, 4200);
  }
});

els.typeList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-rm]');
  if (!btn) return;
  const key = btn.dataset.rm;
  if (!confirm(`删除自定义类型「${key}」？已有该类型的记录将不再出现在导航中（数据保留）。`)) return;
  NoteTypes.removeType(key);
  renderTypeManager();
  renderHeader();
});

els.tagList.addEventListener('click', async (e) => {
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
      await refresh();
      toast(`已重命名/合并 ${n} 条记录到「${newTag}」`);
    } catch (err) {
      toast(`重命名失败：${err.message}`, 4200);
    }
  } else if (btn.dataset.act === 'delete') {
    if (!confirm(`从所有本地记录中删除标签「${oldTag}」？`)) return;
    const n = await deleteTag(oldTag);
    await renderTagManager();
    await refresh();
    toast(`已从 ${n} 条记录删除「${oldTag}」`);
  }
});

els.exportBtn.addEventListener('click', openBackupPanel);
els.backupClose.addEventListener('click', () => { els.backupPanel.hidden = true; });
els.backupExportBtn.addEventListener('click', doBackupExport);
['backup-book', 'backup-type', 'backup-from', 'backup-to'].forEach((id) => {
  document.getElementById(id).addEventListener('change', refreshBackupStats);
});
els.backupImages.addEventListener('change', refreshBackupStats);
els.exportPdfBtn.addEventListener('click', async () => {
  await renderExportSelects();
  els.exportPanel.hidden = false;
});
els.exportClose.addEventListener('click', () => { els.exportPanel.hidden = true; });
els.exportPrintBtn.addEventListener('click', doPrintDraft);
els.exportMdBtn.addEventListener('click', doDownloadMd);
els.importBtn.addEventListener('click', () => els.importFile.click());
els.importFile.addEventListener('change', () => {
  if (els.importFile.files[0]) doImport(els.importFile.files[0]);
  els.importFile.value = '';
});
els.importConfirm.addEventListener('click', confirmImport);
els.importCancel.addEventListener('click', closeImportDialog);
els.syncBtn.addEventListener('click', async () => {
  els.syncBtn.disabled = true;
  els.syncBtn.textContent = '同步中…';
  try {
    await syncFromCli();
  } catch (err) {
    toast(`同步失败：${err.message}`, 4200);
  } finally {
    els.syncBtn.disabled = false;
    els.syncBtn.textContent = '⇄ 从电脑导入';
  }
});

els.photoBtn.addEventListener('click', () => els.photoInput.click());
els.photoInput.addEventListener('change', async () => {
  const file = els.photoInput.files[0];
  if (!file) return;
  try {
    photoData = await compressImage(file);
    els.photoPreview.src = photoData;
    els.photoPreview.hidden = false;
    toast('照片已就绪');
  } catch (err) {
    toast(`照片处理失败：${err.message}`);
  }
});

els.askAiBtn.addEventListener('click', async () => {
  els.askAiBtn.disabled = true;
  els.askAiBtn.textContent = '咨询中…';
  try {
    els.fAi.value = await askAI();
    toast('AI 回答已填入 AI注');
  } catch (err) {
    toast(err.message, 4200);
  } finally {
    els.askAiBtn.disabled = false;
    els.askAiBtn.textContent = '咨询 AI 并填入';
  }
});

/* 列表事件委托：展开详情 / 编辑 / 删除 */
els.list.addEventListener('click', async (event) => {
  const card = event.target.closest('.note-card');
  if (!card) return;
  const note = notesCache.find((n) => n.id === card.dataset.id);
  if (!note) return;

  const actBtn = event.target.closest('[data-act]');
  if (actBtn) {
    const act = actBtn.dataset.act;
    if (act === 'edit') {
      openEditor(note);
    } else if (act === 'del') {
      if (confirm(`删除「${note.title}」？`)) {
        await deleteNote(note.id);
        await refresh();
        toast('已删除');
      }
    }
    return;
  }

  // 点击卡片主体 → 跳转详情页（需求：PWA 笔记详情页；inline 展开已省略避免双轨）
  location.href = `note.html?id=${encodeURIComponent(note.id)}`;
});

/* ── 启动 ── */
(function init() {
  const key = new URLSearchParams(location.search).get('t') || 'note';
  currentType = NoteTypes.getType(key) || NoteTypes.getType('note');
  renderHeader();
  document.title = `${currentType.label} · 读书笔记`;
  renderMdToolbar();
  initFilterBar();
  refresh(); // applySearch() 负责空状态文案（含搜索无结果态）
  loadConceptCatalog();
  getAllProjects().then((ps) => { els.projectList.innerHTML = ps.map((p2) => `<option value="${esc(p2)}"></option>`).join(''); });
  // 编辑直入：note.html「✏️ 编辑」→ type.html?t=<类型>&edit=<id>（编辑器与创建一致，保存回跳详情页）
  const editId = new URLSearchParams(location.search).get('edit');
  if (editId) {
    editingFromDetail = true;
    setTimeout(async () => {
      const rec = (await getAllNotes()).find((n) => n.id === editId);
      if (rec) openEditor(rec);
      else toast('没有找到该记录（可能尚未导入）', 4200);
    }, 300);
  }
})();
