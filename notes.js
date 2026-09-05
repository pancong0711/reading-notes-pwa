/**
 * notes.js —— 笔记页（v2：拍照 + 读者注 + AI注 随手记录）
 *
 * 交互流（对应用户真实使用方式）：
 *   1. 拍一张书页照片（手机调起相机 / 相册选图）
 *   2. 写一点文字（读者注：自己的思考）
 *   3. 跟 AI 咨询（AI注：问 AI 并填入，或粘贴机器人回复）
 *   4. 保存到 IndexedDB
 *
 * 保留导入/导出 JSON（与 CLI 生产端同步）。
 */
import {
  getAllNotes,
  countNotes,
  importNotePackage,
  exportNotePackage,
  addNote,
  deleteNote,
} from './data.js';

const $ = (id) => document.getElementById(id);

const els = {
  count: $('note-count'),
  list: $('note-list'),
  empty: $('empty-state'),
  editor: $('editor'),
  editorTitle: $('editor-title'),
  newBtn: $('new-note-btn'),
  emptyNewBtn: $('empty-new-btn'),
  exportBtn: $('export-btn'),
  importBtn: $('import-btn'),
  importFile: $('import-file'),
  emptyImportBtn: $('empty-import-btn'),
  photoInput: $('photo-input'),
  photoBtn: $('photo-btn'),
  photoPreview: $('photo-preview'),
  fBook: $('f-book'),
  fTitle: $('f-title'),
  fReader: $('f-reader'),
  fAi: $('f-ai'),
  askAiBtn: $('ask-ai-btn'),
  saveBtn: $('save-note-btn'),
  cancelBtn: $('cancel-btn'),
  toast: $('toast'),
};

let editingId = null;   // 正在编辑的笔记 id（null = 新建）
let photoData = '';     // 当前照片的压缩 base64
let notesCache = [];    // 最近一次读取的笔记列表

/* ── 提示 ─────────────────────────────────────────────── */

let toastTimer = null;
function toast(msg, ms = 2600) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
}

/* ── 图片压缩 ─────────────────────────────────────────── */

/** 把图片文件压缩为 ≤maxW 宽度的 JPEG base64（IndexedDB 友好） */
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

/* ── AI 咨询 ──────────────────────────────────────────── */

/**
 * 咨询 AI 并返回回答文本。
 * 服务地址存 localStorage.aiEndpoint（OpenAI 兼容 /chat/completions），
 * 模型存 localStorage.aiModel（默认 deepseek-v4-flash）。
 * 未配置时抛错提示。
 */
async function askAI() {
  const endpoint = localStorage.getItem('aiEndpoint');
  if (!endpoint) {
    throw new Error('未配置 AI 服务地址：请在浏览器控制台设置 localStorage.aiEndpoint（OpenAI 兼容接口地址）');
  }
  const model = localStorage.getItem('aiModel') || 'deepseek-v4-flash';
  const question = els.fReader.value.trim() || '请简要介绍这一页书的内容';
  const payload = {
    model,
    messages: [
      {
        role: 'system',
        content: '你是读书笔记助手。根据书页照片与读者的疑问，给出准确、简洁、条理清晰的中文解答；若图片无法辨识或问题超出依据，请如实说明。',
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

/* ── 列表渲染 ─────────────────────────────────────────── */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function summary(text, len = 60) {
  const t = (text || '').trim().replace(/\s+/g, ' ');
  return t.length > len ? `${t.slice(0, len)}…` : t;
}

function renderList(notes) {
  els.list.innerHTML = '';
  for (const n of notes) {
    const card = document.createElement('article');
    card.className = 'note-card';

    const thumb = n.imageData
      ? `<img class="note-thumb" src="${n.imageData}" alt="书页照片">`
      : `<div class="note-thumb note-thumb-empty">${esc((n.book || '书')[0])}</div>`;

    const readerHtml = n.readerNote
      ? `<p class="note-note reader"><span>读者注</span>${esc(summary(n.readerNote, 80))}</p>` : '';
    const aiHtml = n.aiNote
      ? `<p class="note-note ai"><span>AI注</span>${esc(summary(n.aiNote, 80))}</p>` : '';

    card.innerHTML = `
      ${thumb}
      <div class="note-body">
        <div class="note-meta">${esc(n.book || '未分类')} · ${esc(n.date || '无日期')}</div>
        <h3 class="note-title">${esc(n.title)}</h3>
        ${readerHtml}
        ${aiHtml}
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
  // 笔记页只显示 type='note' 的记录，不混入日记/日志等其它类型
  notesCache = await getAllNotes('note');
  els.count.textContent = `${notesCache.length} 篇`;
  renderList(notesCache);
}

/* ── 编辑器 ───────────────────────────────────────────── */

function openEditor(note = null) {
  editingId = note ? note.id : null;
  photoData = note?.imageData || '';
  els.editorTitle.textContent = note ? '编辑笔记' : '写新笔记';
  els.fBook.value = note?.book || '';
  els.fTitle.value = note?.title || '';
  els.fReader.value = note?.readerNote || '';
  els.fAi.value = note?.aiNote || '';
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
}

async function saveNote() {
  const title = els.fTitle.value.trim();
  if (!title) {
    toast('请填写标题');
    els.fTitle.focus();
    return;
  }
  await addNote({
    id: editingId || undefined,
    title,
    book: els.fBook.value.trim(),
    date: new Date().toISOString().slice(0, 10),
    readerNote: els.fReader.value.trim(),
    aiNote: els.fAi.value.trim(),
    imageData: photoData,
  });
  closeEditor();
  await refresh();
  toast(editingId ? '笔记已更新' : '笔记已保存');
}

/* ── 导入 / 导出 ──────────────────────────────────────── */

async function doImport(file) {
  try {
    const json = JSON.parse(await file.text());
    const n = await importNotePackage(json);
    await refresh();
    toast(`已导入 ${n} 篇笔记`);
  } catch (e) {
    toast(`导入失败：${e.message}`);
  }
}

async function doExport() {
  const pkg = await exportNotePackage();
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `读书笔记-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出笔记包 JSON');
}

/* ── 事件绑定 ─────────────────────────────────────────── */

els.newBtn.addEventListener('click', () => openEditor());
els.emptyNewBtn.addEventListener('click', () => openEditor());
els.cancelBtn.addEventListener('click', closeEditor);
els.saveBtn.addEventListener('click', saveNote);

els.exportBtn.addEventListener('click', doExport);
els.importBtn.addEventListener('click', () => els.importFile.click());
els.emptyImportBtn.addEventListener('click', () => els.importFile.click());
els.importFile.addEventListener('change', () => {
  if (els.importFile.files[0]) doImport(els.importFile.files[0]);
  els.importFile.value = '';
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
  } catch (e) {
    toast(`照片处理失败：${e.message}`);
  }
});

els.askAiBtn.addEventListener('click', async () => {
  els.askAiBtn.disabled = true;
  els.askAiBtn.textContent = '咨询中…';
  try {
    const answer = await askAI();
    els.fAi.value = answer;
    toast('AI 回答已填入 AI注');
  } catch (e) {
    toast(e.message, 4200);
  } finally {
    els.askAiBtn.disabled = false;
    els.askAiBtn.textContent = '咨询 AI 并填入';
  }
});

// 列表事件委托：展开详情 / 编辑 / 删除
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

  // 点击卡片主体 → 展开/收起详情
  const expanded = card.classList.toggle('expanded');
  if (expanded && !card.querySelector('.note-detail')) {
    const detail = document.createElement('div');
    detail.className = 'note-detail';
    const content = note.content || '';
    const reader = note.readerNote ? `<div class="note-sec"><h4>读者注</h4><p>${esc(note.readerNote)}</p></div>` : '';
    const ai = note.aiNote ? `<div class="note-sec"><h4>AI注</h4><p>${esc(note.aiNote)}</p></div>` : '';
    detail.innerHTML = `${content ? `<div class="note-sec"><p>${esc(content)}</p></div>` : ''}${reader}${ai}`;
    card.appendChild(detail);
  } else if (!expanded) {
    card.querySelector('.note-detail')?.remove();
  }
});

/* ── 启动 ─────────────────────────────────────────────── */

// 常用书名供 datalist 提示
const BOOK_HINTS = ['时间简史', '百年孤独'];
for (const b of BOOK_HINTS) {
  const opt = document.createElement('option');
  opt.value = b;
  $('book-list').appendChild(opt);
}

refresh();
