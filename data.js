/**
 * data.js —— 读书笔记 PWA 数据层
 *
 * 基于 IndexedDB 的本地存储：
 *   数据库：reading-notes
 *   对象仓库：notes（主键 id，附 book / date 索引）、books（主键 name）
 *   单条记录：{ id, title, book, author, date, tags, rating, pages,
 *              content, images, readerNote, aiNote, imageData, concepts }
 *     - readerNote：读者注（读者自己的思考）
 *     - aiNote：AI注（与 AI 咨询的内容 / 应读者要求由 AI 补充的说明）
 *     - imageData：新建笔记时拍照/选图的压缩 base64 缩略图
 *     - concepts：概念级标签 [{id, source}]，source ∈ user|ai
 *   书籍元信息（books store，主键 name）：
 *     { name, author, status, rating, tags, summary, cover, started, finished }
 *
 * 版本 v5（本仓库）：在 v4 基础上新增 graph_local store——
 *   本机重算 union 图谱的存档位（与 diary.js 双侧同步升级，两处 schema 必须一致）。
 *
 * 对外提供：
 *   importNotePackage(json)  —— 清空重建，导入整包（接受 { notes, books } / { notes } / 裸数组）
 *   exportNotePackage()      —— 导出 { notes: [...], books: [...], exportedAt }
 *   getAllNotes()            —— 读取全部笔记（按 date 降序，无日期排最后）
 *   countNotes()             —— 笔记总数
 *   addNote(note)            —— 新增/更新单条笔记（返回 id）
 *   deleteNote(id)           —— 删除单条笔记
 *   saveBooks(list)          —— 清空 books store 后批量写入（单事务，全量替换）
 *   saveBook(meta)           —— 单本 upsert：合并现有记录后按 name 写入（只覆盖传入字段）
 *   getAllBooksRaw()         —— 读取全部书籍元信息，按 name 排序
 *   getAllBooks()            —— 聚合书架：笔记书名集合 × books meta，返回带统计的数组
 *   getConceptCatalog / saveConceptCatalog / getAllConcepts / getAllDomains 等
 *                            —— 概念目录工作副本的读写增删改
 *   importConceptCatalog / exportConceptCatalogYaml —— 概念目录工作副本的导入导出
 *   saveLocalGraph(graph)    —— 保存本机重算图谱（graph_local store 单条记录 id='union'）
 *   getLocalGraph()          —— 读取本机重算图谱记录（无则 null）
 *   clearLocalGraph()        —— 清除本机重算图谱（图谱页回退 CLI 静态产物）
 *
 * importNotePackage / exportNotePackage 同时挂到 window，
 * 便于页面与浏览器控制台直接调用。
 */

const DB_NAME = 'reading-notes';
const DB_VERSION = 6;   // v2：type 索引；v3：books store；v4：concept_catalog store；v5：graph_local store；v6：image_store（图片自包含仓，path→Blob，diary.js 同步升级）
const STORE = 'notes';
const BOOKS_STORE = 'books';
const CONCEPTS_STORE = 'concept_catalog';   // 概念目录工作副本，keyPath: id
const GRAPH_LOCAL_STORE = 'graph_local';    // 本机重算 union 图谱存档，keyPath: id
const IMAGE_STORE = 'image_store';          // 图片自包含仓（迁移包导入/ SW 网络回填），keyPath: path

let _dbPromise = null;
let _noteSeq = 0;   // 本地新记录 id 递增序号，避免同一毫秒内并发/连续新增时 id 冲突

/** 打开数据库（单例，重复调用复用同一个连接） */
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('当前浏览器不支持 IndexedDB，无法本地存储'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('book', 'book', { unique: false });
        store.createIndex('date', 'date', { unique: false });
        store.createIndex('type', 'type', { unique: false });
      } else {
        // 仓库已存在（可能由 diary.js 先建）：补齐缺失索引，避免两套封装 schema 冲突
        const st = event.target.transaction.objectStore(STORE);
        if (!st.indexNames.contains('book')) {
          st.createIndex('book', 'book', { unique: false });
        }
        if (!st.indexNames.contains('date')) {
          st.createIndex('date', 'date', { unique: false });
        }
        if (!st.indexNames.contains('type')) {
          st.createIndex('type', 'type', { unique: false });
        }
      }
      if (!db.objectStoreNames.contains(BOOKS_STORE)) {
        db.createObjectStore(BOOKS_STORE, { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains(CONCEPTS_STORE)) {
        db.createObjectStore(CONCEPTS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(GRAPH_LOCAL_STORE)) {
        // v5 新增：本机重算 union 图谱存档（diary.js 同步升级补建，两处 schema 必须一致）
        db.createObjectStore(GRAPH_LOCAL_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(IMAGE_STORE)) {
        // v6 新增：图片自包含仓（迁移包导入 / SW 网络回填，diary.js 同步升级补建）
        db.createObjectStore(IMAGE_STORE, { keyPath: 'path' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return _dbPromise;
}

/* 域调色板（修复轮 R2）：与 concepts.yaml 现有 10 色一致 + 2 备用；
 * 新建域取未占用色；渲染端对无色域按 id 稳定哈希取色（旧数据/外部数据也能互异） */
export const DOMAIN_PALETTE = [
  '#f59e0b', '#8b5cf6', '#06b6d4', '#ef4444', '#10b981', '#6366f1',
  '#84cc16', '#3b82f6', '#0ea5e9', '#f97316', '#ec4899', '#14b8a6',
];

/** 域 id → 调色板稳定色（按码点和哈希；两端 JS/Python 同算法，可差分） */
export function domainColorFor(id, exclude = []) {
  const key = String(id || '');
  const sum = [...key].reduce((acc, ch) => acc + (ch.codePointAt(0) || 0), 0);
  const used = new Set(exclude);
  if (!used.size) return DOMAIN_PALETTE[sum % DOMAIN_PALETTE.length];
  for (let i = 0; i < DOMAIN_PALETTE.length; i++) {
    const c = DOMAIN_PALETTE[(sum + i) % DOMAIN_PALETTE.length];
    if (!used.has(c)) return c;
  }
  return DOMAIN_PALETTE[sum % DOMAIN_PALETTE.length];
}

/** 规整自由标签：兼容字符串/对象形态（手写 JSON 变体，需求 20260905-批次一 F1），去空白、去重、过滤图片路径/文件名噪音（导出供差分测试）
 *  兼容形态：
 *    · "物理,光学" / "物理；光学、材料" —— 按 ，,;；、 切分
 *    · [{name:'物理'} / {id:'光学'} / {label:…} / {tag:…}] —— 对象取首个非空字段
 */
export function normalizeTags(tags) {
  if (tags == null) return [];
  if (typeof tags === 'string') tags = tags.split(/[，,;；、]/);
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    let v = '';
    if (typeof t === 'string') {
      v = t;
    } else if (t && typeof t === 'object') {
      v = String(t.name || t.id || t.label || t.tag || '');
    } else {
      continue;
    }
    v = v.trim();
    if (!v) continue;
    if (/(^|[\\/])assets[\\/]/i.test(v) || /\.(jpe?g|png|gif|webp|bmp|svg|avif)$/i.test(v) || /^img_\w+\.\w+$/i.test(v)) {
      continue;
    }
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** 规整概念标签：兼容字符串列表或 {id, source} 对象列表 */
function normalizeConcepts(concepts) {
  if (!Array.isArray(concepts)) return [];
  const out = [];
  const seen = new Set();
  for (const c of concepts) {
    let id = '';
    let source = 'user';
    if (typeof c === 'string') {
      id = c.trim();
    } else if (c && typeof c === 'object') {
      id = String(c.id || '').trim();
      source = String(c.source || 'user').trim() || 'user';
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, source });
  }
  return out;
}

/** 规整单条笔记：补全缺省字段、统一字段类型、保留 type（默认 note） */
function normalizeNote(raw, index) {
  const id = raw.id != null ? String(raw.id) : `note-${Date.now()}-${++_noteSeq}`;
  return {
    id,
    type: raw.type || 'note',        // 记录类型：note（阅读笔记）/ diary（日记）/ 自定义
    title: raw.title || '未命名笔记',
    book: raw.book || '',
    author: raw.author || '',
    date: raw.date || '',
    tags: normalizeTags(raw.tags),
    rating: raw.rating == null ? null : Number(raw.rating),
    pages: raw.pages || '',
    content: raw.content || '',
    images: Array.isArray(raw.images)
      ? raw.images.filter((i) => typeof i === 'string')
      : [],
    readerNote: raw.readerNote || '',
    aiNote: raw.aiNote || '',
    imageData: raw.imageData || '',
    quotes: Array.isArray(raw.quotes) ? raw.quotes : [],
    characters: raw.characters && typeof raw.characters === 'object' ? raw.characters : {},
    extension: raw.extension || '',
    concepts: normalizeConcepts(raw.concepts),
    project: typeof raw.project === 'string' ? raw.project.trim() : '',   // 项目维度（可选，因项目而读）
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {},   // 类型特有字段（memo: done/due 等）
    createdAt: raw.createdAt || Date.now(),
    updatedAt: raw.updatedAt || Date.now(),
  };
}

/** 在单次事务里清空并重建仓库（导入即全量替换） */
async function replaceAll(notes) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.clear();
    for (const note of notes) store.put(note);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** 规整单条书籍元信息：补全缺省字段（无 meta 时以空串/0/null 兜底） */
function normalizeBook(raw, index) {
  const name = raw && raw.name != null ? String(raw.name).trim() : '';
  if (!name) return null;   // 无书名的记录丢弃
  return {
    name,
    author: raw.author || '',
    status: raw.status || '',
    rating: raw.rating == null ? 0 : Number(raw.rating),
    tags: normalizeTags(raw.tags),
    summary: raw.summary || '',
    cover: raw.cover || '',
    started: raw.started || null,
    finished: raw.finished || null,
  };
}

/**
 * 清空 books store 后批量写入（单事务，全量替换）。
 * @param {Array} list  书籍元信息数组 [{name, author, status, ...}]
 * @returns {Promise<number>} 写入的书籍数量
 */
export async function saveBooks(list) {
  const books = (Array.isArray(list) ? list : [])
    .map((raw, i) => normalizeBook(raw, i))
    .filter(Boolean);
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(BOOKS_STORE, 'readwrite');
    const store = tx.objectStore(BOOKS_STORE);
    store.clear();
    for (const book of books) store.put(book);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return books.length;
}

/** 读取全部书籍元信息，按 name 排序（本地化比较） */
export async function getAllBooksRaw() {
  const db = await openDB();
  const books = await new Promise((resolve, reject) => {
    const request = db.transaction(BOOKS_STORE, 'readonly').objectStore(BOOKS_STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  books.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return books;
}

/**
 * 单本 upsert：先读 books store 中现有记录，合并传入字段后按 name 写入。
 * 只覆盖传入字段 + name，未提交的字段（author/tags/cover/started 等）保持不变。
 * @param {object} meta  { name, status?, rating?, summary?, ... }；name 必填，缺失抛错
 * @returns {Promise<object>} 保存后的完整记录（合并结果）
 */
export async function saveBook(meta) {
  if (!meta || meta.name == null || String(meta.name).trim() === '') {
    throw new Error('saveBook: name 缺失，无法保存书籍信息');
  }
  const name = String(meta.name).trim();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BOOKS_STORE, 'readwrite');
    const store = tx.objectStore(BOOKS_STORE);
    let merged = null;
    const req = store.get(name);
    req.onsuccess = () => {
      merged = { ...(req.result || {}), ...meta, name };
      store.put(merged);
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve(merged);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * 聚合书架：读全部笔记（type 非 diary 的）聚合书名集合，与 books store 的 meta 合并。
 * @returns {Promise<Array<{name, author, status, rating, tags, summary, cover,
 *           started, finished, notes_count, first_date, last_date}>>}
 *           按 notes_count 降序（同 count 按 name）
 */
export async function getAllBooks() {
  const [allNotes, metaList] = await Promise.all([getAllNotes(), getAllBooksRaw()]);
  // 聚合：仅统计 type 非 diary 的笔记，book 字段非空去重
  const byBook = new Map();
  for (const n of allNotes) {
    if ((n.type || 'note') === 'diary') continue;
    const name = typeof n.book === 'string' ? n.book.trim() : '';
    if (!name) continue;
    let agg = byBook.get(name);
    if (!agg) {
      agg = { count: 0, dates: [] };
      byBook.set(name, agg);
    }
    agg.count++;
    if (n.date) agg.dates.push(String(n.date));
  }
  const metaByName = new Map(metaList.map((m) => [m.name, m]));
  const result = [];
  for (const [name, agg] of byBook) {
    const meta = metaByName.get(name) || {};
    const dates = agg.dates.slice().sort();
    result.push({
      name,
      author: meta.author || '',
      status: meta.status || '',
      rating: meta.rating == null ? 0 : Number(meta.rating),
      tags: normalizeTags(meta.tags),
      summary: meta.summary || '',
      cover: meta.cover || '',
      started: meta.started || null,
      finished: meta.finished || null,
      notes_count: agg.count,
      first_date: dates.length ? dates[0] : '',
      last_date: dates.length ? dates[dates.length - 1] : '',
    });
  }
  result.sort((a, b) => b.notes_count - a.notes_count || a.name.localeCompare(b.name));
  return result;
}

/** 汇总全部本地记录的自由标签及出现次数 */
export async function getAllTags() {
  const all = await getAllNotes();
  const counts = new Map();
  for (const n of all) {
    if (!Array.isArray(n.tags)) continue;
    for (const t of n.tags) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * 批量重命名/合并标签：把所有记录中的 oldTag 改为 newTag。
 * @returns {Promise<number>} 被更新的记录数
 */
export async function renameTag(oldTag, newTag) {
  const target = String(newTag || '').trim();
  if (!target) throw new Error('新标签不能为空');
  if (oldTag === target) return 0;
  const all = await getAllNotes();
  let changed = 0;
  for (const n of all) {
    if (!Array.isArray(n.tags) || !n.tags.includes(oldTag)) continue;
    const tags = normalizeTags(n.tags.map((t) => (t === oldTag ? target : t)));
    await addNote({ ...n, tags, updatedAt: Date.now() });
    changed++;
  }
  return changed;
}

/** 批量删除标签：从所有本地记录移除指定标签 */
export async function deleteTag(tag) {
  const all = await getAllNotes();
  let changed = 0;
  for (const n of all) {
    if (!Array.isArray(n.tags) || !n.tags.includes(tag)) continue;
    const tags = normalizeTags(n.tags.filter((t) => t !== tag));
    await addNote({ ...n, tags, updatedAt: Date.now() });
    changed++;
  }
  return changed;
}

/**
 * 包内概念目录 → 本机工作副本的**增量并入**（需求 20260905-批次二 F2b）。
 * 规则：按 id 并集——包内新域/新概念补入，本端已有条目一律保留（不覆盖、不删除）；
 * 无 conceptCatalog 键 → 原样返回 {added:0,total:0}。
 * 校验失败抛中文错误（调用方在写笔记之前调用，整体导入 fail-fast，不产生半成品）。
 * @param {object} json  导入包（含可选 conceptCatalog: {domains, concepts}）
 * @returns {Promise<{added:number, total:number}>} added=本次新并入条数（域+概念），total=包内概念总数
 */
export async function mergeConceptCatalogFromPackage(json) {
  const pkgCat = json && typeof json === 'object' ? json.conceptCatalog : null;
  if (!pkgCat || typeof pkgCat !== 'object') return { added: 0, total: 0 };
  const pkgDomains = Array.isArray(pkgCat.domains) ? pkgCat.domains.filter((d) => d && d.id) : [];
  const pkgConcepts = Array.isArray(pkgCat.concepts) ? pkgCat.concepts.filter((c) => c && c.id) : [];
  const total = pkgConcepts.length;
  if (!pkgDomains.length && !pkgConcepts.length) return { added: 0, total: 0 };

  const local = (await getConceptCatalog()) || { domains: [], concepts: [] };
  const localDomainIds = new Set((local.domains || []).map((d) => d.id));
  const localConceptIds = new Set((local.concepts || []).map((c) => c.id));
  const merged = {
    domains: (local.domains || []).slice(),
    concepts: (local.concepts || []).slice(),
  };
  let added = 0;          // 新并入概念数（与 CLI concepts_added 同口径）
  let domainsAdded = 0;   // 新并入域数（与 CLI concept_domains_added 同口径）
  for (const d of pkgDomains) {
    const nd = normalizeDomainDef(d);
    if (!nd.id || localDomainIds.has(nd.id)) continue;
    merged.domains.push(nd);
    localDomainIds.add(nd.id);
    domainsAdded += 1;
  }
  for (const c of pkgConcepts) {
    const nc = normalizeConceptDef(c);
    if (!nc.id || localConceptIds.has(nc.id)) continue;
    // 域引用兜底：概念指向的域若两端都没有，归入第一个已有域（无域则建 uncategorized）
    if (!localDomainIds.has(nc.domain)) {
      nc.domain = merged.domains.length ? merged.domains[0].id : 'uncategorized';
    }
    merged.concepts.push(nc);
    localConceptIds.add(nc.id);
    added += 1;
  }
  if (!merged.domains.length) {
    merged.domains.push(normalizeDomainDef({ id: 'uncategorized', name: '未分类' }));
  }
  await saveConceptCatalog(merged);
  return { added, domainsAdded, total };
}

/**
 * 导入笔记包：清空重建。
 * @param {object|Array} json  { notes: [...], books: [...] } / { notes: [...] } / 直接传笔记数组
 * @returns {Promise<number>}  导入的笔记数量
 */
export async function importNotePackage(json) {
  if (json && !Array.isArray(json) && json.imageFiles) {
    await ingestImageFiles(json.imageFiles);   // 迁移包图片落仓（渲染经 SW 供图）
  }
  if (json && !Array.isArray(json)) {
    await mergeConceptCatalogFromPackage(json);   // 包内概念目录增量并入（fail-fast，写笔记前）
  }
  const list = Array.isArray(json)
    ? json
    : json && Array.isArray(json.notes)
      ? json.notes
      : [];
  const notes = list.map((raw, i) => normalizeNote(raw, i));
  await replaceAll(notes);
  if (json && !Array.isArray(json) && Array.isArray(json.books)) {
    await saveBooks(json.books);
  }
  return notes.length;
}

/* ── 导入差异对比 / 合并（多终端合并契约 v2）────────────── */

/** id 匹配键（无 id 返回空串） */
function idKey(rec) {
  const id = rec && rec.id != null ? String(rec.id).trim() : '';
  return id ? `id:${id}` : '';
}

/** 回退匹配键：type+book+title+date（旧数据无 id 时用） */
function fbKey(rec) {
  return `fb:${rec.type || 'note'}|${rec.book || ''}|${rec.title || ''}|${rec.date || ''}`;
}

/**
 * 对比导入包与本端数据（id 优先，无 id / id 未命中时回退 type+book+title+date）。
 * @returns {{added:Array, updated:Array, localNewer:Array, unchanged:number, localOnly:number}}
 *   updated = 包内较新（将用包覆盖）；localNewer = 本端较新（合并时保留本端）
 */
export async function diffNotePackage(json) {
  const list = Array.isArray(json)
    ? json
    : json && Array.isArray(json.notes) ? json.notes : [];
  const local = await getAllNotes();
  const localMap = new Map();
  for (const n of local) {
    const ik = idKey(n);
    if (ik) localMap.set(ik, n);
    localMap.set(fbKey(n), n);
  }
  const fallbackTs = json && json.exportedAt ? new Date(json.exportedAt).getTime() : 0;
  const diff = { added: [], updated: [], localNewer: [], unchanged: 0, localOnly: 0 };
  const pkgIdKeys = new Set();
  const pkgFbKeys = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const ik = idKey(item);
    if (ik) pkgIdKeys.add(ik);
    const fk = fbKey(item);
    pkgFbKeys.add(fk);
    let localRec = ik ? localMap.get(ik) : undefined;
    if (!localRec) localRec = localMap.get(fk);   // 无 id 或 id 未命中 → 回退
    const pkgTs = Number(item.updatedAt) || fallbackTs;
    if (!localRec) { diff.added.push(item); continue; }
    const localTs = Number(localRec.updatedAt) || 0;
    if (pkgTs > localTs) diff.updated.push(item);
    else if (pkgTs < localTs) diff.localNewer.push(item);
    else diff.unchanged += 1;
  }
  for (const n of local) {
    const ik = idKey(n);
    const matched = (ik && pkgIdKeys.has(ik)) || pkgFbKeys.has(fbKey(n));
    if (!matched) diff.localOnly += 1;
  }
  return diff;
}

/**
 * 汇总导入包的标签/概念规模（导入对话框统计行，需求 20260905-批次一 F1）。
 * @returns {{total:number, tagRecords:number, tagKinds:number, conceptRecords:number, conceptKinds:number}}
 *   tagRecords/conceptRecords = 携带标签/概念的记录数；tagKinds/conceptKinds = 去重后的标签/概念个数
 * 纯函数（浏览器与 node 均可调用）；口径与 normalizeTags/normalizeConcepts 一致。
 */
export function summarizePackage(json) {
  const list = Array.isArray(json)
    ? json
    : json && Array.isArray(json.notes) ? json.notes : [];
  const tagRecs = new Set();
  const tagVals = new Set();
  const conRecs = new Set();
  const conVals = new Set();
  for (const n of list) {
    if (!n || typeof n !== 'object') continue;
    const key = n.id != null ? String(n.id) : (n.title || String(tagRecs.size + conRecs.size));
    for (const t of normalizeTags(n.tags)) {
      tagRecs.add(key);
      tagVals.add(t);
    }
    for (const c of normalizeConcepts(n.concepts)) {
      conRecs.add(key);
      conVals.add(c.id);
    }
  }
  return {
    total: list.length,
    tagRecords: tagRecs.size,
    tagKinds: tagVals.size,
    conceptRecords: conRecs.size,
    conceptKinds: conVals.size,
  };
}

/**
 * 按策略应用导入包。策略：merge=智能合并（新增+包内较新覆盖，本端较新保留）
 * / new=仅新增 / replace=完整替换。books 一律按包覆盖。
 * 包内概念目录（conceptCatalog）一律**增量并入**工作副本：只补缺，不覆盖本端已有
 * （需求 20260905-批次二 F2b；去敏红线：仅落本机 IndexedDB，不回写服务器/仓库）。
 * @returns {Promise<{applied:number, diff:object, catalogAdded:number, catalogTotal:number}>}
 */
export async function mergeNotePackage(json, strategy) {
  if (json && !Array.isArray(json) && json.imageFiles) {
    await ingestImageFiles(json.imageFiles);   // 迁移包图片落仓（两种策略都落，不依赖记录合并结果）
  }
  const catalogStats = (json && !Array.isArray(json))
    ? await mergeConceptCatalogFromPackage(json)
    : { added: 0, domainsAdded: 0, total: 0 };
  const list = Array.isArray(json)
    ? json
    : json && Array.isArray(json.notes) ? json.notes : [];
  const diff = await diffNotePackage(json);
  let applied = 0;
  if (strategy === 'replace') {
    const notes = list.map((raw, i) => normalizeNote(raw, i));
    await replaceAll(notes);
    applied = notes.length;
  } else {
    const items = strategy === 'new'
      ? diff.added
      : diff.added.concat(diff.updated);
    for (const item of items) {
      await addNote(normalizeNote(item, 0));
      applied += 1;
    }
  }
  if (json && !Array.isArray(json) && Array.isArray(json.books)) {
    await saveBooks(json.books);
  }
  return {
    applied,
    diff,
    catalogAdded: catalogStats.added,
    catalogDomainsAdded: catalogStats.domainsAdded,
    catalogTotal: catalogStats.total,
  };
}

/**
 * 导出笔记包（含书籍元信息 + 概念目录工作副本，往返一致）。
 * conceptCatalog 为可选字段（向后兼容：旧端导入忽略）；仅携带本地工作副本，
 * 电脑端 CLI export-json 对称携带 concepts.yaml（去敏约束：包/目录只随用户迁移，不入公开仓）。
 * @returns {Promise<{notes: Array, books: Array, conceptCatalog?: object, exportedAt: string, schemaVersion: number}>}
 */
export async function exportNotePackage(opts = {}) {
  const { notes: prefiltered, includeImages = false, fetcher } = opts;
  const [allNotes, books, catalog] = await Promise.all([getAllNotes(), getAllBooksRaw(), getConceptCatalog()]);
  const notes = Array.isArray(prefiltered) ? prefiltered : allNotes;
  const pkg = { notes, books, exportedAt: new Date().toISOString(), schemaVersion: 2 };
  if (catalog && (catalog.concepts || []).length) {
    pkg.conceptCatalog = { domains: catalog.domains || [], concepts: catalog.concepts || [] };
  }
  if (includeImages) {
    const { imageFiles } = await collectImageFiles(notes, fetcher);
    if (Object.keys(imageFiles).length) pkg.imageFiles = imageFiles;
  }
  return pkg;
}

/**
 * 读取全部记录，按 date 降序排列（无日期记录排最后）。
 * @param {string} [type]  按类型过滤：'note' / 'diary' / 自定义；缺省返回全部
 */
export async function getAllNotes(type) {
  const db = await openDB();
  const notes = await new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  const filtered = type ? notes.filter((n) => (n.type || 'note') === type) : notes;
  filtered.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return filtered;
}

/** 按 id 直查单条记录（无则 null）——详情页 note.html 使用 */
export async function getNoteById(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(String(id));
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/** 全库去重项目名（按 updatedAt 降序，datalist/筛选下拉用） */
export async function getAllProjects() {
  const all = await getAllNotes();
  const seen = new Set();
  for (const n of all) {
    const p = String(n.project || '').trim();
    if (p) seen.add(p);
  }
  return [...seen];
}

/** 笔记总数 */
export async function countNotes() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 新增/更新单条笔记（按 id 覆盖）。
 * 典型用法：{ title, book, date, readerNote, aiNote, imageData }
 * @returns {Promise<string>} 笔记 id
 */
export async function addNote(note) {
  const rec = normalizeNote(note, 0);
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return rec.id;
}

/** 删除单条笔记 */
export async function deleteNote(id) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(String(id));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ══════════════════════════════════════════════════════════
   概念目录管理（PWA 阶段二，本地工作副本）
   与 CLI concept_catalog.py 保持同一套校验规则：
     · id 唯一
     · domain 须在 domains 表
     · 编辑字段 ∈ id|name|domain|aliases|keywords|related|description（列表类整段替换）
     · 删除默认保护：被笔记/日记引用时拒绝（需 force 并同步清除引用标注）
   改动仅存本地 IndexedDB；生效路径有二——概念管理页「重新计算图谱」本机直接重算
     （concepts.js + graph-build.js），或「导出 concepts.yaml」带回电脑端跑 CLI（跨终端同步用）。
   ══════════════════════════════════════════════════════════ */

/* 概念目录工作副本（单条记录 id='main'） */
const CONCEPT_CATALOG_KEY = 'main';

function _strList(value) {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const seen = new Set();
  const out = [];
  for (const v of raw) {
    const s = String(v).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** 规整一组概念记录：字段补全 / 列表规整，不校验（供载入） */
function normalizeConceptDef(c) {
  return {
    id: String(c && c.id != null ? c.id : '').trim(),
    name: String(c && c.name != null ? c.name : '').trim(),
    domain: String(c && c.domain != null ? c.domain : '').trim(),
    aliases: _strList(c && c.aliases),
    keywords: _strList(c && c.keywords),
    notes: _strList(c && c.notes),
    related: _strList(c && c.related),
    description: String(c && c.description != null ? c.description : '').trim(),
  };
}

/** 规整一条域定义 */
function normalizeDomainDef(d) {
  return {
    id: String(d && d.id != null ? d.id : '').trim(),
    name: String(d && d.name != null ? d.name : '').trim() || String(d && d.id != null ? d.id : '').trim(),
    color: String(d && d.color != null ? d.color : '').trim(),
  };
}

/**
 * 校验概念目录：id 唯一 + domain 存在 + 基本字段非空。抛 Error（中文），返回 true。（导出供差分测试）
 */
export function validateConceptCatalog(catalog) {
  const domains = (catalog && catalog.domains) || [];
  const concepts = (catalog && catalog.concepts) || [];
  const ids = new Set();
  for (const d of domains) {
    if (d.id) ids.add(d.id);
  }
  const seen = new Set();
  for (const c of concepts) {
    if (!c || !c.id) continue;
    if (seen.has(c.id)) {
      throw new Error(`概念 id 重复：${c.id}`);
    }
    seen.add(c.id);
    if (c.domain && !ids.has(c.domain)) {
      throw new Error(`概念「${c.id}」的域「${c.domain}」不存在`);
    }
  }
  return true;
}

/** 读取概念目录工作副本；无则返回 null */
export async function getConceptCatalog() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(CONCEPTS_STORE, 'readonly').objectStore(CONCEPTS_STORE).get(CONCEPT_CATALOG_KEY);
    req.onsuccess = () => resolve(req.result ? req.result.catalog : null);
    req.onerror = () => reject(req.error);
  });
}

/** 全量保存概念目录工作副本（覆盖） */
export async function saveConceptCatalog(catalog) {
  validateConceptCatalog(catalog);
  const clean = {
    domains: ((catalog && catalog.domains) || []).map(normalizeDomainDef).filter((d) => d.id),
    concepts: ((catalog && catalog.concepts) || []).map(normalizeConceptDef).filter((c) => c.id),
  };
  validateConceptCatalog(clean);
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(CONCEPTS_STORE, 'readwrite');
    tx.objectStore(CONCEPTS_STORE).put({ id: CONCEPT_CATALOG_KEY, catalog: clean });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return clean;
}

/** 概念列表（按域排序） */
export async function getAllConcepts() {
  const catalog = await getConceptCatalog();
  const concepts = (catalog && catalog.concepts) || [];
  const domains = (catalog && catalog.domains) || [];
  const domainRank = new Map(domains.map((d, i) => [d.id, i]));
  return concepts.slice().sort((a, b) =>
    (domainRank.get(a.domain) ?? 999) - (domainRank.get(b.domain) ?? 999)
    || a.name.localeCompare(b.name, 'zh'));
}

/** 域列表 */
export async function getAllDomains() {
  const catalog = await getConceptCatalog();
  return (catalog && catalog.domains) || [];
}

/** 找单个概念（不存在返回 null） */
export async function getConceptById(cid) {
  const concepts = await getAllConcepts();
  return concepts.find((c) => c.id === cid) || null;
}

/**
 * 新增概念。参数与 CLI concept new 一致。校验后写入。
 * @returns {Promise<object>} 新增后的概念记录
 */
export async function addConcept({ id, name, domain, aliases = '', keywords = '', related = '', description = '' }) {
  const catalog = await getConceptCatalog() || { domains: [], concepts: [] };
  const cid = String(id || '').trim();
  const cname = String(name || '').trim();
  const cdomain = String(domain || '').trim();
  if (!cid) throw new Error('概念 id 不能为空');
  if (!cname) throw new Error('概念名称不能为空');
  const domainIds = new Set((catalog.domains || []).map((d) => d.id));
  if (!domainIds.has(cdomain)) {
    const avail = [...domainIds].sort().join('、') || '（暂无已定义域）';
    throw new Error(`域「${cdomain}」不存在，可选域：${avail}`);
  }
  if (catalog.concepts.some((c) => c.id === cid)) {
    throw new Error(`概念 id「${cid}」已存在，请换一个 id`);
  }
  const concept = normalizeConceptDef({
    id: cid, name: cname, domain: cdomain,
    aliases, keywords, related, description,
  });
  catalog.concepts.push(concept);
  await saveConceptCatalog(catalog);
  return concept;
}

/** 可编辑字段（与 CLI 一致） */
export const CONCEPT_EDITABLE_FIELDS = ['id', 'name', 'domain', 'aliases', 'keywords', 'related', 'description'];

/**
 * 编辑概念字段。与 CLI concept edit 一致（--field id 为改名，v1 不迁移引用）。
 * @returns {Promise<{concept:object, warning:string|null}>}
 */
export async function editConcept(cid, field, value) {
  const catalog = await getConceptCatalog() || { domains: [], concepts: [] };
  if (!CONCEPT_EDITABLE_FIELDS.includes(field)) {
    throw new Error(`不支持的字段：${field}（可选：${CONCEPT_EDITABLE_FIELDS.join(' | ')}）`);
  }
  const target = catalog.concepts.find((c) => c.id === cid);
  if (!target) throw new Error(`概念「${cid}」不存在于概念目录`);
  let warning = null;
  if (field === 'aliases' || field === 'keywords' || field === 'related') {
    target[field] = _strList(value);
  } else if (field === 'id') {
    const newId = String(value || '').trim();
    if (!newId) throw new Error('概念 id 不能为空');
    if (catalog.concepts.some((c) => c.id === newId)) {
      throw new Error(`概念 id「${newId}」已存在`);
    }
    const refs = await scanConceptReferences(cid);
    if (refs.length) warning = `存在 ${refs.length} 处引用（v1 不自动迁移）`;
    target.id = newId;
  } else {
    target[field] = String(value == null ? '' : value).trim();
    if (field === 'domain' && target[field] && !(catalog.domains || []).some((d) => d.id === target[field])) {
      throw new Error(`域「${target[field]}」不存在`);
    }
  }
  await saveConceptCatalog(catalog);
  return { concept: target, warning };
}

/**
 * 扫描某概念 id 被哪些本地笔记/日记引用（记录 concepts 含该 id）。
 * @returns {Promise<Array<{type:string, title:string, id:string}>>}
 */
export async function scanConceptReferences(cid) {
  const all = await getAllNotes();
  const out = [];
  for (const n of all) {
    const concepts = Array.isArray(n.concepts) ? n.concepts : [];
    const hit = concepts.some((c) => {
      let cid2 = '';
      if (typeof c === 'string') cid2 = c.trim();
      else if (c && typeof c === 'object') cid2 = String(c.id || '').trim();
      return cid2 === cid;
    });
    if (hit) out.push({ type: n.type || 'note', title: n.title || '未命名', id: n.id });
  }
  return out;
}

/**
 * 删除概念。默认保护：被本地笔记/日记引用时拒绝；force 时先清除引用标注再删。
 * @returns {Promise<{deleted:object, clearedReferences:number}>}
 */
export async function deleteConcept(cid, { force = false } = {}) {
  const catalog = await getConceptCatalog() || { domains: [], concepts: [] };
  const target = catalog.concepts.find((c) => c.id === cid);
  if (!target) throw new Error(`概念「${cid}」不存在于概念目录`);
  const refs = await scanConceptReferences(cid);
  if (refs.length && !force) {
    throw new Error(`概念「${cid}」被 ${refs.length} 处引用，拒绝删除（force 可强制删除并清除引用）`);
  }
  if (refs.length) {
    // force：逐条清除引用标注
    for (const r of refs) {
      await _removeConceptFromNote(r.id, cid);
    }
  }
  catalog.concepts = catalog.concepts.filter((c) => c.id !== cid);
  await saveConceptCatalog(catalog);
  return { deleted: target, clearedReferences: refs.length };
}

/** 从单条笔记移除指定概念标注（internal，供 force 删除用） */
async function _removeConceptFromNote(noteId, cid) {
  const all = await getAllNotes();
  const note = all.find((n) => n.id === noteId);
  if (!note) return;
  const concepts = (note.concepts || []).filter((c) => {
    let cid2 = '';
    if (typeof c === 'string') cid2 = c.trim();
    else if (c && typeof c === 'object') cid2 = String(c.id || '').trim();
    return cid2 !== cid;
  });
  await addNote({ ...note, concepts, updatedAt: Date.now() });
}

/**
 * 从 JSON 载入概念目录工作副本（覆盖）。
 * 接受：{domains, concepts}  或  CLI `concept list --json` 的裸概念数组。
 * 返回规范化后的 {domains, concepts}。
 */
export async function importConceptCatalog(json) {
  let domains = [];
  let concepts = [];
  if (Array.isArray(json)) {
    concepts = json;
  } else if (json && typeof json === 'object') {
    domains = json.domains || [];
    concepts = json.concepts || [];
  }
  const clean = {
    domains: (Array.isArray(domains) ? domains : []).map(normalizeDomainDef).filter((d) => d.id),
    concepts: (Array.isArray(concepts) ? concepts : []).map(normalizeConceptDef).filter((c) => c.id),
  };
  validateConceptCatalog(clean);
  await saveConceptCatalog(clean);
  return clean;
}

/** 从 graph.json 结构生成工作副本（graph.json 概念缺 aliases/keywords，容缺失） */
export async function importConceptCatalogFromGraph(graph) {
  const domains = (graph && graph.domains) || [];
  const concepts = (graph && graph.concepts) || [];
  return importConceptCatalog({ domains, concepts });
}

/** 域 id → 显示名映射 */
export async function getDomainNameMap() {
  const domains = await getAllDomains();
  const map = {};
  for (const d of domains) map[d.id] = d.name || d.id;
  return map;
}

/** 把单个值格式化为 YAML 块列表缩进 */
function _yamlList(items, indent) {
  const pad = ' '.repeat(indent);
  return items.map((it) => `${pad}- ${typeof it === 'string' ? it : JSON.stringify(it)}`).join('\n');
}

/**
 * 导出当前工作副本为 concepts.yaml 文本（与根 concepts.yaml 结构/格式一致）。
 * 仅输出存在的字段（domain 无 color 时省略 color），便于用户拷贝回电脑端。
 * @returns {Promise<string>} YAML 文本
 */
export async function exportConceptCatalogYaml() {
  const catalog = await getConceptCatalog() || { domains: [], concepts: [] };
  const lines = [];
  lines.push('domains:');
  for (const d of catalog.domains || []) {
    lines.push(`- id: ${d.id}`);
    lines.push(`  name: ${d.name}`);
    if (d.color) lines.push(`  color: '${d.color}'`);
  }
  lines.push('concepts:');
  for (const c of catalog.concepts || []) {
    lines.push(`- id: ${c.id}`);
    lines.push(`  name: ${c.name}`);
    lines.push(`  domain: ${c.domain}`);
    if (Array.isArray(c.aliases) && c.aliases.length) {
      lines.push('  aliases:');
      for (const a of c.aliases) lines.push(`  - ${a}`);
    }
    if (Array.isArray(c.keywords) && c.keywords.length) {
      lines.push('  keywords:');
      for (const k of c.keywords) lines.push(`  - ${k}`);
    }
    if (Array.isArray(c.notes) && c.notes.length) {
      lines.push('  notes:');
      for (const n of c.notes) lines.push(`  - ${n}`);
    }
    if (Array.isArray(c.related) && c.related.length) {
      lines.push('  related:');
      for (const r of c.related) lines.push(`  - ${r}`);
    }
    if (c.description) {
      // 多行描述用块标量；单行用普通字符串
      const desc = String(c.description);
      if (desc.includes('\n')) {
        lines.push(`  description: |`);
        for (const dl of desc.split('\n')) lines.push(`    ${dl}`);
      } else {
        lines.push(`  description: ${desc}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

/* ══════════════════════════════════════════════════════════
   本机图谱存档（阶段二：PWA 浏览器端重算 union 图谱）
   graph_local store 单条记录 id='union'：
     { id: 'union', graph: <buildUnionGraph 输出>, builtAt: <ISO 时间>, source: 'local' }
   与 CLI 静态产物 app/pwa/graph.json 相互独立：图谱页优先读本机结果，
   清除后回退 CLI 产物。算法来自 graph-build.js（纯函数），本层只管存取。
   ══════════════════════════════════════════════════════════ */

const GRAPH_LOCAL_KEY = 'union';

/**
 * 保存本机重算图谱（单条记录，覆盖写）。
 * @param {object} graph  buildUnionGraph 的输出，须含 notes/domains/concepts/edges
 *                        数组与 stats 对象（graph.json schema）；不合法抛中文 Error
 * @returns {Promise<{id:string, graph:object, builtAt:string, source:string}>} 完整记录
 */
export async function saveLocalGraph(graph) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new Error('saveLocalGraph：图谱数据不合法（须为 graph.json 结构的对象）');
  }
  if (!Array.isArray(graph.notes) || !Array.isArray(graph.domains)
    || !Array.isArray(graph.concepts) || !Array.isArray(graph.edges)
    || !graph.stats || typeof graph.stats !== 'object') {
    throw new Error('saveLocalGraph：图谱缺少 notes/domains/concepts/edges/stats 字段，已拒绝写入');
  }
  const record = {
    id: GRAPH_LOCAL_KEY,
    graph,
    builtAt: new Date().toISOString(),
    source: 'local',
  };
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(GRAPH_LOCAL_STORE, 'readwrite');
    tx.objectStore(GRAPH_LOCAL_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return record;
}

/**
 * 读取本机重算图谱记录。
 * @returns {Promise<object|null>} 记录 { id, graph, builtAt, source }；无记录返回 null
 *   （IndexedDB 读失败时抛错，由调用方决定回退策略）
 */
export async function getLocalGraph() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(GRAPH_LOCAL_STORE, 'readonly')
      .objectStore(GRAPH_LOCAL_STORE).get(GRAPH_LOCAL_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/** 清除本机重算图谱（删除单条记录），图谱页回退 CLI 静态产物 */
export async function clearLocalGraph() {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(GRAPH_LOCAL_STORE, 'readwrite');
    tx.objectStore(GRAPH_LOCAL_STORE).delete(GRAPH_LOCAL_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/* ══════════════════════════════════════════════════════════
   图片自包含仓（需求：PWA 图片自包含与同步语义）
   image_store：path → Blob。两条写入来源：
     · 迁移包导入（pkg.imageFiles 的 dataURL 落库）
     · SW 网络回填（/assets/* 命中网络后写回，见 sw.js）
   读取：SW fetch 拦截 /assets/*（离线/无服务器场景图片仍可达）。
   ══════════════════════════════════════════════════════════ */

/** dataURL → Blob（imageFiles 摄取用） */
function _dataUrlToBlob(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(String(dataUrl));
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  if (!m[2]) {
    try { return new Blob([decodeURIComponent(m[3])], { type: mime }); } catch { return null; }
  }
  const bin = atob(m[3]);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

/** 写入单张图片（path → Blob/dataURL） */
export async function putImageFile(path, data) {
  const p = String(path || '');
  if (!p) throw new Error('putImageFile：path 缺失');
  const blob = data instanceof Blob ? data : _dataUrlToBlob(data);
  if (!blob) throw new Error('putImageFile：数据无法解析为 Blob（需 Blob 或 dataURL）');
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE, 'readwrite');
    tx.objectStore(IMAGE_STORE).put({ path: p, blob, updatedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return p;
}

/** 读取单张图片（无则 null） */
export async function getImageFile(path) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(IMAGE_STORE, 'readonly').objectStore(IMAGE_STORE).get(String(path));
    req.onsuccess = () => resolve(req.result ? req.result.blob : null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 摄取迁移包的 imageFiles（{ 'assets/…': dataURL }）→ 逐条写入 image_store。
 * @returns {Promise<number>} 摄取张数
 */
export async function ingestImageFiles(imageFiles) {
  if (!imageFiles || typeof imageFiles !== 'object') return 0;
  let n = 0;
  for (const [path, data] of Object.entries(imageFiles)) {
    try { await putImageFile(path, data); n++; } catch { /* 单张失败不阻断 */ }
  }
  return n;
}

/**
 * 收集范围内笔记引用的图片 → imageFiles 映射（导出迁移包含图）。
 * @param {Array<object>} notes  已按范围过滤的记录
 * @param {Function} [fetcher]  取图函数（默认 fetch；可注入便于单测）——返回 Response-like
 * @returns {Promise<{imageFiles: object, missing: string[]}>}
 */
export async function collectImageFiles(notes, fetcher) {
  const f = fetcher || (typeof fetch === 'function' ? fetch : null);
  const paths = [];
  const seen = new Set();
  for (const n of notes || []) {
    for (const img of Array.isArray(n.images) ? n.images : []) {
      const p = String(img);
      if (p && !seen.has(p)) { seen.add(p); paths.push(p); }
    }
  }
  const imageFiles = {};
  const missing = [];
  for (const p of paths) {
    try {
      // 本地仓优先（SW 场景下 fetch 本身会走拦截，但显式查仓可离线且省请求）
      const local = await getImageFile(p);
      if (local) {
        imageFiles[p] = await _blobToDataUrl(local);
        continue;
      }
      if (!f) { missing.push(p); continue; }
      const resp = await f(p);
      if (!resp || !resp.ok) { missing.push(p); continue; }
      const blob = await resp.blob();
      imageFiles[p] = await _blobToDataUrl(blob);
    } catch {
      missing.push(p);
    }
  }
  return { imageFiles, missing };
}

function _blobToDataUrl(blob) {
  // 浏览器：FileReader；node 测试环境无 FileReader → arrayBuffer + Buffer 回退
  if (typeof FileReader === 'function') {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }
  return blob.arrayBuffer().then((buf) =>
    `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`);
}

/* 挂到 window，便于页面与控制台调用 */
window.importNotePackage = importNotePackage;
window.exportNotePackage = exportNotePackage;
window.diffNotePackage = diffNotePackage;
window.mergeNotePackage = mergeNotePackage;
window.saveBooks = saveBooks;
window.saveBook = saveBook;
window.getAllBooks = getAllBooks;
window.getAllBooksRaw = getAllBooksRaw;
window.getAllTags = getAllTags;
window.renameTag = renameTag;
window.deleteTag = deleteTag;
window.getConceptCatalog = getConceptCatalog;
window.saveConceptCatalog = saveConceptCatalog;
window.getAllConcepts = getAllConcepts;
window.getAllDomains = getAllDomains;
window.getConceptById = getConceptById;
window.addConcept = addConcept;
window.editConcept = editConcept;
window.deleteConcept = deleteConcept;
window.scanConceptReferences = scanConceptReferences;
window.importConceptCatalog = importConceptCatalog;
window.importConceptCatalogFromGraph = importConceptCatalogFromGraph;
window.exportConceptCatalogYaml = exportConceptCatalogYaml;
window.getDomainNameMap = getDomainNameMap;
window.ingestImageFiles = ingestImageFiles;
window.collectImageFiles = collectImageFiles;
window.getNoteById = getNoteById;
window.saveLocalGraph = saveLocalGraph;
window.getLocalGraph = getLocalGraph;
window.clearLocalGraph = clearLocalGraph;
