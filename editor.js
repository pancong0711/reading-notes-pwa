/**
 * editor.js —— 独立笔记编辑页
 *
 * 目标（需求 20261107）：
 *   · 列表页不再承载编辑表单；新建/编辑统一进入 editor.html；
 *   · 手机端优先：相机/相册分离、固定保存栏、文件夹上下文、未保存保护与自动草稿；
 *   · 保留原 type.html 编辑器的全部字段和图片非破坏性版式能力。
 *
 * URL：
 *   editor.html?type=note                     新建（默认 other）
 *   editor.html?type=note&project=a/b         新建并预填文件夹
 *   editor.html?id=<note-id>&ret=<相对URL>     编辑已有记录
 */
import {
  getNoteById,
  addNote,
  getAllTags,
  getAllFolderPaths,
  saveEditorDraft,
  getEditorDraft,
  deleteEditorDraft,
} from './data.js';
import { normalizeProject } from './folder-util.js';
import { BUTTONS, wrapSelection, renderPreview } from './md-toolbar.js';
import { typesetInto } from './vendor/mathjax3/mathjax-boot.js';
import { renderHtmlPreviewInto } from './html-doc.js';
import {
  mediaFromMarkdown, mergeMediaLists, normalizeMediaItem, normalizeMediaList,
  applyMediaAttrsToMarkdown, safeMediaSrc,
} from './media-util.js';
import { normalizeDocStyle, styleToCss, FONT_OPTIONS } from './doc-style.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const requestedId = params.get('id') || params.get('edit') || '';
const draftKey = requestedId ? `note:${requestedId}` : 'new';

const els = {
  editor: $('editor'),
  editorTitle: $('editor-title'),
  saveStatus: $('save-status'),
  backBtn: $('back-btn'),
  cancelBtn: $('cancel-btn'),
  saveBtns: Array.from(document.querySelectorAll('[data-save]')),
  folderLabel: $('folder-label'),
  folderPickBtn: $('folder-pick-btn'),
  folderPicker: $('folder-picker'),
  folderPickerCurrent: $('folder-picker-current'),
  folderPickerSelect: $('folder-picker-select'),
  folderPickerNew: $('folder-picker-new'),
  folderPickerApply: $('folder-picker-apply'),
  folderPickerCancel: $('folder-picker-cancel'),
  draftBanner: $('draft-banner'),
  draftRestore: $('draft-restore-btn'),
  draftDiscard: $('draft-discard-btn'),
  photoCameraInput: $('photo-input-camera'),
  photoGalleryInput: $('photo-input-gallery'),
  photoCameraBtn: $('photo-camera-btn'),
  photoGalleryBtn: $('photo-gallery-btn'),
  photoStrip: $('photo-strip'),
  photoHint: $('photo-hint'),
  fType: $('f-type'),
  typeFields: $('type-fields'),
  fDate: $('f-date'),
  fTitle: $('f-title'),
  fTags: $('f-tags'),
  tagHistory: $('tag-history'),
  fProject: $('f-project'),
  fContent: $('f-content'),
  fFormat: $('f-format'),
  mediaEditorField: $('media-editor-field'),
  mediaEditor: $('media-editor'),
  fFont: $('f-font'),
  fAlign: $('f-align'),
  fLineHeight: $('f-line-height'),
  mdToolbar: $('md-toolbar'),
  mdPreview: $('md-preview'),
  mdPreviewToggle: $('md-preview-toggle'),
  fReader: $('f-reader'),
  fAi: $('f-ai'),
  askAiBtn: $('ask-ai-btn'),
  aiEndpointInput: $('ai-endpoint-input'),
  aiModelInput: $('ai-model-input'),
  aiSettingsSave: $('ai-settings-save'),
  conceptField: $('concept-field'),
  conceptSelect: $('concept-select'),
  toast: $('toast'),
};

/* ── 状态 ── */
let currentType = null;
let editingId = requestedId || null;
let originalRecord = null;
let editorFormat = 'markdown';
let editorMedia = [];
let photoSources = [];       // 当前编辑中的照片 dataURL；第一张存 imageData，其余存 images
let assetImages = [];        // 从 CLI/正文导入的非 data: 图片路径（原样保留）
let docStyle = normalizeDocStyle({});
let selectedConcepts = new Map();
let conceptCatalog = [];
let conceptDomainNames = {};
let toastTimer = null;
let draftTimer = null;
let saving = false;
let dirty = false;
let loaded = false;
let folderPaths = [];
let pendingDraft = null;

/* ── 基础工具 ── */
function toast(msg, ms = 2800) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseTagsInput(value) {
  const raw = String(value || '').split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    if (/(^|[\\/])assets[\\/]/i.test(t) || /\.(jpe?g|png|gif|webp|bmp|svg|avif)$/i.test(t) || /^img_\w+\.\w+$/i.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function safeReturnUrl() {
  const raw = params.get('ret') || '';
  if (!raw) return '';
  try {
    const u = new URL(raw, location.href);
    if (u.origin !== location.origin) return '';
    if (!/\.(html|htm)$/i.test(u.pathname)) return '';
    return `${u.pathname}${u.search}${u.hash}`;
  } catch (e) {
    return '';
  }
}

function samePageUrl(a, b) {
  try {
    const ua = new URL(a, location.href);
    const ub = new URL(b, location.href);
    return ua.origin === ub.origin
      && ua.pathname === ub.pathname
      && ua.search === ub.search;
  } catch (e) {
    return false;
  }
}

function navigateBack({ discard = false } = {}) {
  if (saving) return;
  if (dirty && !confirm('有未保存的修改，确定离开吗？')) return;
  if (discard) deleteEditorDraft(draftKey).catch(() => {});
  const ret = safeReturnUrl();
  // 正常从来源页进入编辑页时，document.referrer 就是来源页：后退即可原路返回，
  // 不能再用 location.href 新增一条历史（否则会形成 详情↔编辑 循环）。
  if (ret && document.referrer && samePageUrl(document.referrer, ret)) {
    history.back();
    return;
  }
  // 直接打开编辑页/旧链接跳转等没有可靠历史时，replace 兜底，同样不新增历史。
  if (ret) { location.replace(ret); return; }
  if (history.length > 1) { history.back(); return; }
  location.replace('folders.html');
}

/* ── 图片压缩/照片管理 ── */
function compressImage(file, maxSide = 1600, quality = 0.86) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        const scale = Math.min(1, maxSide / Math.max(w, h));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';                 // JPEG 无透明通道，先铺白底避免截图黑底
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('图片解析失败（可能是浏览器不支持的格式）'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

function syncPhotoMedia() {
  const keep = new Set();
  photoSources.forEach((src, i) => {
    let m = editorMedia.find((x) => x.src === src || (i === 0 && x.id === 'imageData'));
    if (!m) {
      m = normalizeMediaItem({ id: i === 0 ? 'imageData' : `photo_${i + 1}`, src, alt: `照片 ${i + 1}` }, editorMedia.length);
      editorMedia.push(m);
    }
    m.src = src;
    if (i === 0) m.id = 'imageData';
    else if (m.id === 'imageData') m.id = `photo_${i + 1}`;
    if (!m.alt) m.alt = `照片 ${i + 1}`;
    keep.add(m);
  });
  // 清掉已经从照片条移除的 data: 图片媒体；保留正文/CLI 的 assets 图片媒体
  editorMedia = editorMedia.filter((m) => {
    const isDataPhoto = m.id === 'imageData' || String(m.src || '').startsWith('data:image/');
    return !isDataPhoto || keep.has(m);
  });
}

function renderPhotoStrip() {
  const visible = photoSources.map((src, i) => ({ src: safeMediaSrc(src), i })).filter((x) => x.src);
  if (!visible.length) {
    els.photoStrip.innerHTML = '<p class="muted photo-empty">还没有图片。</p>';
  } else {
    els.photoStrip.innerHTML = visible.map(({ src, i }) => `
      <figure class="photo-thumb" data-photo-idx="${i}">
        <img src="${esc(src)}" alt="照片 ${i + 1}">
        <figcaption>
          <span>${i === 0 ? '主图' : `图 ${i + 1}`}</span>
          <button type="button" class="btn ghost small danger" data-photo-remove="${i}" aria-label="移除照片 ${i + 1}">移除</button>
        </figcaption>
      </figure>`).join('');
  }
  if (els.photoHint) {
    els.photoHint.textContent = photoSources.length
      ? `已添加 ${photoSources.length} 张图片；保存后可在正文下方查看。`
      : '图片会压缩后保存在本机；正文中可用图片版式调整方向、宽度与对齐。';
  }
  renderMediaEditor();
}

async function addPhotoFiles(files) {
  const list = Array.from(files || []).filter((f) => f && /^image\//i.test(f.type || ''));
  if (!list.length) { toast('没有识别到图片文件'); return; }
  let added = 0;
  const failures = [];
  for (const file of list) {
    try {
      const dataUrl = await compressImage(file);
      if (!photoSources.includes(dataUrl)) { photoSources.push(dataUrl); added++; }
    } catch (e) {
      failures.push(`${file.name || '图片'}：${e.message}`);
    }
  }
  if (added) {
    syncPhotoMedia();
    renderPhotoStrip();
    markDirty();
    toast(`已添加 ${added} 张图片`);
  }
  if (failures.length) toast(`部分图片失败：${failures[0]}`, 4200);
}

function removePhoto(index) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= photoSources.length) return;
  const src = photoSources[i];
  photoSources.splice(i, 1);
  editorMedia = editorMedia.filter((m) => m.src !== src && !(i === 0 && m.id === 'imageData'));
  syncPhotoMedia();
  renderPhotoStrip();
  markDirty();
}

/* ── 类型字段 ── */
function fillTypeOptions(selectedKey) {
  if (!els.fType) return;
  els.fType.innerHTML = NoteTypes.getTypes(false)
    .map((t) => `<option value="${esc(t.key)}"${t.key === selectedKey ? ' selected' : ''}>${esc(t.icon + ' ' + t.label)}</option>`)
    .join('');
}

function selectedTypeDef() {
  const key = (els.fType && els.fType.value) || currentType?.key || 'note';
  return NoteTypes.getType(key) || NoteTypes.getType('note') || currentType;
}

function buildTypeFields(rec, typeDef = selectedTypeDef()) {
  if (!els.typeFields || !typeDef) return;
  const existing = rec || {};
  const meta = existing.meta || {};
  els.typeFields.innerHTML = '';
  for (const f of typeDef.fields || []) {
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
    } else {
      field.innerHTML = `<span>${esc(metaInfo.label)}</span>`;
      const input = document.createElement('input');
      input.type = metaInfo.type || 'text';
      input.placeholder = metaInfo.placeholder || '';
      input.id = `f-${f}`;
      if (f === 'book') input.value = existing.book || '';
      if (f === 'pages') input.value = existing.pages || '';
      if (f === 'due') input.value = meta.due || '';
      field.appendChild(input);
    }
    els.typeFields.appendChild(field);
  }
}

function collectTypeFields(rec, typeDef = selectedTypeDef()) {
  const out = { meta: { ...((rec && rec.meta) || {}) } };
  for (const f of typeDef.fields || []) {
    const el = $(`f-${f}`);
    if (!el) continue;
    if (f === 'book') out.book = el.value.trim();
    else if (f === 'pages') out.pages = el.value.trim();
    else if (f === 'done') out.meta.done = el.checked;
    else if (f === 'due') out.meta.due = el.value;
  }
  return out;
}

/* ── 概念目录 ── */
async function loadConceptCatalog() {
  try {
    const resp = await fetch('graph.json', { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    conceptCatalog = (data.concepts || []).map((c) => ({
      id: String(c.id || ''), name: String(c.name || c.id || ''), domain: String(c.domain || ''),
    })).filter((c) => c.id);
    conceptDomainNames = {};
    (data.domains || []).forEach((d) => { conceptDomainNames[String(d.id || '')] = String(d.name || d.id || ''); });
  } catch (err) {
    console.warn('[editor] 加载 graph.json 概念目录失败:', err);
    conceptCatalog = [];
  }
  renderConceptSelector();
}

function renderConceptSelector() {
  const typeKey = selectedTypeDef()?.key || 'note';
  const show = typeKey === 'note' || typeKey === 'diary';
  if (els.conceptField) els.conceptField.hidden = !show;
  if (!show || !els.conceptSelect) return;
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
    return `<div class="concept-group"><div class="concept-group-name">${esc(dname)}</div><div class="concept-options">${
      list.map((c) => {
        const checked = selectedConcepts.has(c.id) ? ' checked' : '';
        const src = selectedConcepts.get(c.id);
        const srcTag = src && src !== 'user' ? ` <span class="tag">${esc(src)}</span>` : '';
        return `<label class="concept-option"><input type="checkbox" data-concept="${esc(c.id)}"${checked}> ${esc(c.name)}${srcTag}</label>`;
      }).join('')
    }</div></div>`;
  }).join('');
  els.conceptSelect.querySelectorAll('input[data-concept]').forEach((input) => {
    input.addEventListener('change', () => {
      const id = input.dataset.concept;
      if (input.checked) { if (!selectedConcepts.has(id)) selectedConcepts.set(id, 'user'); }
      else selectedConcepts.delete(id);
      markDirty();
    });
  });
}

/* ── 图片版式 ── */
function mediaPreviewSrc(m) {
  if (!m) return '';
  const raw = m.id === 'imageData' && (!m.src || m.src === 'imageData') ? (photoSources[0] || '') : (m.src || '');
  return safeMediaSrc(raw);
}

function renderMediaEditor() {
  if (!els.mediaEditor || !els.mediaEditorField) return;
  const visible = editorMedia.filter((m) => mediaPreviewSrc(m));
  els.mediaEditorField.hidden = !visible.length;
  els.mediaEditor.innerHTML = visible.map((m, i) => {
    const idx = editorMedia.indexOf(m);
    const src = mediaPreviewSrc(m);
    return `<div class="media-row" data-media-idx="${idx}">
      <img class="media-thumb" src="${esc(src)}" alt="${esc(m.alt || '笔记图片')}">
      <div class="media-meta">
        <div class="media-name">${esc(m.alt || `图片 ${i + 1}`)}</div>
        <div class="media-controls">
          <button type="button" class="btn ghost small" data-media-act="rotate-left" title="向左旋转 90°">⟲</button>
          <button type="button" class="btn ghost small" data-media-act="rotate-right" title="向右旋转 90°">⟳</button>
          <label>宽度 <select data-media-field="width">
            ${[25, 50, 75, 100].map((w) => `<option value="${w}"${m.widthPercent === w ? ' selected' : ''}>${w}%</option>`).join('')}
          </select></label>
          <label>对齐 <select data-media-field="align">
            ${[['left', '左'], ['center', '中'], ['right', '右']].map(([v, l]) => `<option value="${v}"${m.align === v ? ' selected' : ''}>${l}</option>`).join('')}
          </select></label>
          <button type="button" class="btn ghost small" data-media-act="reset">重置</button>
        </div>
        <input class="media-caption" data-media-field="caption" value="${esc(m.caption || '')}" placeholder="图片说明（可选）">
      </div>
    </div>`;
  }).join('');
}

function onMediaEditorEvent(e) {
  const row = e.target.closest('[data-media-idx]');
  if (!row) return;
  const idx = Number(row.getAttribute('data-media-idx'));
  const m = editorMedia[idx];
  if (!m) return;
  const act = e.target.getAttribute('data-media-act');
  if (act === 'rotate-left') m.rotate = ((Number(m.rotate || 0) + 270) % 360);
  else if (act === 'rotate-right') m.rotate = ((Number(m.rotate || 0) + 90) % 360);
  else if (act === 'reset') { m.rotate = 0; m.widthPercent = 100; m.align = 'center'; m.caption = ''; }
  else {
    const field = e.target.getAttribute('data-media-field');
    if (!field) return;
    if (field === 'width') m.widthPercent = Number(e.target.value) || 100;
    else if (field === 'align') m.align = e.target.value || 'center';
    else if (field === 'caption') m.caption = e.target.value || '';
  }
  renderMediaEditor();
  markDirty();
}

/* ── 文档样式 / 格式 ── */
function initDocStyleOptions() {
  if (!els.fFont) return;
  els.fFont.innerHTML = FONT_OPTIONS.map((f) => `<option value="${f.value}">${f.label}</option>`).join('');
  els.fFont.value = docStyle.font;
}

function applyDocStyleToControls() {
  if (els.fFont) els.fFont.value = docStyle.font;
  if (els.fAlign) els.fAlign.value = docStyle.align;
  if (els.fLineHeight) els.fLineHeight.value = docStyle.lineHeight;
}

function readDocStyle() {
  docStyle = normalizeDocStyle({
    font: els.fFont?.value,
    align: els.fAlign?.value,
    lineHeight: els.fLineHeight?.value,
  });
  return docStyle;
}

function syncFormatUi() {
  editorFormat = els.fFormat?.value || editorFormat || 'markdown';
  const isMd = editorFormat === 'markdown';
  if (els.mdToolbar) els.mdToolbar.hidden = !isMd;
  if (els.fContent) {
    els.fContent.placeholder = isMd
      ? '写下内容……（支持 **粗体**、*斜体*、==高亮==、公式 $E=mc^2$、$$…$$ 等）'
      : editorFormat === 'html'
        ? '编辑 HTML 源码；保存进 JSON，不会修改原文件。HTML 预览在 sandbox iframe 中运行。'
        : '输入纯文本；保存进 JSON，换行与空白会保留。';
  }
  if (els.mdPreview) els.mdPreview.hidden = true;
}

function renderMdToolbar() {
  if (!els.mdToolbar) return;
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
  markDirty();
}

function renderPreviewContent() {
  const text = els.fContent.value || '';
  const css = styleToCss(docStyle);
  if (els.mdPreview) els.mdPreview.style.cssText = css;
  if (editorFormat === 'html') renderHtmlPreviewInto(els.mdPreview, text, { style: css });
  else if (editorFormat === 'text') els.mdPreview.innerHTML = `<pre class="note-text" style="${esc(css)}">${esc(text)}</pre>`;
  else els.mdPreview.innerHTML = renderPreview(text);
}

async function toggleMdPreview() {
  const show = els.mdPreview.hidden;
  els.mdPreview.hidden = !show;
  if (!show) return;
  renderPreviewContent();
  if (editorFormat === 'markdown') {
    try { await typesetInto(els.mdPreview); } catch (e) { /* 公式排版失败不阻断预览 */ }
  }
}

/* ── 文件夹上下文 ── */
function setProject(path) {
  const p = normalizeProject(path || 'other');
  if (els.fProject) els.fProject.value = p;
  if (els.folderLabel) els.folderLabel.textContent = p;
  if (els.folderPickerCurrent) els.folderPickerCurrent.textContent = p;
}

function renderFolderOptions() {
  if (!els.folderPickerSelect) return;
  const current = normalizeProject(els.fProject?.value || 'other');
  const paths = [...new Set(['other', ...folderPaths.map((x) => normalizeProject(x)), current])]
    .sort((a, b) => a.localeCompare(b, 'zh'));
  els.folderPickerSelect.innerHTML = paths.map((p) =>
    `<option value="${esc(p)}"${p === current ? ' selected' : ''}>${esc(p)}</option>`).join('');
}

async function openFolderPicker() {
  try {
    folderPaths = await getAllFolderPaths();
  } catch (e) { folderPaths = []; }
  renderFolderOptions();
  if (els.folderPickerNew) els.folderPickerNew.value = '';
  els.folderPicker.hidden = false;
}

function applyFolderPicker() {
  const newPath = String(els.folderPickerNew?.value || '').trim();
  const chosen = newPath || String(els.folderPickerSelect?.value || 'other');
  setProject(chosen);
  els.folderPicker.hidden = true;
  markDirty();
}

/* ── 草稿 ── */
function collectDraft() {
  const typeDef = selectedTypeDef();
  const fields = collectTypeFields(originalRecord, typeDef);
  return {
    editingId,
    type: typeDef?.key || 'note',
    title: els.fTitle?.value || '',
    date: els.fDate?.value || '',
    tags: els.fTags?.value || '',
    content: els.fContent?.value || '',
    contentFormat: els.fFormat?.value || editorFormat || 'markdown',
    project: els.fProject?.value || 'other',
    readerNote: els.fReader?.value || '',
    aiNote: els.fAi?.value || '',
    photos: photoSources.slice(),
    assetImages: assetImages.slice(),
    media: editorMedia.map((m) => ({ ...m })),
    style: { ...docStyle },
    concepts: [...selectedConcepts.entries()].map(([id, source]) => ({ id, source: source || 'user' })),
    book: fields.book || '',
    pages: fields.pages || '',
    meta: fields.meta || {},
  };
}

function scheduleDraft() {
  if (!loaded || !dirty) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(async () => {
    try { await saveEditorDraft(draftKey, collectDraft()); } catch (e) { /* 草稿失败不阻断编辑 */ }
  }, 700);
}

function markDirty() {
  if (!loaded) return;
  dirty = true;
  scheduleDraft();
}

function applyDraft(draft) {
  if (!draft) return;
  if (draft.type) { fillTypeOptions(draft.type); currentType = NoteTypes.getType(draft.type) || currentType; }
  els.fTitle.value = draft.title || '';
  els.fDate.value = draft.date || todayStr();
  els.fTags.value = draft.tags || '';
  els.fContent.value = draft.content || '';
  editorFormat = draft.contentFormat || 'markdown';
  if (els.fFormat) els.fFormat.value = editorFormat;
  syncFormatUi();
  els.fReader.value = draft.readerNote || '';
  els.fAi.value = draft.aiNote || '';
  photoSources = Array.isArray(draft.photos) ? draft.photos.filter((x) => typeof x === 'string') : [];
  assetImages = Array.isArray(draft.assetImages) ? draft.assetImages.filter((x) => typeof x === 'string') : [];
  editorMedia = normalizeMediaList(draft.media || []);
  syncPhotoMedia();
  docStyle = normalizeDocStyle(draft.style || {});
  applyDocStyleToControls();
  selectedConcepts = new Map((draft.concepts || []).map((c) => [String(c.id || ''), String(c.source || 'user')]).filter(([id]) => id));
  buildTypeFields({ book: draft.book || '', pages: draft.pages || '', meta: draft.meta || {} }, selectedTypeDef());
  setProject(draft.project || 'other');
  renderPhotoStrip();
  renderConceptSelector();
  dirty = true;
  scheduleDraft();
}

async function checkDraft() {
  try {
    const draft = await getEditorDraft(draftKey);
    if (!draft) return;
    const hasContent = String(draft.title || '').trim() || String(draft.content || '').trim()
      || (Array.isArray(draft.photos) && draft.photos.length);
    if (!hasContent) { await deleteEditorDraft(draftKey); return; }
    pendingDraft = draft;
    const when = draft.savedAt ? new Date(draft.savedAt) : null;
    els.draftBanner.querySelector('span').textContent = when
      ? `发现 ${when.toLocaleString('zh-CN')} 的未保存草稿`
      : '发现上次未保存的草稿';
    els.draftBanner.hidden = false;
  } catch (e) { /* 草稿读取失败不阻断 */ }
}

/* ── AI ── */
function loadAiSettings() {
  try {
    if (els.aiEndpointInput) els.aiEndpointInput.value = localStorage.getItem('aiEndpoint') || '';
    if (els.aiModelInput) els.aiModelInput.value = localStorage.getItem('aiModel') || '';
  } catch (e) { /* localStorage 不可用 */ }
}

function saveAiSettings() {
  const endpoint = String(els.aiEndpointInput?.value || '').trim();
  const model = String(els.aiModelInput?.value || '').trim();
  try {
    if (endpoint) localStorage.setItem('aiEndpoint', endpoint);
    else localStorage.removeItem('aiEndpoint');
    if (model) localStorage.setItem('aiModel', model);
    else localStorage.removeItem('aiModel');
    toast('AI 设置已保存在本机');
  } catch (e) { toast(`保存 AI 设置失败：${e.message}`, 4200); }
}

async function askAI() {
  let endpoint = '';
  try { endpoint = localStorage.getItem('aiEndpoint') || ''; } catch (e) { /* ignore */ }
  endpoint = endpoint || String(els.aiEndpointInput?.value || '').trim();
  if (!endpoint) throw new Error('未配置 AI 服务地址：请展开「AI注与概念标签」填写服务地址并保存');
  let model = '';
  try { model = localStorage.getItem('aiModel') || ''; } catch (e) { /* ignore */ }
  model = model || String(els.aiModelInput?.value || '').trim() || 'deepseek-v4-flash';
  const question = els.fReader.value.trim() || '请简要介绍这页/这些图片的内容';
  const payload = {
    model,
    messages: [
      { role: 'system', content: '你是读书笔记助手。根据书页照片与读者的疑问，给出准确、简洁、条理清晰的中文解答；若图片无法辨识或问题超出依据，请如实说明。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: `读者的疑问/要求：${question}` },
          ...photoSources.map((src) => ({ type: 'image_url', image_url: { url: src } })),
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

/* ── 加载/保存 ── */
async function fillTagHistory() {
  try {
    const tags = await getAllTags();
    if (els.tagHistory) els.tagHistory.innerHTML = tags.slice(0, 50).map((t) => `<option value="${esc(t.tag)}"></option>`).join('');
  } catch (e) { /* 历史提示失败不影响编辑 */ }
}

async function initEditor() {
  renderMdToolbar();
  initDocStyleOptions();
  loadAiSettings();
  await fillTagHistory();
  loadConceptCatalog();

  let rec = null;
  if (editingId) {
    try { rec = await getNoteById(editingId); } catch (e) { rec = null; }
    if (!rec) {
      toast('没有找到该记录（可能尚未导入）', 4200);
      setTimeout(() => { location.href = safeReturnUrl() || 'folders.html'; }, 900);
      return;
    }
  }
  originalRecord = rec;
  currentType = NoteTypes.getType(rec?.type || params.get('type') || 'note') || NoteTypes.getType('note');
  fillTypeOptions(currentType.key);

  photoSources = [];
  assetImages = [];
  if (rec?.imageData && safeMediaSrc(rec.imageData)) photoSources.push(rec.imageData);
  for (const src of (rec?.images || [])) {
    if (String(src).startsWith('data:image/')) {
      if (safeMediaSrc(src) && !photoSources.includes(src)) photoSources.push(src);
    } else if (src) assetImages.push(src);
  }
  editorMedia = mergeMediaLists(
    rec?.media,
    photoSources.map((src, i) => normalizeMediaItem({ id: i === 0 ? 'imageData' : `photo_${i + 1}`, src, alt: `照片 ${i + 1}` }, i)),
    assetImages.map((src, i) => normalizeMediaItem({ src, alt: `图片 ${i + 1}` }, photoSources.length + i)),
    mediaFromMarkdown(rec?.content || ''),
  );
  syncPhotoMedia();

  editorFormat = rec?.contentFormat || 'markdown';
  if (els.fFormat) els.fFormat.value = editorFormat;
  syncFormatUi();
  docStyle = normalizeDocStyle(rec?.style || {});
  applyDocStyleToControls();
  els.fDate.value = rec?.date || todayStr();
  els.fTitle.value = rec?.title || '';
  els.fTags.value = (rec?.tags || []).join(', ');
  els.fContent.value = rec?.content || '';
  els.fReader.value = rec?.readerNote || '';
  els.fAi.value = rec?.aiNote || '';
  selectedConcepts = new Map((rec?.concepts || []).map((c) => [String(c.id || ''), String(c.source || 'user')]).filter(([id]) => id));
  buildTypeFields(rec, currentType);
  setProject(rec?.project || params.get('project') || 'other');
  els.editorTitle.textContent = rec ? '编辑笔记' : '新建笔记';
  document.title = `${rec ? '编辑' : '新建'}笔记 · 读书笔记`;
  els.saveStatus.textContent = rec ? '已载入' : '';
  renderPhotoStrip();
  renderConceptSelector();
  loaded = true;
  dirty = false;
  await checkDraft();
}

function setSaving(on) {
  saving = on;
  els.saveBtns.forEach((b) => { b.disabled = on; b.textContent = on ? '保存中…' : '保存'; });
  if (on) els.saveStatus.textContent = '正在保存…';
}

async function saveRecord() {
  if (saving) return;
  setSaving(true);
  try {
    const typeDef = selectedTypeDef();
    const title = els.fTitle.value.trim();
    const date = els.fDate.value || todayStr();
    const fields = collectTypeFields(originalRecord, typeDef);
    const existing = originalRecord || (editingId ? await getNoteById(editingId) : null);
    const images = [...photoSources.slice(1), ...assetImages].filter((v, i, arr) => v && arr.indexOf(v) === i);
    const rec = {
      ...existing,
      id: editingId || undefined,
      type: typeDef?.key || 'note',
      title: title || `${typeDef?.label || '笔记'} · ${date}`,
      date,
      tags: parseTagsInput(els.fTags.value),
      concepts: [...selectedConcepts.entries()].map(([id, source]) => ({ id, source: source || 'user' })),
      content: (els.fFormat?.value || editorFormat) === 'markdown'
        ? applyMediaAttrsToMarkdown(els.fContent.value.trim(), editorMedia)
        : els.fContent.value.trim(),
      contentFormat: els.fFormat?.value || editorFormat || 'markdown',
      media: editorMedia.map((m) => ({ ...m })),
      style: docStyle,
      project: normalizeProject(els.fProject.value || 'other'),
      readerNote: els.fReader.value.trim(),
      aiNote: els.fAi.value.trim(),
      imageData: photoSources[0] || '',
      images,
      updatedAt: Date.now(),
      ...fields,
    };
    const savedId = await addNote(rec);
    editingId = savedId || editingId;
    originalRecord = await getNoteById(editingId);
    try { await deleteEditorDraft(draftKey); } catch (e) { /* ignore */ }
    dirty = false;
    els.saveStatus.textContent = '已保存';
    toast('已保存');

    const ret = safeReturnUrl();
    let target = '';
    if (ret) {
      try {
        const u = new URL(ret, location.href);
        if (/folder(s)?\.html$/i.test(u.pathname)) u.searchParams.set('saved', String(savedId || editingId || ''));
        target = `${u.pathname}${u.search}${u.hash}`;
      } catch (e) { target = ret; }
    } else if (existing) {
      target = `note.html?id=${encodeURIComponent(savedId || editingId)}`;
    } else if (normalizeProject(rec.project) !== 'other') {
      target = `folder.html?p=${encodeURIComponent(normalizeProject(rec.project))}&saved=${encodeURIComponent(savedId || editingId || '')}`;
    } else {
      target = 'folders.html';
    }
    setTimeout(() => location.replace(target), 260);
  } catch (e) {
    setSaving(false);
    els.saveStatus.textContent = '保存失败';
    toast(`保存失败：${e.message}`, 5000);
  }
}

/* ── 事件绑定 ── */
els.backBtn.addEventListener('click', () => navigateBack({ discard: false }));
els.cancelBtn.addEventListener('click', () => {
  if (dirty && !confirm('放弃未保存的修改？')) return;
  dirty = false;
  deleteEditorDraft(draftKey).catch(() => {});
  navigateBack({ discard: true });
});
els.saveBtns.forEach((b) => b.addEventListener('click', saveRecord));
els.folderPickBtn.addEventListener('click', openFolderPicker);
els.folderPickerApply.addEventListener('click', applyFolderPicker);
els.folderPickerCancel.addEventListener('click', () => { els.folderPicker.hidden = true; });

els.draftRestore.addEventListener('click', () => {
  if (pendingDraft) applyDraft(pendingDraft);
  els.draftBanner.hidden = true;
  toast('已恢复上次草稿');
});
els.draftDiscard.addEventListener('click', async () => {
  pendingDraft = null;
  els.draftBanner.hidden = true;
  try { await deleteEditorDraft(draftKey); } catch (e) { /* ignore */ }
  toast('已丢弃草稿');
});

els.photoCameraBtn.addEventListener('click', () => els.photoCameraInput.click());
els.photoGalleryBtn.addEventListener('click', () => els.photoGalleryInput.click());
els.photoCameraInput.addEventListener('change', async () => {
  await addPhotoFiles(els.photoCameraInput.files);
  els.photoCameraInput.value = '';
});
els.photoGalleryInput.addEventListener('change', async () => {
  await addPhotoFiles(els.photoGalleryInput.files);
  els.photoGalleryInput.value = '';
});
els.photoStrip.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-photo-remove]');
  if (btn) removePhoto(btn.getAttribute('data-photo-remove'));
});

els.fType.addEventListener('change', () => {
  const def = selectedTypeDef();
  buildTypeFields(originalRecord, def);
  renderConceptSelector();
  els.editorTitle.textContent = editingId ? '编辑笔记' : '新建笔记';
  markDirty();
});
els.mdToolbar.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-md]');
  if (btn) onMdBtn(btn.getAttribute('data-md'));
});
if (els.fFormat) els.fFormat.addEventListener('change', () => { syncFormatUi(); markDirty(); });
[els.fFont, els.fAlign, els.fLineHeight].forEach((el) => {
  if (el) el.addEventListener('change', () => {
    readDocStyle();
    markDirty();
    if (els.mdPreview && !els.mdPreview.hidden) renderPreviewContent();
  });
});
if (els.mediaEditor) els.mediaEditor.addEventListener('click', onMediaEditorEvent);
if (els.mediaEditor) els.mediaEditor.addEventListener('change', onMediaEditorEvent);
if (els.mediaEditor) els.mediaEditor.addEventListener('input', (e) => {
  if (e.target.getAttribute('data-media-field') !== 'caption') return;
  const row = e.target.closest('[data-media-idx]');
  if (!row) return;
  const m = editorMedia[Number(row.getAttribute('data-media-idx'))];
  if (m) { m.caption = e.target.value || ''; markDirty(); }   // 输入期间不重绘，避免光标/焦点丢失
});
els.mdPreviewToggle.addEventListener('click', toggleMdPreview);
els.askAiBtn.addEventListener('click', async () => {
  els.askAiBtn.disabled = true;
  els.askAiBtn.textContent = '咨询中…';
  try {
    els.fAi.value = await askAI();
    markDirty();
    toast('AI 回答已填入 AI注');
  } catch (err) {
    toast(err.message, 4200);
  } finally {
    els.askAiBtn.disabled = false;
    els.askAiBtn.textContent = '咨询 AI 并填入';
  }
});
els.aiSettingsSave.addEventListener('click', saveAiSettings);
els.editor.addEventListener('input', markDirty);
els.editor.addEventListener('change', markDirty);
window.addEventListener('beforeunload', (e) => {
  if (!dirty || saving) return;
  e.preventDefault();
  e.returnValue = '';
});

/* 启动 */
initEditor().catch((e) => {
  console.error('[editor] 初始化失败', e);
  toast(`编辑器加载失败：${e.message}`, 5000);
});
