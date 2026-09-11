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
  getAllBooks,
} from './data.js';
import { renderNoteDetailInto } from './note-detail.js';
import { filterNotesByScope, buildPrintHtml, buildMarkdownDraft, scopeLabel } from './print-export.js';
import { BUTTONS, wrapSelection, renderPreview } from './md-toolbar.js';
import { typesetInto } from './vendor/mathjax3/mathjax-boot.js';
import { mountDataActions } from './data-actions.js';

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
  fType: $('f-type'),
  fType: $('f-type'),
  newBtn: $('new-btn'),
  emptyNewBtn: $('empty-new-btn'),
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
  tagHistory: $('tag-history'),
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
let listFilters = { project: '', book: '', dateFrom: '', dateTo: '', tag: '', concept: '' };  // 筛选栏状态（与搜索 AND 叠加；tag/concept 来自详情页 chips 入口）
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
  if (f.tag) list = list.filter((n) => Array.isArray(n.tags) && n.tags.includes(f.tag));
  if (f.concept) {
    list = list.filter((n) => Array.isArray(n.concepts)
      && n.concepts.some((c) => (typeof c === 'string' ? c : (c && c.id) || '') === f.concept));
  }
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

async function fillTagHistory() {
  try {
    const tags = await getAllTags();
    els.tagHistory.innerHTML = tags.slice(0, 50).map((t) => `<option value="${esc(t.tag)}"></option>`).join('');
  } catch (e) { /* 历史提示失败不影响编辑 */ }
}

function openEditor(rec) {
  fillTagHistory();   // 既有标签历史提示（需求 20260905-批次二 F3）
  editingId = rec ? rec.id : null;
  const effType = (currentType.pseudo && !rec) ? NoteTypes.getType('note')
    : (currentType.pseudo && rec) ? NoteTypes.getType(rec.type || 'note')
    : currentType;
  const eff = effType || NoteTypes.getType('note');
  fillTypeOptions(eff.key);   // 类型选择器（20260911 ⑦：新建必选/编辑可改）
  photoData = rec?.imageData || '';
  const verb = rec ? '编辑' : '写';
  els.editorTitle.textContent = `${verb}${eff.label}`;
  els.fDate.value = rec?.date || todayStr();
  els.fTitle.value = rec?.title || '';
  els.fTags.value = (rec?.tags || []).join(', ');
  els.fContent.value = rec?.content || '';
  els.fProject.value = rec?.project || new URLSearchParams(location.search).get('project') || '';
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
  const effType = selectedTypeDef();   // 以编辑器所选类型为准（20260911 ⑦）
  const title = els.fTitle.value.trim();
  const date = els.fDate.value || todayStr();
  const rec = {
    ...existing,                       // 保留未编辑的其它字段
    id: editingId || undefined,
    type: effType.key || 'note',
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
  const ret = new URLSearchParams(location.search).get('ret');   // 文件夹内新建后回跳
  closeEditor();
  await refresh();
  toast(fromDetail ? '已保存，返回详情' : (savedId ? '已更新' : '已保存'));
  if (!fromDetail && ret) location.href = `folder.html?p=${encodeURIComponent(ret)}`;
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

/** 类型下拉（新建必选 / 编辑可改；20260911 ⑦） */
function fillTypeOptions(selectedKey) {
  if (!els.fType) return;
  els.fType.innerHTML = NoteTypes.getTypes(false)
    .map((t) => `<option value="${esc(t.key)}"${t.key === selectedKey ? ' selected' : ''}>${esc(t.icon + ' ' + t.label)}</option>`)
    .join('');
}

/** 当前编辑器选中的类型定义 */
function selectedTypeDef() {
  const k = (els.fType && els.fType.value) || currentType.key;
  return NoteTypes.getType(k) || currentType;
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

if (els.fType) {
  els.fType.addEventListener('change', () => {
    const def = selectedTypeDef();
    buildTypeFields(editingId ? notesCache.find((n) => n.id === editingId) : null, def);
    els.editorTitle.textContent = `${editingId ? '编辑' : '写'}${def.label}`;
  });
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
  // 标签/概念过滤 chips 的 × 清除（事件委托在 filterBar，容器动态增删）
  els.filterBar.addEventListener('click', (e) => {
    const x = e.target.closest('.chip-x');
    if (!x) return;
    const kind = x.dataset.kind;
    if (kind === 'tag') listFilters.tag = '';
    if (kind === 'concept') listFilters.concept = '';
    // 同步清 URL 参数（避免刷新后过滤复活）
    const url = new URL(location.href);
    url.searchParams.delete(kind === 'tag' ? 'tag' : 'concept');
    history.replaceState(null, '', url);
    renderTagFilterChips();
    applySearch();
  });
}

function readFilters() {
  listFilters = {
    project: els.filterProject.value || '',
    book: els.filterBook.value || '',
    dateFrom: els.filterFrom.value || '',
    dateTo: els.filterTo.value || '',
    tag: listFilters.tag || '',
    concept: listFilters.concept || '',
  };
  renderTagFilterChips();
  applySearch();
}

/** 标签/概念过滤 chips（?tag=/?concept= 入口；× 可清除，需求 20260905-批次二 F3） */
function renderTagFilterChips() {
  let host = els.filterBar.querySelector('.filter-tag-chips');
  if (!listFilters.tag && !listFilters.concept) {
    if (host) host.remove();
    return;
  }
  if (!host) {
    host = document.createElement('div');
    host.className = 'filter-tag-chips';
    els.filterBar.appendChild(host);
  }
  const parts = [];
  if (listFilters.tag) parts.push(`<span class="btn ghost small tag-chip" data-kind="tag">🏷️ #${esc(listFilters.tag)} <button type="button" class="chip-x" data-kind="tag" aria-label="清除标签过滤">×</button></span>`);
  if (listFilters.concept) parts.push(`<span class="btn ghost small tag-chip" data-kind="concept">💡 ${esc(listFilters.concept)} <button type="button" class="chip-x" data-kind="concept" aria-label="清除概念过滤">×</button></span>`);
  host.innerHTML = parts.join('');
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
  const params = new URLSearchParams(location.search);
  const key = params.get('t') || 'note';
  // 旧列表 URL 重定向（20260911 ⑦）：type.html?t=note|diary|log|memo → 📒 笔记目录
  // 例外：?edit= 编辑直入、type=all（标签/概念筛选落地页）保持原页
  if (key !== 'all' && !params.get('edit') && !params.get('new')) {
    location.replace('folders.html');
    return;
  }
  currentType = NoteTypes.getType(key) || NoteTypes.getType('note');
  renderHeader();
  document.title = `${currentType.label} · 读书笔记`;
  renderMdToolbar();
  // 数据管理入口（⚙️ 数据）：导入/备份/导出生成/类型/标签——共享模块（20260911 回归修复）
  mountDataActions({ onChange: refresh, getCurrentType: () => currentType });
  // F3 入口：?tag= / ?concept=（详情页 chips 跳转）→ 过滤状态 + 可清除 chips
  const urlParams = new URLSearchParams(location.search);
  listFilters.tag = urlParams.get('tag') || '';
  listFilters.concept = urlParams.get('concept') || '';
  initFilterBar();
  renderTagFilterChips();
  refresh(); // applySearch() 负责空状态文案（含搜索无结果态）
  loadConceptCatalog();
  getAllProjects().then((ps) => { els.projectList.innerHTML = ps.map((p2) => `<option value="${esc(p2)}"></option>`).join(''); });
  // 编辑直入：note.html「✏️ 编辑」→ type.html?t=<类型>&edit=<id>（编辑器与创建一致，保存回跳详情页）
  const editId = urlParams.get('edit');
  const isNew = urlParams.get('new');   // 文件夹页「＋ 写一篇」→ 自动打开空白编辑器（20260911 修复）
  if (editId) {
    editingFromDetail = true;
    setTimeout(async () => {
      const rec = (await getAllNotes()).find((n) => n.id === editId);
      if (rec) openEditor(rec);
      else toast('没有找到该记录（可能尚未导入）', 4200);
    }, 300);
  } else if (isNew) {
    setTimeout(() => openEditor(null), 300);
  }
})();
