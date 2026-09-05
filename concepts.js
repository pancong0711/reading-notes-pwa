/**
 * concepts.js —— 概念管理面板（阶段二 PWA）
 *
 * 概念目录（concepts.yaml 的本地工作副本）：
 *   - 列表：按域分组展示概念（含别名/关键词/关联/描述/引用数）
 *   - 新增 / 编辑 / 删除（删除保护：被笔记引用时需确认并清除引用）
 *   - 载入：从 graph.json / 上传 JSON（含 CLI concept list --json）
 *   - 导出：生成 concepts.yaml 文本，作为同步回电脑端的可选桥接（本机重算无需此步）
 *   - 本机重算：用 IndexedDB 笔记 + 工作副本目录在浏览器端重算 union 图谱，
 *     存 graph_local store（data.js），图谱页优先渲染；可下载 graph.json 回电脑端
 * 校验规则与 CLI concept_catalog.py 一致（data.js 数据层实现）。
 */
import {
  getConceptCatalog,
  saveConceptCatalog,
  getAllConcepts,
  getAllDomains,
  getDomainNameMap,
  addConcept,
  editConcept,
  deleteConcept,
  scanConceptReferences,
  importConceptCatalog,
  importConceptCatalogFromGraph,
  exportConceptCatalogYaml,
  getAllNotes,
  saveLocalGraph,
  getLocalGraph,
  clearLocalGraph,
} from './data.js';
import { buildUnionGraph } from './graph-build.js';

const $ = (id) => document.getElementById(id);

const els = {
  count: $('catalog-count'),
  loadGraphBtn: $('load-graph-btn'),
  loadFileBtn: $('load-file-btn'),
  loadFile: $('load-file'),
  rebuildBtn: $('rebuild-btn'),
  localStatus: $('local-graph-status'),
  exportBtn: $('export-btn'),
  newBtn: $('new-btn'),
  list: $('concept-list'),
  empty: $('empty-state'),
  editor: $('editor'),
  editorTitle: $('editor-title'),
  fId: $('f-id'),
  fName: $('f-name'),
  fDomain: $('f-domain'),
  fAliases: $('f-aliases'),
  fKeywords: $('f-keywords'),
  fRelated: $('f-related'),
  fDescription: $('f-description'),
  saveBtn: $('save-btn'),
  cancelBtn: $('cancel-btn'),
  exportPanel: $('export-panel'),
  exportText: $('export-text'),
  exportDownload: $('export-download'),
  exportClose: $('export-close'),
  collectBtn: $('collect-btn'),
  collectPanel: $('collect-panel'),
  collectList: $('collect-list'),
  collectDomain: $('collect-domain'),
  collectNewDomain: $('collect-new-domain'),
  collectConfirm: $('collect-confirm'),
  collectClose: $('collect-close'),
  rebuildPanel: $('rebuild-panel'),
  rebuildStats: $('rebuild-stats'),
  rebuildWarnings: $('rebuild-warnings'),
  rebuildDownload: $('rebuild-download'),
  rebuildClose: $('rebuild-close'),
  deletePanel: $('delete-panel'),
  deleteInfo: $('delete-info'),
  deleteRefs: $('delete-refs'),
  deleteConfirm: $('delete-confirm'),
  deleteCancel: $('delete-cancel'),
  toast: $('toast'),
};

let toastTimer = null;
let domainsCache = [];
let conceptsCache = [];
let editingId = null;          // null = 新增
let pendingDelete = null;      // {id, refs}
let lastRebuild = null;        // 最近一次本机重算的存档记录 {id, graph, builtAt, source}

/* ── 工具 ── */

function toast(msg, ms = 3000) {
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

function parseList(value) {
  return String(value || '').split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean);
}

/* ── 列表渲染（按域分组） ── */

function refreshCount() {
  els.count.textContent = conceptsCache.length
    ? `共 ${conceptsCache.length} 个概念 · ${domainsCache.length} 个域`
    : '还没有概念';
}

function renderList() {
  els.list.innerHTML = '';
  els.empty.hidden = conceptsCache.length > 0;

  const domainRank = new Map(domainsCache.map((d, i) => [d.id, i]));
  const byDomain = new Map();
  for (const c of conceptsCache) {
    const arr = byDomain.get(c.domain) || [];
    arr.push(c);
    byDomain.set(c.domain, arr);
  }
  const orderedDomains = [...byDomain.keys()].sort((a, b) =>
    (domainRank.get(a) ?? 999) - (domainRank.get(b) ?? 999));

  for (const domainId of orderedDomains) {
    const domain = domainsCache.find((d) => d.id === domainId);
    const dname = (domain && domain.name) || domainId || '未归域';
    const group = document.createElement('div');
    group.className = 'note-group concept-group';
    group.innerHTML = `<div class="note-group-head"><h2>${esc(dname)}</h2><span class="book-count">${esc(domain && domain.color || '')}</span></div>`;
    const listEl = document.createElement('div');
    listEl.className = 'note-list';

    for (const c of (byDomain.get(domainId) || []).sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
      listEl.appendChild(renderCard(c));
    }
    group.appendChild(listEl);
    els.list.appendChild(group);
  }
  refreshCount();
}

function renderCard(c) {
  const card = document.createElement('article');
  card.className = 'note-card concept-row';

  const desc = c.description
    ? `<p class="muted concept-desc">${esc(c.description.length > 90 ? c.description.slice(0, 90) + '…' : c.description)}</p>`
    : '';
  const chips = [];
  if (Array.isArray(c.aliases) && c.aliases.length) chips.push(`<span class="tag">别名 ${esc(c.aliases.join('、'))}</span>`);
  if (Array.isArray(c.keywords) && c.keywords.length) chips.push(`<span class="tag">关键词 ${esc(c.keywords.join('、'))}</span>`);
  if (Array.isArray(c.related) && c.related.length) chips.push(`<span class="tag">关联 ${esc(c.related.join('、'))}</span>`);
  const chipHtml = chips.length ? `<div class="note-tags">${chips.join('')}</div>` : '';

  card.innerHTML = `
    <div class="note-body">
      <div class="note-meta"><code>${esc(c.id)}</code> · ${esc(c.domain || '未归域')}</div>
      <h3 class="note-title">${esc(c.name)}</h3>
      ${desc}
      ${chipHtml}
    </div>
    <div class="note-actions">
      <button class="btn ghost small" data-act="edit">编辑</button>
      <button class="btn ghost small danger" data-act="delete">删除</button>
    </div>`;
  card.dataset.id = c.id;
  return card;
}

/* ── 表单（新增/编辑） ── */

function fillDomainOptions(selected) {
  els.fDomain.innerHTML = domainsCache.map((d) =>
    `<option value="${esc(d.id)}"${d.id === selected ? ' selected' : ''}>${esc(d.name || d.id)}</option>`).join('');
}

function openEditor(concept) {
  editingId = concept ? concept.id : null;
  els.editorTitle.textContent = concept ? `编辑概念：${concept.name}` : '新增概念';
  els.fId.value = concept ? concept.id : '';
  els.fId.disabled = !!concept;   // v1 不改 id（改名用编辑 id 场景未在 PWA 提供，与 CLI --field id 分离）
  els.fName.value = concept ? concept.name : '';
  fillDomainOptions(concept ? concept.domain : (domainsCache[0] && domainsCache[0].id) || '');
  els.fAliases.value = concept && Array.isArray(concept.aliases) ? concept.aliases.join(', ') : '';
  els.fKeywords.value = concept && Array.isArray(concept.keywords) ? concept.keywords.join(', ') : '';
  els.fRelated.value = concept && Array.isArray(concept.related) ? concept.related.join(', ') : '';
  els.fDescription.value = concept ? concept.description || '' : '';
  els.editor.hidden = false;
  els.editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeEditor() {
  els.editor.hidden = true;
  editingId = null;
}

async function saveRecord() {
  try {
    if (editingId) {
      // 编辑：逐字段应用（列表类整段替换）
      const updates = [
        ['name', els.fName.value.trim()],
        ['domain', els.fDomain.value],
        ['aliases', els.fAliases.value],
        ['keywords', els.fKeywords.value],
        ['related', els.fRelated.value],
        ['description', els.fDescription.value.trim()],
      ];
      for (const [field, value] of updates) {
        await editConcept(editingId, field, value);
      }
      toast('已保存概念');
    } else {
      await addConcept({
        id: els.fId.value,
        name: els.fName.value,
        domain: els.fDomain.value,
        aliases: parseList(els.fAliases.value),
        keywords: parseList(els.fKeywords.value),
        related: parseList(els.fRelated.value),
        description: els.fDescription.value.trim(),
      });
      toast('已新增概念');
    }
    closeEditor();
    await loadCatalog();
  } catch (err) {
    toast(`保存失败：${err.message}`, 4200);
  }
}

/* ── 删除（含引用保护） ── */

async function openDeletePanel(c) {
  let refs = [];
  try { refs = await scanConceptReferences(c.id); } catch (e) { refs = []; }
  pendingDelete = { id: c.id, refs };
  if (refs.length) {
    els.deleteInfo.textContent = `概念「${c.name}（${c.id}）」被 ${refs.length} 处本地记录引用。删除会同时清除这些引用标注。`;
    els.deleteRefs.innerHTML = `<ul class="delete-ref-list">${refs.slice(0, 10).map((r) => `<li>${esc(r.type)}：${esc(r.title)}</li>`).join('')}${refs.length > 10 ? `<li>… 等 ${refs.length} 处</li>` : ''}</ul>`;
    els.deleteConfirm.textContent = '仍要删除（清除引用）';
  } else {
    els.deleteInfo.textContent = `确定删除概念「${c.name}（${c.id}）」？`;
    els.deleteRefs.innerHTML = '';
    els.deleteConfirm.textContent = '删除';
  }
  els.deletePanel.hidden = false;
}

async function confirmDelete() {
  if (!pendingDelete) return;
  try {
    const { clearedReferences } = await deleteConcept(pendingDelete.id, { force: pendingDelete.refs.length > 0 });
    toast(clearedReferences ? `已删除，并清除 ${clearedReferences} 处引用标注` : '已删除概念');
    closeDeletePanel();
    await loadCatalog();
  } catch (err) {
    toast(`删除失败：${err.message}`, 4200);
  }
}

function closeDeletePanel() {
  els.deletePanel.hidden = true;
  pendingDelete = null;
}

/* ── 载入 ── */

/** 从 graph.json 载入工作副本（覆盖；graph.json 缺 aliases/keywords） */
async function loadFromGraph() {
  try {
    const resp = await fetch('graph.json', { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const graph = await resp.json();
    const clean = await importConceptCatalogFromGraph(graph);
    await loadCatalog();
    toast(`已从 graph.json 载入 ${clean.concepts.length} 个概念`);
  } catch (err) {
    toast(`载入失败：${err.message}`, 4200);
  }
}

/** 上传 JSON 载入（覆盖；接受 {domains,concepts} 或 CLI concept list --json 裸数组） */
async function loadFromFile(file) {
  try {
    const json = JSON.parse(await file.text());
    const clean = await importConceptCatalog(json);
    await loadCatalog();
    toast(`已从文件载入 ${clean.concepts.length} 个概念`);
  } catch (err) {
    toast(`载入失败：${err.message}`, 4200);
  }
}

/* ── 导出 ── */

async function openExport() {
  try {
    const yaml = await exportConceptCatalogYaml();
    els.exportText.value = yaml;
    els.exportPanel.hidden = false;
  } catch (err) {
    toast(`导出失败：${err.message}`, 4200);
  }
}

function closeExport() {
  els.exportPanel.hidden = true;
}

function downloadExport() {
  const blob = new Blob([els.exportText.value], { type: 'text/yaml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'concepts.yaml';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已下载 concepts.yaml（仅回电脑端同步时需要；本机看新图请用「重新计算图谱」）');
}

/* ── 未编目概念收集（需求 20260905-批次二 F2a）── */

let pendingCollect = [];   // 扫描出的未编目概念 [{id, count}]

/** 扫描本机全部记录的 concepts 引用，与工作副本目录求差 → 未编目列表 */
async function openCollectPanel() {
  try {
    const [notes, catalogConcepts, catalogDomains] = await Promise.all([
      getAllNotes(),
      getAllConcepts(),
      getAllDomains(),
    ]);
    const known = new Set(catalogConcepts.map((c) => c.id));
    const counts = new Map();   // id → 引用记录数
    for (const n of notes) {
      for (const c of (Array.isArray(n.concepts) ? n.concepts : [])) {
        const id = typeof c === 'string' ? c : (c && c.id) || '';
        if (!id || known.has(id)) continue;
        counts.set(id, (counts.get(id) || 0) + 1);
      }
    }
    pendingCollect = [...counts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

    if (!pendingCollect.length) {
      toast('没有未编目概念——本机记录引用的概念都已在目录中');
      return;
    }

    // 域下拉：现有域 + 新建域；默认按拍板=materials（不存在则首个域 / uncategorized 占位）
    const hasMaterials = catalogDomains.some((d) => d.id === 'materials');
    els.collectDomain.innerHTML = catalogDomains.map((d) =>
      `<option value="${esc(d.id)}"${d.id === 'materials' ? ' selected' : ''}>${esc(d.name || d.id)}</option>`).join('')
      + '<option value="__new__">➕ 新建域…</option>';
    if (!catalogDomains.length) {
      els.collectDomain.innerHTML = '<option value="__new__" selected>➕ 新建域…</option>';
    } else if (!hasMaterials) {
      els.collectDomain.value = catalogDomains[0].id;
    }
    els.collectNewDomain.hidden = els.collectDomain.value !== '__new__';

    els.collectList.innerHTML = pendingCollect.map((c) => `
      <label class="chk collect-row"><input type="checkbox" data-cid="${esc(c.id)}" checked>
        <code>${esc(c.id)}</code><span class="tag-count">${c.count} 条记录引用</span>
      </label>`).join('')
      + `<p class="muted">共 ${pendingCollect.length} 个未编目概念（已按引用数排序）</p>`;
    els.collectConfirm.textContent = `加入目录（${pendingCollect.length}）`;
    els.collectPanel.hidden = false;
    els.collectPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    toast(`扫描失败：${err.message}`, 4200);
  }
}

/** 确认编目：勾选项 + 域（或新建域）→ 增量并入工作副本并保存 */
async function confirmCollect() {
  const chosen = [...els.collectList.querySelectorAll('input[data-cid]:checked')]
    .map((i) => i.dataset.cid);
  if (!chosen.length) { toast('未勾选任何概念'); return; }

  let domain = els.collectDomain.value || '';
  if (domain === '__new__') {
    domain = els.collectNewDomain.value.trim();
    if (!domain) { toast('请填写新域 id'); return; }
  }

  try {
    const catalog = (await getConceptCatalog()) || { domains: [], concepts: [] };
    catalog.domains = catalog.domains || [];
    catalog.concepts = catalog.concepts || [];
    if (!catalog.domains.some((d) => d.id === domain)) {
      catalog.domains.push({ id: domain, name: domain });
    }
    const existing = new Set(catalog.concepts.map((c) => c.id));
    let added = 0;
    for (const id of chosen) {
      if (existing.has(id)) continue;   // 双保险：只补缺
      catalog.concepts.push({ id, name: id, domain, aliases: [], keywords: [], related: [], description: '' });
      existing.add(id);
      added += 1;
    }
    await saveConceptCatalog(catalog);
    els.collectPanel.hidden = true;
    pendingCollect = [];
    await loadCatalog();
    toast(`已并入 ${added} 个概念到域「${domain}」——点「⚙️ 重新计算图谱」即可在图谱中看到`, 4600);
  } catch (err) {
    toast(`编目失败：${err.message}`, 4200);
  }
}

/* ── 本机重算图谱（阶段二：无需电脑，浏览器端重算 union 图谱并存本机）── */

/** ISO 时间 → 本地可读「YYYY-MM-DD HH:MM」；解析失败原样返回 */
function fmtLocalTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 重算入口：概念目录工作副本 + IndexedDB 书籍笔记（type='note'，日记/日志/备忘
 * 不进图，同 CLI 口径）→ buildUnionGraph → 存 graph_local（图谱页优先渲染）。
 * 整个流程 try/catch：失败仅 toast，不影响页面已有状态与静态数据。
 */
async function rebuildGraph() {
  try {
    const localCat = (await getConceptCatalog()) || { domains: [], concepts: [] };
    // F2c：基线并集 = graph.json（静态产物）∪ 工作副本——防止在小工作副本上重算把大图打薄
    let baseGraph = null;
    try {
      const resp = await fetch('graph.json', { cache: 'no-store' });
      if (resp.ok) baseGraph = await resp.json();
    } catch (e) { /* file:// 或缺失：只用工作副本 */ }

    const domains = new Map((baseGraph && Array.isArray(baseGraph.domains) ? baseGraph.domains : []).map((d) => [d.id, d]));
    const concepts = new Map((baseGraph && Array.isArray(baseGraph.concepts) ? baseGraph.concepts : []).map((c) => [c.id, c]));
    let localOnlyDomains = 0;
    let localOnlyConcepts = 0;
    for (const d of (localCat.domains || [])) {
      if (!domains.has(d.id)) { localOnlyDomains += 1; }
      domains.set(d.id, d);   // 本端条目优先（覆盖同 id）
    }
    for (const c of (localCat.concepts || [])) {
      if (!concepts.has(c.id)) { localOnlyConcepts += 1; }
      concepts.set(c.id, c);
    }
    const merged = {
      domains: [...domains.values()],
      concepts: [...concepts.values()],
    };
    if (!merged.concepts.length) {
      toast('请先载入概念目录（从 graph.json 载入 / 上传 JSON / 「收集未编目概念」）', 3600);
      return;
    }

    const notes = await getAllNotes('note');
    const result = buildUnionGraph({
      domains: merged.domains,
      concepts: merged.concepts,
      notes,
    });
    lastRebuild = await saveLocalGraph(result);
    renderRebuildPanel(lastRebuild, {
      graphJsonConcepts: (baseGraph && Array.isArray(baseGraph.concepts) ? baseGraph.concepts.length : 0),
      localOnlyDomains,
      localOnlyConcepts,
      mergedConcepts: merged.concepts.length,
    });
    await refreshLocalGraphStatus();
    toast(`本机图谱已构建：${result.stats.notes} 笔记 · ${result.stats.edges} 边`);
  } catch (err) {
    toast(`重算失败：${err.message}`, 4200);
  }
}

/** 结果面板：统计行（口径同 CLI graph build）＋ warnings 逐条降级提示 */
function renderRebuildPanel(record, base = null) {
  const s = (record.graph && record.graph.stats) || {};
  const lines = [
    `✅ 图谱已构建（本机重算 @${fmtLocalTime(record.builtAt)}）`,
    `📝 笔记 ${s.notes ?? 0} ｜ 💡 概念 ${s.concepts ?? 0} ｜ 🗂️ 域 ${s.domains ?? 0}`
      + ` ｜ 🔗 边 ${s.edges ?? 0} ｜ 🕳️ 孤立笔记 ${s.orphan_notes ?? 0}`,
    `🏷️ 用户概念标签笔记 ${s.user_tagged_notes ?? 0} 篇`
      + ` ｜ 用户驱动边 ${s.user_concept_edges ?? 0} ｜ AI 驱动边 ${s.ai_concept_edges ?? 0}`,
  ];
  if (base) {
    lines.push(
      `📚 目录基线：graph.json ${base.graphJsonConcepts} + 本机独有域 ${base.localOnlyDomains}/概念 ${base.localOnlyConcepts}`
      + ` → 并集 ${base.mergedConcepts} 个概念（防打薄：本机重算不低于静态图目录）`);
  }
  els.rebuildStats.innerHTML = lines.map((t) => esc(t)).join('<br>');

  // 目录缺 aliases/keywords 时自动命中退化（如从 graph.json 载入的目录），逐条提示
  const warns = record.graph && Array.isArray(record.graph.warnings) ? record.graph.warnings : [];
  els.rebuildWarnings.innerHTML = warns.map((w) => `<li>⚠️ ${esc(w)}</li>`).join('');
  els.rebuildWarnings.hidden = warns.length === 0;

  els.rebuildPanel.hidden = false;
  els.rebuildPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 下载重算结果：剔除顶层 warnings 键，schema 与 CLI 产物 graph.json 完全一致 */
function downloadRebuiltGraph() {
  if (!lastRebuild || !lastRebuild.graph) {
    toast('还没有本机重算结果，请先点「重新计算图谱」', 3600);
    return;
  }
  const { warnings, ...schema } = lastRebuild.graph;
  const blob = new Blob([JSON.stringify(schema, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'graph.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已下载 graph.json，可选带回电脑端覆盖 app/pwa/graph.json');
}

/** 工具栏下方状态行：有存档显示「🧠 本机图谱：…」＋清除入口；无则提示尚无结果 */
async function refreshLocalGraphStatus() {
  let rec = null;
  try {
    rec = await getLocalGraph();
  } catch (err) {
    console.warn('[concepts] 读取本机图谱失败:', err);
  }
  if (!rec || !rec.graph || !Array.isArray(rec.graph.notes)) {
    els.localStatus.textContent = '尚无本机重算结果';
    els.localStatus.hidden = false;
    return;
  }
  const s = rec.graph.stats || {};
  els.localStatus.innerHTML =
    `🧠 本机图谱：${esc(String(s.notes ?? rec.graph.notes.length))} 笔记 · `
    + `${esc(String(s.edges ?? 0))} 边 @${esc(fmtLocalTime(rec.builtAt))} `
    + '<button class="btn ghost" data-act="clear-local-graph" type="button">清除</button>';
}

/* ── 数据载入 ── */

async function loadCatalog() {
  const [concepts, domains] = await Promise.all([getAllConcepts(), getAllDomains()]);
  conceptsCache = concepts;
  domainsCache = domains;
  renderList();
}

/* ── 事件绑定 ── */

els.newBtn.addEventListener('click', () => openEditor());
els.cancelBtn.addEventListener('click', closeEditor);
els.saveBtn.addEventListener('click', saveRecord);

els.loadGraphBtn.addEventListener('click', loadFromGraph);
els.loadFileBtn.addEventListener('click', () => els.loadFile.click());
els.loadFile.addEventListener('change', () => {
  if (els.loadFile.files[0]) loadFromFile(els.loadFile.files[0]);
  els.loadFile.value = '';
});

els.collectBtn.addEventListener('click', openCollectPanel);
els.collectClose.addEventListener('click', () => { els.collectPanel.hidden = true; });
els.collectConfirm.addEventListener('click', confirmCollect);
els.collectDomain.addEventListener('change', () => {
  els.collectNewDomain.hidden = els.collectDomain.value !== '__new__';
});

els.exportBtn.addEventListener('click', openExport);
els.exportClose.addEventListener('click', closeExport);
els.exportDownload.addEventListener('click', downloadExport);

els.rebuildBtn.addEventListener('click', rebuildGraph);
els.rebuildClose.addEventListener('click', () => { els.rebuildPanel.hidden = true; });
els.rebuildDownload.addEventListener('click', downloadRebuiltGraph);

// 状态行「清除」按钮：删除 graph_local 存档并刷新状态行（面板一并收起）
els.localStatus.addEventListener('click', async (event) => {
  if (!event.target.closest('[data-act="clear-local-graph"]')) return;
  try {
    await clearLocalGraph();
    lastRebuild = null;
    els.rebuildPanel.hidden = true;
    await refreshLocalGraphStatus();
    toast('已清除本机重算结果，图谱页回退 CLI 产物');
  } catch (err) {
    toast(`清除失败：${err.message}`, 4200);
  }
});

els.deleteCancel.addEventListener('click', closeDeletePanel);
els.deleteConfirm.addEventListener('click', confirmDelete);

els.list.addEventListener('click', (event) => {
  const card = event.target.closest('.concept-row');
  if (!card) return;
  const btn = event.target.closest('[data-act]');
  if (!btn) return;
  const concept = conceptsCache.find((c) => c.id === card.dataset.id);
  if (!concept) return;
  if (btn.dataset.act === 'edit') {
    openEditor(concept);
  } else if (btn.dataset.act === 'delete') {
    openDeletePanel(concept);
  }
});

/* ── 启动 ── */
(async function init() {
  document.title = '概念管理 · 读书笔记';
  await loadCatalog();
  await refreshLocalGraphStatus();
})();
