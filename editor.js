/**
 * editor.js —— 独立笔记编辑页
 *
 * 目标（需求 20261107）：
 *   · 列表页不再承载编辑表单；新建/编辑统一进入 editor.html；
 *   · 手机端优先：相机/相册分离、固定保存栏、文件夹上下文、未保存保护与自动草稿；
 *   · 保留原 type.html 编辑器全部字段，并支持图片/音频/视频/文档四类媒体与版式。
 *
 * URL：
 *   editor.html                                新建一般笔记（默认 other）
 *   editor.html?type=note&project=a/b          新建并预填类型/文件夹
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
  putImageFile,
} from './data.js';
import {
  hydrateTypeData, fieldValueForType, snapshotTypeFields, orphanFieldGroups, deleteOrphanField,
} from './type-fields.js';
import { normalizeProject } from './folder-util.js';
import { BUTTONS, wrapSelection, renderPreview } from './md-toolbar.js';
import { typesetInto } from './vendor/mathjax3/mathjax-boot.js';
import { renderHtmlPreviewInto } from './html-doc.js';
import {
  mediaFromMarkdown, mergeMediaLists, normalizeMediaItem, normalizeMediaList,
  applyMediaAttrsToMarkdown, safeMediaSrc,
  insertMarkdownImagesAtCursor, removeMarkdownImageBySrc, markdownHasImageSrc,
  inferMediaKind, mediaExtension, mediaKindLabel, isAllowedMediaFile, isHeicFile,
} from './media-util.js';
import { normalizeDocStyle, styleToCss, FONT_OPTIONS } from './doc-style.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const requestedId = params.get('id') || params.get('edit') || '';
const draftKey = requestedId ? `note:${requestedId}` : 'new';
const DEFAULT_TYPE = 'general';

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
  photoVideoInput: $('photo-input-video'),
  photoGalleryInput: $('photo-input-gallery'),
  mediaFileInput: $('media-input-file'),
  photoCameraBtn: $('photo-camera-btn'),
  photoGalleryBtn: $('photo-gallery-btn'),
  audioRecordBtn: $('audio-record-btn'),
  mediaFileBtn: $('media-file-btn'),
  audioRecordStatus: $('audio-record-status'),
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
  insertImageBtn: $('insert-image-btn'),
  mdColorInput: $('md-color-input'),
  orphanFieldsField: $('orphan-fields-field'),
  orphanFields: $('orphan-fields'),
  fFirstLineIndent: $('f-first-line-indent'),
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
let mediaSources = [];       // 当前编辑中的媒体源（Blob 仓相对路径或旧 dataURL）
let typeData = {};           // 各类型字段快照：切换类型不丢
let extensionFields = {};    // 当前类型 schema 之外的标量扩展字段
let mediaSeq = 0;
const mediaPreviewMap = new Map();   // 新插入媒体的即时预览 URL（不写入 JSON）
let clearedLegacyFields = new Set();  // orphan 删除后需同步清掉的旧兼容字段
let audioRecorder = null;
let audioChunks = [];
let audioRecordStream = null;
let audioRecordTimer = null;
let audioRecordStartedAt = 0;
let longPressTimer = null;
let cameraLongPressed = false;
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

/* ── 图片压缩 / HEIC 兼容转换 / 媒体管理 ── */
function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片解析失败（可能是浏览器不支持的格式）'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(blob);
  });
}

function imageToJpegDataUrl(img, maxSide = 1600, quality = 0.86) {
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
  return canvas.toDataURL('image/jpeg', quality);
}

let _heic2anyPromise = null;
function loadHeic2Any() {
  if (typeof window !== 'undefined' && typeof window.heic2any === 'function') return Promise.resolve(window.heic2any);
  if (_heic2anyPromise) return _heic2anyPromise;
  _heic2anyPromise = new Promise((resolve, reject) => {
    const src = new URL('./vendor/heic2any.min.js', import.meta.url).href;
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => {
      if (typeof window.heic2any === 'function') resolve(window.heic2any);
      else reject(new Error('HEIC 转换组件加载后不可用'));
    };
    script.onerror = () => reject(new Error('HEIC 转换组件加载失败'));
    document.head.appendChild(script);
  });
  return _heic2anyPromise;
}

async function heicToJpegBlob(file, quality = 0.86) {
  const heic2any = await loadHeic2Any();
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality, multiple: false });
  const blob = Array.isArray(out) ? out[0] : out;
  if (!blob || !String(blob.type || '').startsWith('image/')) throw new Error('HEIC 转换结果不是图片');
  return blob;
}

async function compressImage(file, maxSide = 1600, quality = 0.86) {
  try {
    const img = await loadImageFromBlob(file);
    return imageToJpegDataUrl(img, maxSide, quality);
  } catch (err) {
    if (!isHeicFile(file)) throw err;
    // 鸿蒙/部分 Android 浏览器不能原生解码 HEIC/HEIF：本地 WASM 转 JPEG 后再压缩。
    const jpegBlob = await heicToJpegBlob(file, quality);
    const img = await loadImageFromBlob(jpegBlob);
    return imageToJpegDataUrl(img, maxSide, quality);
  }
}

function uniqueSrcs(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const src = String(raw || '').trim();
    if (!src || seen.has(src)) continue;
    seen.add(src);
    out.push(src);
  }
  return out;
}

function syncMediaSources() {
  mediaSources = uniqueSrcs(mediaSources.filter((src) => safeMediaSrc(src)));
  const oldBySrc = new Map(editorMedia.map((m) => [m.src, m]));
  editorMedia = mediaSources.map((src, i) => {
    const old = oldBySrc.get(src);
    const m = old || normalizeMediaItem({ src, kind: inferMediaKind(src) }, i);
    m.src = src;
    if (!m.alt) m.alt = m.name || `${mediaKindLabel(m.kind)} ${i + 1}`;
    return m;
  });
}

function sourceLabel(i, kind = 'image') {
  return `${mediaKindLabel(kind)} ${i + 1}`;
}

function displayMediaSrc(src) {
  return mediaPreviewMap.get(src) || src;
}

function mediaIcon(kind) {
  return ({ image: '🖼', audio: '🎙', video: '🎬', file: '📎' })[kind] || '📎';
}

function renderMediaStrip() {
  if (!mediaSources.length) {
    els.photoStrip.innerHTML = '<p class="muted photo-empty">还没有媒体附件。</p>';
  } else {
    els.photoStrip.innerHTML = mediaSources.map((src, i) => {
      const m = editorMedia[i] || normalizeMediaItem({ src, kind: inferMediaKind(src) }, i);
      const label = m.name || m.alt || sourceLabel(i, m.kind);
      const inBody = markdownHasImageSrc(els.fContent?.value || '', src);
      const srcView = safeMediaSrc(displayMediaSrc(src));
      const preview = m.kind === 'image' && srcView
        ? `<img src="${esc(srcView)}" alt="${esc(label)}">`
        : `<div class="media-file-thumb" aria-hidden="true">${mediaIcon(m.kind)}</div>`;
      return `
      <figure class="photo-thumb media-thumb-card" data-media-idx="${i}">
        ${preview}
        <figcaption>
          <span title="${esc(label)}">${mediaIcon(m.kind)} ${esc(label)}</span>
          <span class="photo-thumb-actions">
            <button type="button" class="btn ghost small" data-media-insert="${i}" ${inBody ? 'disabled' : ''}>${inBody ? '已在正文' : '插入正文'}</button>
            <button type="button" class="btn ghost small danger" data-media-remove="${i}" aria-label="移除${esc(mediaKindLabel(m.kind))} ${i + 1}">移除</button>
          </span>
        </figcaption>
      </figure>`;
    }).join('');
  }
  if (els.photoHint) {
    els.photoHint.textContent = mediaSources.length
      ? `已添加 ${mediaSources.length} 个媒体附件；新附件会自动插入光标处，旧附件可点「插入正文」。`
      : '图片压缩保存；音频/视频/文档按原文件保存。可从相册、本机文件、相机或麦克风添加。';
  }
  renderMediaEditor();
}

function generateMediaPath(kind, mime, name) {
  mediaSeq += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  const ext = mediaExtension(kind, mime, name);
  return `assets/pwa-${kind}-${Date.now()}-${mediaSeq}-${rand}.${ext}`;
}

const MAX_MEDIA_BYTES = 80 * 1024 * 1024;

function objectUrlFor(blob) {
  try { return URL.createObjectURL(blob); } catch { return ''; }
}

async function prepareMediaFile(file) {
  if (!file) throw new Error('文件为空');
  if (file.size > MAX_MEDIA_BYTES) throw new Error(`文件超过 ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB 上限`);
  if (!isAllowedMediaFile(file)) throw new Error('不支持该文件类型（拒绝 HTML/SVG/脚本等可执行内容）');
  const kind = inferMediaKind(file.name, file.type);
  let path = '';
  let mime = String(file.type || '');
  let size = Number(file.size || 0);
  if (kind === 'image') {
    // HEIC/HEIF 统一转 JPEG 后落仓，路径也固定为 .jpg，确保所有渲染端可用。
    const dataUrl = await compressImage(file);
    mime = 'image/jpeg';
    path = generateMediaPath('image', mime, file.name);
    await putImageFile(path, dataUrl);
    mediaPreviewMap.set(path, dataUrl);
    size = Math.round((dataUrl.length * 3) / 4);
  } else {
    path = generateMediaPath(kind, file.type, file.name);
    await putImageFile(path, file);
    if (kind === 'audio' || kind === 'video') {
      const url = objectUrlFor(file);
      if (url) mediaPreviewMap.set(path, url);
    }
  }
  return normalizeMediaItem({
    kind,
    src: path,
    name: file.name || sourceLabel(mediaSources.length, kind),
    alt: file.name || '',
    mime,
    size,
    caption: '',
  }, mediaSources.length);
}

function insertMediaItemsIntoBody(items) {
  const list = (items || []).filter((m) => m && m.src);
  if (!list.length) return;
  for (const m of list) {
    if (!mediaSources.includes(m.src)) mediaSources.push(m.src);
    if (!editorMedia.some((x) => x.src === m.src)) editorMedia.push(normalizeMediaItem(m, editorMedia.length));
  }
  syncMediaSources();
  const inserted = list.map((m) => {
    const found = editorMedia.find((x) => x.src === m.src) || m;
    return { ...found, src: m.src, alt: found.alt || found.name || '', caption: found.caption || '' };
  });
  const r = insertMarkdownImagesAtCursor(
    els.fContent.value,
    els.fContent.selectionStart || 0,
    els.fContent.selectionEnd || 0,
    inserted,
  );
  els.fContent.value = r.value;
  els.fContent.focus();
  els.fContent.setSelectionRange(r.selStart, r.selEnd);
  renderMediaStrip();
  markDirty();
}

async function addMediaFiles(files) {
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) {
    toast('没有读取到文件；若系统选择器只允许单选，请重新打开「相册（可多选）」后长按/勾选多张', 5200);
    return;
  }
  if (editorFormat !== 'markdown') {
    toast('请先将正文格式切换为 Markdown，再插入媒体', 4200);
    return;
  }
  const added = [];
  const failures = [];
  toast(`正在处理 ${list.length} 个文件…`, 1800);
  for (const file of list) {
    try {
      added.push(await prepareMediaFile(file));
    } catch (e) {
      failures.push(`${file.name || '文件'}：${e.message}`);
    }
  }
  if (added.length) {
    insertMediaItemsIntoBody(added);
    const kinds = added.reduce((acc, m) => { acc[m.kind] = (acc[m.kind] || 0) + 1; return acc; }, {});
    toast(`已插入 ${Object.entries(kinds).map(([k, n]) => `${n} 个${mediaKindLabel(k)}`).join('、')}到光标处`);
  }
  if (failures.length) {
    console.error('[editor] 媒体处理失败:', failures);
    toast(`部分文件失败：${failures.slice(0, 2).join('；')}`, 6200);
  }
}

function insertMediaAtCursor(index) {
  const i = Number(index);
  const src = mediaSources[i];
  if (!src) return;
  if (editorFormat !== 'markdown') { toast('请先将正文格式切换为 Markdown', 4200); return; }
  if (markdownHasImageSrc(els.fContent.value, src)) { toast('这个媒体已在正文中'); return; }
  const m = editorMedia[i] || normalizeMediaItem({ src, kind: inferMediaKind(src) }, i);
  const r = insertMarkdownImagesAtCursor(
    els.fContent.value,
    els.fContent.selectionStart || 0,
    els.fContent.selectionEnd || 0,
    [{ ...m, src, alt: m.alt || m.name || sourceLabel(i, m.kind), caption: m.caption || '' }],
  );
  els.fContent.value = r.value;
  els.fContent.focus();
  els.fContent.setSelectionRange(r.selStart, r.selEnd);
  renderMediaStrip();
  markDirty();
  toast('已插入正文');
}

function syncMediaAttrsToContent() {
  if (!els.fContent || editorFormat !== 'markdown') return;
  const next = applyMediaAttrsToMarkdown(els.fContent.value, editorMedia);
  if (next !== els.fContent.value) els.fContent.value = next;
}

function removeMedia(index) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= mediaSources.length) return;
  const src = mediaSources[i];
  mediaSources.splice(i, 1);
  editorMedia = editorMedia.filter((m) => m.src !== src);
  mediaPreviewMap.delete(src);
  if (editorFormat === 'markdown') {
    els.fContent.value = removeMarkdownImageBySrc(els.fContent.value, src);
  }
  syncMediaSources();
  renderMediaStrip();
  markDirty();
}

/* ── 麦克风录音 ── */
function chooseAudioMime() {
  const C = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  if (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function') {
    return C.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  }
  return '';
}

function updateAudioRecordStatus() {
  if (!els.audioRecordStatus) return;
  if (!audioRecorder) { els.audioRecordStatus.hidden = true; return; }
  const sec = Math.max(0, Math.floor((Date.now() - audioRecordStartedAt) / 1000));
  els.audioRecordStatus.hidden = false;
  els.audioRecordStatus.textContent = `● 正在录音 ${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}，再点「录音」停止`;
}

function cleanupAudioRecording() {
  if (audioRecordTimer) clearInterval(audioRecordTimer);
  audioRecordTimer = null;
  if (audioRecordStream) {
    audioRecordStream.getTracks().forEach((tr) => { try { tr.stop(); } catch { /* ignore */ } });
  }
  audioRecordStream = null;
  audioRecorder = null;
  if (els.audioRecordBtn) {
    els.audioRecordBtn.classList.remove('recording');
    els.audioRecordBtn.textContent = '🎙 录音';
  }
  if (els.audioRecordStatus) els.audioRecordStatus.hidden = true;
}

async function addRecordedAudio(blob, mime) {
  const path = generateMediaPath('audio', mime, 'recording.webm');
  await putImageFile(path, blob);
  const url = objectUrlFor(blob);
  if (url) mediaPreviewMap.set(path, url);
  const n = mediaSources.filter((src) => (editorMedia.find((m) => m.src === src)?.kind) === 'audio').length + 1;
  const item = normalizeMediaItem({
    kind: 'audio', src: path, name: `录音 ${n}`, alt: `录音 ${n}`, mime, size: blob.size, caption: '',
  }, mediaSources.length);
  insertMediaItemsIntoBody([item]);
  toast('录音已插入正文');
}

async function toggleAudioRecording() {
  if (editorFormat !== 'markdown') { toast('请先将正文格式切换为 Markdown，再插入录音', 4200); return; }
  if (audioRecorder) {
    try { audioRecorder.stop(); } catch { cleanupAudioRecording(); }
    return;
  }
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function' || typeof MediaRecorder === 'undefined') {
    toast('当前浏览器不支持录音，或页面不是 HTTPS/localhost 安全环境', 5200);
    return;
  }
  try {
    audioRecordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    const mime = chooseAudioMime();
    const rec = new MediaRecorder(audioRecordStream, mime ? { mimeType: mime } : undefined);
    audioRecorder = rec;
    audioRecordStartedAt = Date.now();
    rec.ondataavailable = (e) => { if (e.data && e.data.size) audioChunks.push(e.data); };
    rec.onstop = async () => {
      const type = rec.mimeType || mime || 'audio/webm';
      const blob = new Blob(audioChunks, { type });
      const chunks = audioChunks.slice();
      audioChunks = [];
      cleanupAudioRecording();
      if (chunks.length) {
        try { await addRecordedAudio(blob, type); } catch (e) { toast(`录音保存失败：${e.message}`, 5200); }
      }
    };
    rec.start();
    els.audioRecordBtn.classList.add('recording');
    els.audioRecordBtn.textContent = '⏹ 停止录音';
    updateAudioRecordStatus();
    audioRecordTimer = setInterval(updateAudioRecordStatus, 1000);
  } catch (e) {
    cleanupAudioRecording();
    toast(`无法启动录音：${e.message || '麦克风权限被拒绝'}`, 5200);
  }
}

function bindLongPress(button, onTap, onLong) {
  if (!button) return;
  let timer = null;
  let firedLong = false;
  const clear = () => { if (timer) clearTimeout(timer); timer = null; };
  button.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    firedLong = false;
    clear();
    timer = setTimeout(() => {
      firedLong = true;
      try { if (navigator.vibrate) navigator.vibrate(30); } catch { /* ignore */ }
      onLong();
    }, 650);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => button.addEventListener(ev, clear));
  button.addEventListener('contextmenu', (e) => e.preventDefault());
  button.addEventListener('click', (e) => {
    if (firedLong) { e.preventDefault(); firedLong = false; return; }
    onTap();
  });
}

/* ── 类型字段 ── */
function fillTypeOptions(selectedKey) {
  if (!els.fType) return;
  els.fType.innerHTML = NoteTypes.getTypes(false)
    .map((t) => `<option value="${esc(t.key)}"${t.key === selectedKey ? ' selected' : ''}>${esc(t.icon + ' ' + t.label)}</option>`)
    .join('');
}

function selectedTypeDef() {
  const key = (els.fType && els.fType.value) || currentType?.key || DEFAULT_TYPE;
  return NoteTypes.getType(key) || NoteTypes.getType(DEFAULT_TYPE) || currentType;
}

function readCurrentTypeValues(typeDef = selectedTypeDef()) {
  const out = {};
  for (const f of typeDef?.fields || []) {
    const el = $(`f-${f}`);
    if (!el) continue;
    if (el.type === 'checkbox') out[f] = !!el.checked;
    else out[f] = el.value;
  }
  return out;
}

function captureActiveTypeFields(typeDef = currentType || selectedTypeDef()) {
  if (!typeDef || !typeDef.key) return;
  typeData = snapshotTypeFields(typeData, typeDef, readCurrentTypeValues(typeDef));
}

function buildTypeFields(rec, typeDef = selectedTypeDef()) {
  if (!els.typeFields || !typeDef) return;
  const existing = rec || {};
  els.typeFields.innerHTML = '';
  for (const f of typeDef.fields || []) {
    const metaInfo = NoteTypes.fieldMeta(f);
    const value = fieldValueForType(typeData, typeDef.key, f, existing);
    const field = document.createElement('label');
    field.className = 'field';
    if (metaInfo.type === 'checkbox') {
      field.innerHTML = `<span class="field-head"><span>${esc(metaInfo.label)}</span></span>`;
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = !!value;
      chk.id = `f-${f}`;
      chk.className = 'field-check';
      field.appendChild(chk);
    } else {
      field.innerHTML = `<span>${esc(metaInfo.label)}</span>`;
      const input = document.createElement('input');
      input.type = metaInfo.type || 'text';
      input.placeholder = metaInfo.placeholder || '';
      input.id = `f-${f}`;
      input.value = value == null ? '' : String(value);
      field.appendChild(input);
    }
    els.typeFields.appendChild(field);
  }
}

function collectTypeFields(rec, typeDef = selectedTypeDef()) {
  const out = { meta: { ...((rec && rec.meta) || {}) } };
  const values = readCurrentTypeValues(typeDef);
  for (const f of typeDef.fields || []) {
    const v = Object.prototype.hasOwnProperty.call(values, f) ? values[f] : fieldValueForType(typeData, typeDef.key, f, rec);
    if (f === 'book') out.book = String(v || '').trim();
    else if (f === 'pages') out.pages = String(v || '').trim();
    else if (f === 'done') out.meta.done = !!v;
    else if (f === 'due') out.meta.due = String(v || '');
    else out.meta[f] = v;
  }
  return out;
}

function typeLabelOf(key) {
  const t = NoteTypes.getType(String(key || ''));
  return t ? `${t.icon || '📝'} ${t.label}` : String(key || '未知类型');
}

function renderOrphanFields() {
  if (!els.orphanFields || !els.orphanFieldsField) return;
  const groups = orphanFieldGroups(typeData, extensionFields, selectedTypeDef(), typeLabelOf);
  if (!groups.length) {
    els.orphanFieldsField.hidden = true;
    els.orphanFields.innerHTML = '';
    return;
  }
  els.orphanFieldsField.hidden = false;
  els.orphanFields.innerHTML = groups.map((g) => {
    const rows = g.items.map((it) => {
      const val = it.value == null ? '' : String(it.value);
      return `<div class="orphan-field-row">
        <code>${esc(it.key)}</code><span>${esc(val || '（空）')}</span>
        <button type="button" class="btn ghost small danger" data-orphan-delete="1"
          data-orphan-kind="${esc(g.kind)}" data-orphan-type="${esc(g.typeKey || '')}" data-orphan-key="${esc(it.key)}">删除</button>
      </div>`;
    }).join('');
    return `<div class="orphan-field-group"><div class="orphan-field-group-name">${esc(g.label)}</div>${rows}</div>`;
  }).join('');
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
  const typeKey = selectedTypeDef()?.key || DEFAULT_TYPE;
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
  const raw = m.id === 'imageData' && (!m.src || m.src === 'imageData') ? (mediaSources[0] || '') : (m.src || '');
  return safeMediaSrc(displayMediaSrc(raw));
}

function renderMediaEditor() {
  if (!els.mediaEditor || !els.mediaEditorField) return;
  const visible = editorMedia.filter((m) => mediaPreviewSrc(m));
  els.mediaEditorField.hidden = !visible.length;
  els.mediaEditor.innerHTML = visible.map((m, i) => {
    const idx = editorMedia.indexOf(m);
    const src = mediaPreviewSrc(m);
    const label = m.name || m.alt || sourceLabel(i, m.kind);
    let preview = `<div class="media-file-thumb" aria-hidden="true">${mediaIcon(m.kind)}</div>`;
    if (m.kind === 'image') preview = `<img class="media-thumb" src="${esc(src)}" alt="${esc(label)}">`;
    else if (m.kind === 'audio') preview = `<audio class="media-thumb-audio" controls preload="metadata" src="${esc(src)}"></audio>`;
    else if (m.kind === 'video') preview = `<video class="media-thumb-video" controls playsinline preload="metadata" src="${esc(src)}"></video>`;
    const rotateControls = (m.kind === 'image' || m.kind === 'video')
      ? `<button type="button" class="btn ghost small" data-media-act="rotate-left" title="向左旋转 90°">⟲</button>
         <button type="button" class="btn ghost small" data-media-act="rotate-right" title="向右旋转 90°">⟳</button>`
      : '';
    const layoutControls = (m.kind === 'image' || m.kind === 'video')
      ? `<label>宽度 <select data-media-field="width">
            ${[25, 50, 75, 100].map((w) => `<option value="${w}"${m.widthPercent === w ? ' selected' : ''}>${w}%</option>`).join('')}
          </select></label>
          <label>对齐 <select data-media-field="align">
            ${[['left', '左'], ['center', '中'], ['right', '右']].map(([v, l]) => `<option value="${v}"${m.align === v ? ' selected' : ''}>${l}</option>`).join('')}
          </select></label>`
      : '';
    return `<div class="media-row media-row-${esc(m.kind)}" data-media-idx="${idx}">
      ${preview}
      <div class="media-meta">
        <div class="media-name">${mediaIcon(m.kind)} ${esc(label)} <span class="muted">(${esc(mediaKindLabel(m.kind))}${m.size ? ` · ${Math.max(1, Math.round(m.size / 1024))} KB` : ''})</span></div>
        <div class="media-controls">
          ${rotateControls}${layoutControls}
          <button type="button" class="btn ghost small" data-media-act="reset">重置版式</button>
        </div>
        <input class="media-caption" data-media-field="caption" value="${esc(m.caption || '')}" placeholder="说明/图注（显示在附件下方，可选）">
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
  syncMediaAttrsToContent();
  renderMediaEditor();
  markDirty();
}

/* ── 文档样式 / 格式 ── */
function initDocStyleOptions() {
  if (!els.fFont) return;
  els.fFont.innerHTML = FONT_OPTIONS.map((f) => `<option value="${f.value}">${f.label}</option>`).join('');
  els.fFont.value = docStyle.font;
  if (els.fFirstLineIndent) els.fFirstLineIndent.value = docStyle.firstLineIndent;
}

function applyDocStyleToControls() {
  if (els.fFont) els.fFont.value = docStyle.font;
  if (els.fAlign) els.fAlign.value = docStyle.align;
  if (els.fLineHeight) els.fLineHeight.value = docStyle.lineHeight;
  if (els.fFirstLineIndent) els.fFirstLineIndent.value = docStyle.firstLineIndent;
}

function readDocStyle() {
  docStyle = normalizeDocStyle({
    font: els.fFont?.value,
    align: els.fAlign?.value,
    lineHeight: els.fLineHeight?.value,
    firstLineIndent: els.fFirstLineIndent?.value,
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
  captureActiveTypeFields(typeDef);
  const fields = collectTypeFields(originalRecord, typeDef);
  return {
    editingId,
    type: typeDef?.key || DEFAULT_TYPE,
    title: els.fTitle?.value || '',
    date: els.fDate?.value || '',
    tags: els.fTags?.value || '',
    content: els.fContent?.value || '',
    contentFormat: els.fFormat?.value || editorFormat || 'markdown',
    project: els.fProject?.value || 'other',
    readerNote: els.fReader?.value || '',
    aiNote: els.fAi?.value || '',
    photos: mediaSources.slice(),
    media: editorMedia.map((m) => ({ ...m })),
    style: { ...docStyle },
    concepts: [...selectedConcepts.entries()].map(([id, source]) => ({ id, source: source || 'user' })),
    book: fields.book || '',
    pages: fields.pages || '',
    meta: fields.meta || {},
    typeData: JSON.parse(JSON.stringify(typeData || {})),
    extensions: { ...(extensionFields || {}) },
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
  mediaSources = Array.isArray(draft.photos) ? draft.photos.filter((x) => typeof x === 'string') : [];
  editorMedia = normalizeMediaList(draft.media || []);
  syncMediaSources();
  docStyle = normalizeDocStyle(draft.style || {});
  applyDocStyleToControls();
  selectedConcepts = new Map((draft.concepts || []).map((c) => [String(c.id || ''), String(c.source || 'user')]).filter(([id]) => id));
  typeData = hydrateTypeData({
    type: draft.type || currentType?.key || DEFAULT_TYPE,
    typeData: draft.typeData || {},
    extensions: draft.extensions || {},
    book: draft.book || '', pages: draft.pages || '', meta: draft.meta || {},
  }).typeData;
  extensionFields = hydrateTypeData({ extensions: draft.extensions || {} }).extensions;
  buildTypeFields({ book: draft.book || '', pages: draft.pages || '', meta: draft.meta || {} }, selectedTypeDef());
  renderOrphanFields();
  setProject(draft.project || 'other');
  renderMediaStrip();
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
          ...editorMedia.filter((m) => m.kind === 'image').map((m) => ({ type: 'image_url', image_url: { url: m.src } })),
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
  currentType = NoteTypes.getType(rec?.type || params.get('type') || DEFAULT_TYPE) || NoteTypes.getType(DEFAULT_TYPE);
  fillTypeOptions(currentType.key);
  const hydrated = hydrateTypeData(rec || { type: currentType.key });
  typeData = hydrated.typeData;
  extensionFields = hydrated.extensions;

  const contentMedia = mediaFromMarkdown(rec?.content || '');
  const srcs = [];
  if (rec?.imageData) srcs.push(rec.imageData);
  for (const src of (rec?.images || [])) srcs.push(src);
  for (const m of (rec?.media || [])) {
    if (m && m.src && m.src !== 'imageData') srcs.push(m.src);
  }
  for (const m of contentMedia) srcs.push(m.src);
  mediaSources = uniqueSrcs(srcs.filter((src) => safeMediaSrc(src)));
  editorMedia = mergeMediaLists(
    rec?.media,
    mediaSources.map((src, i) => normalizeMediaItem({ id: src.startsWith('data:image/') ? 'imageData' : `media_${i + 1}`, src, kind: inferMediaKind(src), alt: `${mediaKindLabel(inferMediaKind(src))} ${i + 1}` }, i)),
    contentMedia,
  );
  syncMediaSources();

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
  renderOrphanFields();
  setProject(rec?.project || params.get('project') || 'other');
  els.editorTitle.textContent = rec ? '编辑笔记' : '新建笔记';
  document.title = `${rec ? '编辑' : '新建'}笔记 · 读书笔记`;
  els.saveStatus.textContent = rec ? '已载入' : '';
  renderMediaStrip();
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
    captureActiveTypeFields(typeDef);
    const title = els.fTitle.value.trim();
    const date = els.fDate.value || todayStr();
    const fields = collectTypeFields(originalRecord, typeDef);
    const existing = originalRecord || (editingId ? await getNoteById(editingId) : null);
    const imageMedia = editorMedia.filter((m) => m.kind === 'image');
    const dataPhoto = imageMedia.find((m) => String(m.src).startsWith('data:image/'))?.src || '';
    const images = imageMedia.map((m) => m.src).filter((v) => v && v !== dataPhoto);
    const rec = {
      ...existing,
      id: editingId || undefined,
      type: typeDef?.key || DEFAULT_TYPE,
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
      imageData: dataPhoto,
      images,
      typeData: JSON.parse(JSON.stringify(typeData || {})),
      extensions: { ...(extensionFields || {}) },
      updatedAt: Date.now(),
      ...fields,
    };
    // orphan 字段删除：若当前类型未重新提供对应值，同步清掉旧兼容路径，避免下次加载又被回填。
    if (clearedLegacyFields.has('book') && !Object.prototype.hasOwnProperty.call(fields, 'book')) rec.book = '';
    if (clearedLegacyFields.has('pages') && !Object.prototype.hasOwnProperty.call(fields, 'pages')) rec.pages = '';
    if (clearedLegacyFields.has('done') && !(typeDef.fields || []).includes('done')) delete rec.meta.done;
    if (clearedLegacyFields.has('due') && !(typeDef.fields || []).includes('due')) delete rec.meta.due;
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

bindLongPress(els.photoCameraBtn,
  () => els.photoCameraInput.click(),
  () => els.photoVideoInput.click());
els.photoGalleryBtn.addEventListener('click', () => els.photoGalleryInput.click());
if (els.mediaFileBtn) els.mediaFileBtn.addEventListener('click', () => els.mediaFileInput.click());
if (els.audioRecordBtn) els.audioRecordBtn.addEventListener('click', toggleAudioRecording);
function consumeInputFiles(input) {
  const files = Array.from(input.files || []);
  // 先清空 input，再异步处理：部分移动浏览器在切后台/文件选择器关闭后会清空 FileList。
  input.value = '';
  return files;
}
els.photoCameraInput.addEventListener('change', async () => {
  await addMediaFiles(consumeInputFiles(els.photoCameraInput));
});
els.photoVideoInput.addEventListener('change', async () => {
  await addMediaFiles(consumeInputFiles(els.photoVideoInput));
});
els.photoGalleryInput.addEventListener('change', async () => {
  await addMediaFiles(consumeInputFiles(els.photoGalleryInput));
});
els.mediaFileInput.addEventListener('change', async () => {
  await addMediaFiles(consumeInputFiles(els.mediaFileInput));
});
els.photoStrip.addEventListener('click', (e) => {
  const removeBtn = e.target.closest('[data-media-remove]');
  if (removeBtn) { removeMedia(removeBtn.getAttribute('data-media-remove')); return; }
  const insertBtn = e.target.closest('[data-media-insert]');
  if (insertBtn) insertMediaAtCursor(insertBtn.getAttribute('data-media-insert'));
});

els.fType.addEventListener('change', () => {
  captureActiveTypeFields();
  const def = selectedTypeDef();
  currentType = def;
  buildTypeFields(originalRecord, def);
  renderOrphanFields();
  renderConceptSelector();
  els.editorTitle.textContent = editingId ? '编辑笔记' : '新建笔记';
  markDirty();
});
els.mdToolbar.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-md]');
  if (btn) onMdBtn(btn.getAttribute('data-md'));
});
if (els.insertImageBtn) els.insertImageBtn.addEventListener('click', () => {
  if (editorFormat !== 'markdown') { toast('请先将正文格式切换为 Markdown', 4200); return; }
  els.mediaFileInput.click();
});
if (els.mdColorInput) {
  els.mdColorInput.addEventListener('change', () => {
    if (editorFormat !== 'markdown') { toast('逐字颜色仅适用于 Markdown 正文', 4200); return; }
    const cfg = { span: { color: els.mdColorInput.value }, placeholder: '彩色文字' };
    const r = wrapSelection(els.fContent.value, els.fContent.selectionStart || 0, els.fContent.selectionEnd || 0, cfg);
    els.fContent.value = r.value;
    els.fContent.focus();
    els.fContent.setSelectionRange(r.selStart, r.selEnd);
    markDirty();
  });
}
if (els.orphanFields) {
  els.orphanFields.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-orphan-delete]');
    if (!btn) return;
    const kind = btn.getAttribute('data-orphan-kind');
    const typeKey = btn.getAttribute('data-orphan-type');
    const key = btn.getAttribute('data-orphan-key');
    if (!confirm(`删除字段「${key}」及其值？保存后生效。`)) return;
    const r = deleteOrphanField(typeData, extensionFields, kind, typeKey, key);
    if (!r.deleted) { toast('该字段不能从这里删除'); return; }
    typeData = r.typeData;
    extensionFields = r.extensions;
    if (kind === 'type' && typeKey === 'note' && (key === 'book' || key === 'pages')) {
      clearedLegacyFields.add(key);
      if (originalRecord && currentType?.key !== 'note') originalRecord[key] = '';
    }
    if (kind === 'type' && typeKey === 'memo' && (key === 'done' || key === 'due')) {
      clearedLegacyFields.add(key);
      if (originalRecord && currentType?.key !== 'memo') {
        originalRecord.meta = { ...(originalRecord.meta || {}) };
        delete originalRecord.meta[key];
      }
    }
    if (kind === 'extension' && originalRecord?.meta) {
      originalRecord.meta = { ...originalRecord.meta };
      delete originalRecord.meta[key];
    }
    renderOrphanFields();
    markDirty();
    toast('已移除字段，保存后写入');
  });
}
if (els.fFormat) els.fFormat.addEventListener('change', () => { syncFormatUi(); markDirty(); });
[els.fFont, els.fAlign, els.fLineHeight, els.fFirstLineIndent].forEach((el) => {
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
  if (m) {
    m.caption = e.target.value || '';
    m.alt = m.caption || m.alt || '图片';
    syncMediaAttrsToContent();
    markDirty();
  }   // 输入期间不重绘，避免光标/焦点丢失
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
  cleanupAudioRecording();
  if (!dirty || saving) return;
  e.preventDefault();
  e.returnValue = '';
});
// 页面进入后台/隐藏时停止麦克风，避免持续占用
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && audioRecorder) {
    try { audioRecorder.stop(); } catch { cleanupAudioRecording(); }
  }
});

/* 启动 */
initEditor().catch((e) => {
  console.error('[editor] 初始化失败', e);
  toast(`编辑器加载失败：${e.message}`, 5000);
});
