/* folder.js —— 单个文件夹页（需求 20260911 ⑤⑥）
 *
 * ?p=<路径>：显示该文件夹的 子文件夹卡片 + 直属笔记（跨类型）
 *   · 顶部「← 返回笔记目录」+ 面包屑（可点每级跳转）
 *   · 筛选：类型 chips + 搜索 + 日期区间（复用 folder-util.filterNotes）
 *   · 多选（☑ 多选 / 全选）→「移动到文件夹」（选已有 或 新建并移入）
 *   · 点笔记卡片 → note.html?id= 详情页
 */
import {
  getAllNotes, getAllFolderPaths, moveNotesToFolder, getConceptCatalog,
} from './data.js';
import {
  normalizeProject, splitPath, buildTree, directChildren, filterNotes, typeCounts,
} from './folder-util.js';

const $ = (id) => document.getElementById(id);
const P = new URLSearchParams(location.search).get('p') || '';

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

let notesCache = [];
let conceptCatalog = [];
let folderPath = normalizeProject(P);
let filters = { types: [], q: '', dateFrom: '', dateTo: '' };
let selecting = false;
const selected = new Set();

/* ── 数据 ── */

async function loadData() {
  notesCache = await getAllNotes();
  try {
    const cat = await getConceptCatalog();
    conceptCatalog = (cat && cat.concepts) || [];
  } catch (e) { conceptCatalog = []; }
}

/* ── 渲染 ── */

function renderHeader() {
  const segs = splitPath(folderPath);
  $('folder-title').textContent = `📁 ${segs[segs.length - 1] || 'other'}`;
  // 面包屑：笔记 › 一级 › 二级…（可点）
  const crumbs = [`<a href="folders.html">笔记</a>`];
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
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

async function render() {
  renderHeader();
  renderTypeChips(filterNotes(notesCache, { folder: folderPath, subtree: false }));

  // 子文件夹卡片
  const allPaths = new Set(notesCache.map((n) => normalizeProject(n.project)));
  const tree = buildTree([...allPaths, folderPath]);
  const kids = directChildren(tree, folderPath);
  const subWrap = $('sub-folders');
  subWrap.innerHTML = '';
  if (kids.length) {
    for (const kid of kids) {
      const cnt = filterNotes(notesCache, { folder: kid.path, subtree: true }).length;
      const card = document.createElement('article');
      card.className = 'folder-card';
      card.innerHTML = `<div class="folder-card-head"><span class="folder-icon">📁</span><h3>${esc(kid.name)}</h3></div>
        <p class="folder-card-meta">含子层 ${cnt} 篇</p>`;
      card.addEventListener('click', () => { location.href = `folder.html?p=${encodeURIComponent(kid.path)}`; });
      subWrap.appendChild(card);
    }
  }

  // 笔记列表
  const list = visibleNotes();
  const listEl = $('note-list');
  listEl.innerHTML = '';
  $('empty-state').hidden = list.length > 0 || kids.length > 0;

  for (const n of list) {
    const card = document.createElement('article');
    card.className = 'note-card';
    card.dataset.id = n.id;
    if (selected.has(String(n.id))) card.classList.add('selected');
    const preview = String(n.content || n.readerNote || n.aiNote || '').replace(/\s+/g, ' ').slice(0, 90);
    card.innerHTML = `
      ${selecting ? `<input type="checkbox" class="pick" data-pick="${esc(n.id)}" ${selected.has(String(n.id)) ? 'checked' : ''}>` : ''}
      <div class="note-thumb note-thumb-empty">${esc((window.NoteTypes && NoteTypes.getType(n.type || 'note') || {}).icon || '📝')}</div>
      <div class="note-body">
        <div class="note-meta">${esc(typeLabel(n.type || 'note'))} · ${esc(n.date || '无日期')}${n.book ? ' · 《' + esc(n.book) + '》' : ''}</div>
        <h3 class="note-title">${esc(n.title || '未命名')}</h3>
        ${preview ? `<p class="note-note">${esc(preview)}${String(n.content || '').length > 90 ? '…' : ''}</p>` : ''}
        ${Array.isArray(n.tags) && n.tags.length ? `<div class="note-tags">${n.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
      </div>`;
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-pick]')) return;   // 勾选不跳转
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

  $('bulk-bar').hidden = list.length === 0 && !selecting ? true : false;
  updateBulkBar();
}

function updateBulkBar() {
  $('select-toggle').textContent = selecting ? '✖ 退出多选' : '☑ 多选';
  $('select-all').hidden = !selecting;
  $('move-btn').hidden = !selecting;
  $('bulk-count').textContent = selecting ? `已选 ${selected.size} 篇` : '';
}

/* ── 多选 / 移动 ── */

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

async function openMovePanel() {
  if (!selected.size) { toast('请先勾选要移动的笔记'); return; }
  const paths = await getAllFolderPaths();
  $('move-select').innerHTML = paths.map((p) => `<option value="${esc(p)}"${p === folderPath ? ' selected' : ''}>${esc(p)}</option>`).join('');
  $('move-new').value = '';
  $('move-info').textContent = `将移动 ${selected.size} 篇笔记（当前文件夹：${folderPath}）`;
  $('move-panel').hidden = false;
}

async function confirmMove() {
  const newPath = $('move-new').value.trim();
  const target = newPath || $('move-select').value;
  try {
    const { moved, folder } = await moveNotesToFolder([...selected], target, { createIfMissing: !!newPath });
    toast(`已移动 ${moved} 篇 → ${folder}`);
    $('move-panel').hidden = true;
    selected.clear();
    selecting = false;
    await loadData();
    await render();
  } catch (e) {
    toast(`移动失败：${e.message}`, 4200);
  }
}

/* ── 筛选事件 ── */

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
$('new-note-btn').addEventListener('click', () => {
  // 当前文件夹内新建：预填 project，保存后回跳本文件夹（20260911 ⑦）
  location.href = `type.html?t=note&new=1&project=${encodeURIComponent(folderPath)}&ret=${encodeURIComponent(folderPath)}`;
});
$('select-toggle').addEventListener('click', toggleSelect);
$('select-all').addEventListener('click', selectAllVisible);
$('move-btn').addEventListener('click', openMovePanel);
$('move-cancel').addEventListener('click', () => { $('move-panel').hidden = true; });
$('move-confirm').addEventListener('click', confirmMove);

/* ── 启动 ── */
(async function init() {
  document.title = `${splitPath(folderPath).pop() || 'other'} · 笔记 · 读书笔记`;
  await loadData();
  await render();
})();