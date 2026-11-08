/* folder.js —— 单个文件夹页
 *
 * 20261107 手机端改造：
 *   · 「在此文件夹写笔记」始终可见，空文件夹/仅有子文件夹也有 CTA；
 *   · 新建/编辑跳独立 editor.html，保存后回本文件夹并高亮新记录；
 *   · 卡片操作收进「⋯」面板，避免一排小按钮误触；
 *   · 支持在当前文件夹新建子文件夹。
 */
import {
  getAllNotes, getAllFolderPaths, moveNotesToFolder, deleteNote, setNotePinned, createFolder,
} from './data.js';
import {
  normalizeProject, splitPath, buildTree, directChildren, filterNotes, typeCounts,
} from './folder-util.js';

const $ = (id) => document.getElementById(id);
const P = new URLSearchParams(location.search).get('p') || '';
const SAVED_ID = new URLSearchParams(location.search).get('saved') || '';
let savedHandled = false;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let toastTimer = null;
function toast(msg, ms = 3000) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function typeLabel(key) {
  try {
    const t = window.NoteTypes && window.NoteTypes.getType(key);
    if (t) return `${t.icon} ${t.label}`;
  } catch (e) { /* ignore */ }
  return key;
}

function editBadge(n) {
  if (!n.updatedAt) return '';
  const base = n.date ? new Date(`${n.date}T00:00:00`).getTime() : NaN;
  const diffDays = (Number(n.updatedAt) - base) / 86400000;
  if (!(diffDays >= 1)) return '';
  const td = new Date(Number(n.updatedAt));
  const label = `${String(td.getMonth() + 1).padStart(2, '0')}-${String(td.getDate()).padStart(2, '0')}`;
  return ` · <span class="edit-badge" title="最近内容编辑时间">✎ ${label}</span>`;
}

let notesCache = [];
let folderPath = normalizeProject(P);
let filters = { types: [], q: '', dateFrom: '', dateTo: '' };
let selecting = false;
let moveTargets = [];
let actionTarget = null;
const selected = new Set();

function returnUrl() {
  return `folder.html?p=${encodeURIComponent(folderPath)}`;
}

function editorHref(id = '') {
  const ret = encodeURIComponent(returnUrl());
  return id
    ? `editor.html?id=${encodeURIComponent(id)}&ret=${ret}`
    : `editor.html?type=general&project=${encodeURIComponent(folderPath)}&ret=${ret}`;
}

async function loadData() {
  notesCache = await getAllNotes();
}

function renderHeader() {
  const segs = splitPath(folderPath);
  $('folder-title').textContent = `📁 ${segs[segs.length - 1] || 'other'}`;
  const crumbs = ['<a href="folders.html">笔记</a>'];
  let acc = '';
  segs.forEach((s, i) => {
    acc = acc ? `${acc}/${s}` : s;
    crumbs.push(i === segs.length - 1
      ? `<span>${esc(s)}</span>`
      : `<a href="folder.html?p=${encodeURIComponent(acc)}">${esc(s)}</a>`);
  });
  $('breadcrumb').innerHTML = crumbs.join(' <span class="sep">›</span> ');
}

function renderTypeChips(notes) {
  const counts = typeCounts(notes);
  const items = [['', '全部']].concat(Object.entries(counts).map(([k, v]) => [k, `${typeLabel(k)} ${v}`]));
  $('type-chips').innerHTML = items.map(([k, label]) =>
    `<button type="button" class="btn ghost small type-chip${filters.types.length === 1 && filters.types[0] === k ? ' active' : ''}" data-type-chip="${esc(k)}">${esc(label)}</button>`).join('');
}

function visibleNotes() {
  return filterNotes(notesCache, { ...filters, folder: folderPath, subtree: false })
    .sort((a, b) =>
      (!!b.pinned - !!a.pinned)
      || (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)
      || String(b.date || '').localeCompare(String(a.date || '')));
}

async function render() {
  renderHeader();
  renderTypeChips(filterNotes(notesCache, { folder: folderPath, subtree: false }));

  const allPaths = new Set(notesCache.map((n) => normalizeProject(n.project)));
  const tree = buildTree([...allPaths, folderPath]);
  const kids = directChildren(tree, folderPath);
  const subWrap = $('sub-folders');
  subWrap.innerHTML = '';
  for (const kid of kids) {
    const cnt = filterNotes(notesCache, { folder: kid.path, subtree: true }).length;
    const card = document.createElement('article');
    card.className = 'folder-card';
    card.innerHTML = `<div class="folder-card-head"><span class="folder-icon">📁</span><h3>${esc(kid.name)}</h3></div>
      <p class="folder-card-meta">含子层 ${cnt} 篇</p>`;
    card.addEventListener('click', () => { location.href = `folder.html?p=${encodeURIComponent(kid.path)}`; });
    subWrap.appendChild(card);
  }

  const list = visibleNotes();
  const listEl = $('note-list');
  listEl.innerHTML = '';
  $('empty-state').hidden = list.length > 0 || kids.length > 0;

  for (const n of list) {
    const card = document.createElement('article');
    card.className = 'note-card' + (String(n.id) === String(SAVED_ID) ? ' saved-highlight' : '');
    card.dataset.id = n.id;
    if (selected.has(String(n.id))) card.classList.add('selected');
    const preview = String(n.content || n.readerNote || n.aiNote || '').replace(/\s+/g, ' ').slice(0, 90);
    card.innerHTML = `
      ${selecting ? `<input type="checkbox" class="pick" data-pick="${esc(n.id)}" ${selected.has(String(n.id)) ? 'checked' : ''}>` : ''}
      <div class="note-thumb note-thumb-empty">${esc((window.NoteTypes && NoteTypes.getType(n.type || 'note') || {}).icon || '📝')}</div>
      <div class="note-body">
        <div class="note-meta">${n.pinned ? '📌 ' : ''}${esc(typeLabel(n.type || 'note'))} · ${esc(n.date || '无日期')}${editBadge(n)}${n.book ? ' · 《' + esc(n.book) + '》' : ''}</div>
        <h3 class="note-title">${esc(n.title || '未命名')}</h3>
        ${preview ? `<p class="note-note">${esc(preview)}${String(n.content || '').length > 90 ? '…' : ''}</p>` : ''}
        ${Array.isArray(n.tags) && n.tags.length ? `<div class="note-tags">${n.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
        <div class="card-actions">
          <button class="btn ghost small" data-act="menu" type="button" aria-label="更多操作">⋯ 操作</button>
        </div>
      </div>`;
    card.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (act) { e.stopPropagation(); openCardActionMenu(n); return; }
      if (e.target.closest('[data-pick]')) return;
      if (selecting) {
        const id = String(n.id);
        if (selected.has(id)) selected.delete(id); else selected.add(id);
        card.classList.toggle('selected');
        updateBulkBar();
        return;
      }
      location.href = `note.html?id=${encodeURIComponent(n.id)}`;
    });
    listEl.appendChild(card);
  }

  updateBulkBar();
  if (SAVED_ID && !savedHandled) {
    savedHandled = true;
    const savedCard = Array.from(listEl.querySelectorAll('.note-card')).find((c) => String(c.dataset.id) === String(SAVED_ID));
    if (savedCard) {
      savedCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => savedCard.classList.add('saved-highlight'), 60);
      toast('已保存并返回当前文件夹');
    }
  }
}

function updateBulkBar() {
  $('select-toggle').textContent = selecting ? '✖ 退出多选' : '☑ 多选';
  $('bulk-bar').hidden = !selecting;
  $('select-all').hidden = !selecting;
  $('move-btn').hidden = !selecting;
  $('delete-btn').hidden = !selecting;
  $('bulk-count').textContent = selecting ? `已选 ${selected.size} 篇` : '';
}

/* ── 单篇操作面板 ── */
function openCardActionMenu(n) {
  actionTarget = n;
  $('card-action-title').textContent = n.title || '未命名';
  $('card-action-meta').textContent = `${typeLabel(n.type || 'note')} · ${n.date || '无日期'}`;
  $('card-act-pin').textContent = n.pinned ? '⭐ 取消置顶' : '☆ 置顶';
  $('card-action-panel').hidden = false;
}

async function runCardAction(act) {
  const n = actionTarget;
  if (!n) return;
  $('card-action-panel').hidden = true;
  if (act === 'pin') {
    try {
      await setNotePinned([String(n.id)], !n.pinned);
      await loadData();
      await render();
      toast(n.pinned ? '已取消置顶' : '已置顶，将在列表顶部显示');
    } catch (e) { toast(`置顶操作失败：${e.message}`, 4200); }
  } else if (act === 'edit') {
    location.href = editorHref(n.id);
  } else if (act === 'move') {
    openMovePanel([String(n.id)]);
  } else if (act === 'del') {
    if (!confirm(`删除笔记「${n.title || '未命名'}」？\n此操作不可撤销；其他终端上的同条笔记不受影响（删除不跨端同步）。`)) return;
    try {
      await deleteNote(String(n.id));
      toast('已删除');
      await loadData();
      await render();
    } catch (e) { toast(`删除失败：${e.message}`, 4200); }
  }
}

/* ── 多选/移动 ── */
function toggleSelect() {
  selecting = !selecting;
  if (!selecting) selected.clear();
  render();
}

function selectAllVisible() {
  const list = visibleNotes();
  const allIn = list.every((n) => selected.has(String(n.id)));
  list.forEach((n) => {
    const id = String(n.id);
    if (allIn) selected.delete(id); else selected.add(id);
  });
  render();
}

async function openMovePanel(ids) {
  moveTargets = (ids && ids.length ? ids : [...selected]).map(String);
  if (!moveTargets.length) { toast('请先勾选要移动的笔记'); return; }
  const paths = await getAllFolderPaths();
  $('move-select').innerHTML = paths.map((p) => `<option value="${esc(p)}"${p === folderPath ? ' selected' : ''}>${esc(p)}</option>`).join('');
  $('move-new').value = '';
  $('move-info').textContent = `将移动 ${moveTargets.length} 篇笔记（当前文件夹：${folderPath}）`;
  $('move-panel').hidden = false;
}

async function confirmMove() {
  const newPath = $('move-new').value.trim();
  const target = newPath || $('move-select').value;
  try {
    const { moved, skipped, folder } = await moveNotesToFolder(moveTargets, target, { createIfMissing: !!newPath });
    const skipTxt = skipped ? `（${skipped} 篇已在目标文件夹，跳过）` : '';
    toast(`已移动 ${moved} 篇 → ${folder}${skipTxt}`);
    $('move-panel').hidden = true;
    selected.clear();   // 保持多选模式便于连续整理，仅清空选中
    await loadData();
    await render();
  } catch (e) {
    toast(`移动失败：${e.message}`, 4200);
  }
}

async function createSubfolder() {
  const raw = $('subfolder-path').value.trim();
  try {
    const rec = await createFolder(raw);
    $('subfolder-panel').hidden = true;
    $('subfolder-msg').textContent = '';
    toast(`已创建文件夹：${rec.path}`);
    await loadData();
    await render();
  } catch (e) {
    $('subfolder-msg').textContent = `⚠️ ${e.message}`;
  }
}

/* ── 事件 ── */
$('type-chips').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-type-chip]');
  if (!btn) return;
  const k = btn.dataset.typeChip || '';
  filters.types = k ? [k] : [];
  render();
});
$('search-input').addEventListener('input', (e) => { filters.q = e.target.value; render(); });
$('filter-from').addEventListener('change', (e) => { filters.dateFrom = e.target.value; render(); });
$('filter-to').addEventListener('change', (e) => { filters.dateTo = e.target.value; render(); });
$('filter-bar').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-quick]');
  if (!btn) return;
  const today = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const iso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const kind = btn.dataset.quick;
  if (kind === 'month') { $('filter-from').value = `${iso.slice(0, 8)}01`; $('filter-to').value = iso; }
  else if (kind === 'year') { $('filter-from').value = `${iso.slice(0, 4)}-01-01`; $('filter-to').value = iso; }
  else { $('filter-from').value = ''; $('filter-to').value = ''; }
  filters.dateFrom = $('filter-from').value;
  filters.dateTo = $('filter-to').value;
  render();
});

$('back-btn').addEventListener('click', () => { location.href = 'folders.html'; });
$('new-note-btn').addEventListener('click', () => { location.href = editorHref(); });
$('empty-new-btn').addEventListener('click', () => { location.href = editorHref(); });
$('new-subfolder-btn').addEventListener('click', () => {
  $('subfolder-path').value = `${folderPath}/`;
  $('subfolder-msg').textContent = '';
  $('subfolder-panel').hidden = false;
  setTimeout(() => { $('subfolder-path').focus(); $('subfolder-path').select(); }, 50);
});
$('subfolder-save').addEventListener('click', createSubfolder);
$('subfolder-cancel').addEventListener('click', () => { $('subfolder-panel').hidden = true; });
$('subfolder-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') createSubfolder(); });

$('select-toggle').addEventListener('click', toggleSelect);
$('select-all').addEventListener('click', selectAllVisible);
$('move-btn').addEventListener('click', () => openMovePanel());
$('delete-btn').addEventListener('click', bulkDelete);

$('card-act-pin').addEventListener('click', () => runCardAction('pin'));
$('card-act-edit').addEventListener('click', () => runCardAction('edit'));
$('card-act-move').addEventListener('click', () => runCardAction('move'));
$('card-act-delete').addEventListener('click', () => runCardAction('del'));
$('card-action-cancel').addEventListener('click', () => { $('card-action-panel').hidden = true; });

$('note-list').addEventListener('change', (e) => {
  const cb = e.target.closest('[data-pick]');
  if (!cb) return;
  const id = String(cb.dataset.pick);
  if (cb.checked) selected.add(id); else selected.delete(id);
  const card = cb.closest('.note-card');
  if (card) card.classList.toggle('selected', cb.checked);
  updateBulkBar();
});

async function bulkDelete() {
  if (!selected.size) { toast('请先勾选要删除的笔记'); return; }
  if (!confirm(`删除已选 ${selected.size} 篇笔记？\n此操作不可撤销；其他终端上的相同笔记不受影响（删除不跨端同步）。`)) return;
  try {
    const ids = [...selected];
    for (const id of ids) await deleteNote(id);
    toast(`已删除 ${ids.length} 篇`);
    selected.clear();
    await loadData();
    await render();
  } catch (e) { toast(`删除失败：${e.message}`, 4200); }
}

$('move-cancel').addEventListener('click', () => { $('move-panel').hidden = true; });
$('move-confirm').addEventListener('click', confirmMove);

(async function init() {
  document.title = `${splitPath(folderPath).pop() || 'other'} · 笔记 · 读书笔记`;
  await loadData();
  await render();
})();
