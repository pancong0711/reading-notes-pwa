/* PWA 本地图谱重算（阶段一）：union 版知识图谱纯函数构建器。
 *
 * 算法真源：app/src/reading_notes/graph.py build_graph_from_notes()（union 规则逐条对齐）：
 *   0) 显式标注最高优先级：笔记 concepts:[{id,source}] 强制连边；同概念双来源时 user 优先
 *   1) 手动关联：concept.notes 按 stem 双向包含匹配（ref in stem || stem in ref）→ 来源 ai
 *   2) 自动命中降噪：name/aliases（长度≥2）在 search_text（=title+"\n"+summary 转小写）
 *      精确子串命中；或 keywords（长度≥2）命中数≥2 → 来源 ai；name 命中优先于 keywords
 *
 * 本模块为纯函数：不依赖 DOM / IndexedDB / fetch / 其他项目文件，浏览器与 node 均可运行。
 * 输出结构 = graph.json schema：
 *   { version, generated_at, label_version:'union', domains, concepts, notes, edges, stats, warnings }
 * 其中 warnings 为目录字段缺失降级说明（不影响主结构；Python 版无此键）。
 */

// 与 app/src/reading_notes/graph.py 的 VERSION 常量一致（write_graph 写入的顶层 version）
export const VERSION = 1;

const SUMMARY_SECTION = '摘要'; // 摘要章节标题（与笔记正文约定一致）

// ── 排序 / 计数工具（对齐 Python 的按 Unicode 码点排序与字符计数）──────────

function cmpCodePoints(a, b) {
  if (a === b) return 0;
  const A = Array.from(a);
  const B = Array.from(b);
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const d = A[i].codePointAt(0) - B[i].codePointAt(0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return A.length === B.length ? 0 : (A.length < B.length ? -1 : 1);
}

function sortedStrings(iterable) {
  return [...iterable].sort(cmpCodePoints);
}

// Python len(str) 语义：按码点计数（避免代理对被计成 2）
function cpLength(s) {
  return Array.from(s).length;
}

// ── 正文解析（对齐 graph.py _extract_summary / _summary_preview）────────────

/** 提取「## 摘要」章节全文；无摘要章节返回 ''。
 * 对齐 Python 正则：^##\s*摘要\s*\n+(.*?)(?=\n##\s|\Z)　(re.S | re.M)
 * - [\s\S]*? ≙ re.S 的 .*?
 * - (?![\s\S]) ≙ \Z（绝对串尾；不能用 m 模式的 $，其会在每个换行前停）
 */
export function extractSummary(rawContent) {
  if (!rawContent) return '';
  const m = /^##\s*摘要\s*\n+([\s\S]*?)(?=\n##\s|(?![\s\S]))/m.exec(rawContent);
  return m ? m[1].trim() : '';
}

/** 摘要正文第一个非空段，折叠换行后截前 200 字（码点）。 */
export function summaryPreview(summary) {
  if (!summary) return '';
  for (const para of summary.split(/\n\s*\n/)) {
    if (!para.trim()) continue;
    return Array.from(para.replace(/\n/g, ' ').trim()).slice(0, 200).join('');
  }
  return '';
}

// ── 输入容错工具 ────────────────────────────────────────────

// 对齐 graph.py _as_str_list：None→[]；字符串→单元素；列表→去空白去空
function asStrList(value, onDegraded) {
  if (value === undefined || value === null) {
    if (onDegraded) onDegraded();
    return [];
  }
  if (typeof value === 'string') {
    const s = value.trim();
    return s ? [s] : [];
  }
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (onDegraded) onDegraded();
  return [];
}

// 笔记 stem 解析：显式 stem ＞ file_path 文件名去扩展名 ＞ PWA id ＞ title
// （PWA 本地笔记通常无文件路径；阶段二接入时以 id 作 stem，即 note-id = note-{id}）
function noteStem(n) {
  if (typeof n.stem === 'string' && n.stem.trim()) return n.stem.trim();
  if (typeof n.file_path === 'string' && n.file_path) {
    const base = n.file_path.split(/[\\/]/).pop() || '';
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    if (stem) return stem;
  }
  if (n.id !== undefined && n.id !== null && String(n.id).trim()) return String(n.id).trim();
  return String(n.title ?? '').trim();
}

function defaultGeneratedAt() {
  // 对齐 Python datetime.now().replace(microsecond=0).isoformat()（本地时间、秒精度、无时区后缀）
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ── 主入口 ──────────────────────────────────────────────────

/**
 * 构建 union 版知识图谱（返回结构 = graph.json schema）。
 *
 * @param {object} catalog { domains, concepts, notes }
 *   - domains: [{id, name, color}]
 *   - concepts: 完整概念目录 [{id, name, domain, description, aliases, keywords, notes, related}]；
 *     条目缺 aliases/keywords 时按空数组容错并记入 warnings（自动命中降级，
 *     显式标注与 notes 手动关联仍生效）
 *   - notes: 本地书籍笔记数组 [{stem?, file_path?, id?, title, content, book?, date?,
 *     tags?, pages?, concepts?: [{id, source}]}]，content 含「## 摘要」节
 * @param {object} [opts] { now?: string } 注入 generated_at（ISO 字符串），供测试对比
 * @returns graph.json 结构对象（附加 warnings 数组）
 */
export function buildUnionGraph({ domains, concepts, notes } = {}, { now } = {}) {
  const warnings = [];

  // ── 目录规整（对齐 load_concepts 的字段容错）──
  const domainDefs = (domains || []).map((d) => ({
    id: String(d.id ?? '').trim(),
    name: String(d.name ?? '').trim() || String(d.id ?? '').trim(),
    color: String(d.color ?? '').trim(),
  })).filter((d) => d.id);

  const conceptDefs = [];
  const seenConceptIds = new Set();
  for (const c of concepts || []) {
    const cid = String(c.id ?? c.name ?? '').trim();
    if (!cid || seenConceptIds.has(cid)) continue;
    seenConceptIds.add(cid);
    const degraded = [];
    const aliases = asStrList(c.aliases, () => degraded.push('aliases'));
    const keywords = asStrList(c.keywords, () => degraded.push('keywords'));
    if (degraded.length) {
      warnings.push(
        `概念「${String(c.name ?? cid).trim()}」(${cid}) 缺少 ${degraded.join('/')} 字段，`
        + '已按空数组降级：自动命中可能退化（显式标注与 notes 匹配仍生效）；'
        + '上传完整目录可启用自动匹配',
      );
    }
    conceptDefs.push({
      id: cid,
      name: String(c.name ?? cid).trim() || cid,
      domain: String(c.domain ?? '').trim(),
      description: c.description === undefined || c.description === null ? '' : String(c.description),
      aliases,
      keywords,
      notes: asStrList(c.notes),
      related: asStrList(c.related),
    });
  }
  const domainIds = new Set(domainDefs.map((d) => d.id));
  const conceptIds = new Set(conceptDefs.map((c) => c.id));

  // ── 笔记收集（对齐 _collect_notes_data；跨书同名 note_id 只取第一篇）──
  const seenNoteIds = new Set();
  const notesData = [];
  for (const n of notes || []) {
    const stem = noteStem(n);
    if (!stem) continue;
    const noteId = `note-${stem}`;
    if (seenNoteIds.has(noteId)) continue;
    seenNoteIds.add(noteId);

    const rawContent = n.content === undefined || n.content === null ? '' : String(n.content);
    const summary = extractSummary(rawContent);
    // 显式标注的概念标签：同概念双来源时 user 优先（与 Python 收集逻辑一致）
    const explicitConcepts = {};
    for (const c of n.concepts || []) {
      const isObj = c !== null && typeof c === 'object';
      const cid = String(isObj ? (c.id ?? '') : c).trim();
      if (!cid) continue;
      const src = (isObj ? String(c.source ?? '').trim() : '') || 'user';
      if (!(cid in explicitConcepts) || src === 'user') explicitConcepts[cid] = src;
    }
    const title = n.title === undefined || n.title === null ? '' : String(n.title);
    notesData.push({
      note: n,
      stem,
      noteId,
      title,
      book: n.book === undefined || n.book === null ? '' : String(n.book),
      date: n.date ? String(n.date) : '',
      tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
      pages: n.pages ? String(n.pages) : '',
      summary,
      searchText: `${title}\n${summary}`.toLowerCase(), // 大小写不敏感的自动命中文本
      explicitConcepts,
      conceptLabels: {}, // concept_id -> Set(user|ai)
    });
  }

  // ── 概念 → 笔记归属（belongs_to 集合；三趟扫描顺序与 Python 一致，
  //    保证 concept_labels / concept_sources 的键插入序一致）──
  const conceptNotes = new Map();
  for (const c of conceptDefs) conceptNotes.set(c.id, new Set());
  const addLabel = (nd, cid, label) => {
    let s = nd.conceptLabels[cid];
    if (!s) {
      s = new Set();
      nd.conceptLabels[cid] = s;
    }
    s.add(label);
  };

  for (const c of conceptDefs) {
    const cid = c.id;
    const target = conceptNotes.get(cid);
    // 0) 显式标注（最高优先级）：强制连边并按 source 标记
    for (const nd of notesData) {
      if (Object.prototype.hasOwnProperty.call(nd.explicitConcepts, cid)) {
        target.add(nd.noteId);
        addLabel(nd, cid, nd.explicitConcepts[cid]);
      }
    }
    // 1) 手动关联：notes 字段按笔记文件名双向包含匹配（AI 侧维护，标记 ai）
    for (const ref of c.notes) {
      if (!ref) continue;
      for (const nd of notesData) {
        if (ref.includes(nd.stem) || nd.stem.includes(ref)) {
          target.add(nd.noteId);
          addLabel(nd, cid, 'ai');
        }
      }
    }
    // 2) 自动命中（降噪版）：强信号 name/alias 精确出现（continue，跳过弱信号）；
    //    弱信号 keywords 命中数≥2 → 标记 ai
    const nameAliasTerms = [c.name, ...c.aliases].filter((t) => t && cpLength(t) >= 2);
    const kwTerms = c.keywords.filter((t) => t && cpLength(t) >= 2);
    for (const nd of notesData) {
      const text = nd.searchText;
      if (nameAliasTerms.some((t) => text.includes(t.toLowerCase()))) {
        target.add(nd.noteId);
        addLabel(nd, cid, 'ai');
        continue;
      }
      if (kwTerms.length > 0) {
        const hits = kwTerms.filter((t) => text.includes(t.toLowerCase())).length;
        if (hits >= 2) {
          target.add(nd.noteId);
          addLabel(nd, cid, 'ai');
        }
      }
    }
  }

  // 笔记 → 概念 / 域 反向索引
  const noteConcepts = new Map(); // note_id -> Set(concept_id)，仅含至少归属一个概念的笔记
  for (const c of conceptDefs) {
    for (const nid of conceptNotes.get(c.id)) {
      if (!noteConcepts.has(nid)) noteConcepts.set(nid, new Set());
      noteConcepts.get(nid).add(c.id);
    }
  }
  const domainOf = new Map(conceptDefs.map((c) => [c.id, c.domain]));

  // ── domains 输出（concept_count / note_count）──
  const domainsOut = domainDefs.map((d) => {
    const dconcepts = conceptDefs.filter((c) => c.domain === d.id);
    const dnotes = new Set();
    for (const c of dconcepts) {
      for (const nid of conceptNotes.get(c.id)) dnotes.add(nid);
    }
    return {
      id: d.id,
      name: d.name,
      color: d.color,
      concept_count: dconcepts.length,
      note_count: dnotes.size,
    };
  });

  // ── concepts 输出 ──
  const relatedMap = new Map();
  for (const c of conceptDefs) {
    relatedMap.set(c.id, sortedStrings(
      new Set(c.related.filter((r) => conceptIds.has(r) && r !== c.id)),
    ));
  }
  const conceptsOut = conceptDefs.map((c) => {
    const nids = sortedStrings(conceptNotes.get(c.id));
    return {
      id: c.id,
      name: c.name,
      domain: c.domain,
      description: c.description,
      note_count: nids.length,
      related: relatedMap.get(c.id) || [],
      notes: nids,
    };
  });

  // ── notes 输出 ──
  const notesOut = notesData.map((nd) => {
    const conceptSources = {};
    for (const cid of Object.keys(nd.conceptLabels)) {
      conceptSources[cid] = sortedStrings(nd.conceptLabels[cid]);
    }
    const mine = noteConcepts.get(nd.noteId) || new Set();
    const domSet = new Set();
    for (const cid of mine) {
      const dm = domainOf.get(cid);
      if (domainIds.has(dm)) domSet.add(dm);
    }
    return {
      id: nd.noteId,
      title: nd.title,
      book: nd.book,
      date: nd.date,
      tags: [...nd.tags],
      pages: nd.pages,
      summary: summaryPreview(nd.summary),
      concepts: sortedStrings(mine),
      concept_sources: conceptSources,
      domains: sortedStrings(domSet),
    };
  });

  // ── edges ──
  const edges = [];

  // belongs_to：笔记 → 概念（sources/is_user 记录来源染色）
  const ndByNoteId = new Map(notesData.map((nd) => [nd.noteId, nd]));
  for (const cid of sortedStrings(conceptNotes.keys())) {
    for (const nid of sortedStrings(conceptNotes.get(cid))) {
      const labels = ndByNoteId.get(nid).conceptLabels[cid];
      const labelArr = labels && labels.size > 0 ? sortedStrings(labels) : ['ai'];
      edges.push({
        source: nid,
        target: `concept-${cid}`,
        type: 'belongs_to',
        weight: 1,
        sources: labelArr,
        is_user: labelArr.includes('user'),
      });
    }
  }

  // related：概念 ↔ 概念（weight = 共享笔记数 + 声明关系额外 2）
  const pairKey = (x, y) => sortedStrings([x, y]).join('\u0000');
  const declared = new Map();
  for (const c of conceptDefs) {
    for (const r of c.related) {
      if (conceptIds.has(r) && r !== c.id) declared.set(pairKey(c.id, r), true);
    }
  }
  for (let i = 0; i < conceptDefs.length; i++) {
    for (let j = i + 1; j < conceptDefs.length; j++) {
      const a = conceptDefs[i].id;
      const b = conceptDefs[j].id;
      if (a === b) continue;
      let shared = 0;
      for (const nid of conceptNotes.get(a)) {
        if (conceptNotes.get(b).has(nid)) shared++;
      }
      const extra = declared.has(pairKey(a, b)) ? 2 : 0;
      const weight = shared + extra;
      if (weight > 0) {
        const [src, dst] = sortedStrings([a, b]);
        edges.push({
          source: `concept-${src}`,
          target: `concept-${dst}`,
          type: 'related',
          weight,
        });
      }
    }
  }

  // cross_ref：笔记 ↔ 笔记（weight = 共享概念×2 + 共享标签×1，>0 才建边；
  // 只对至少归属一个概念的笔记建交叉引用）
  const noteIdsSorted = sortedStrings(noteConcepts.keys());
  for (let i = 0; i < noteIdsSorted.length; i++) {
    for (let j = i + 1; j < noteIdsSorted.length; j++) {
      const a = noteIdsSorted[i];
      const b = noteIdsSorted[j];
      const ca = noteConcepts.get(a);
      const cb = noteConcepts.get(b);
      let sharedConcepts = 0;
      for (const cid of ca) {
        if (cb.has(cid)) sharedConcepts++;
      }
      const ta = new Set(ndByNoteId.get(a).tags);
      const tb = new Set(ndByNoteId.get(b).tags);
      let sharedTags = 0;
      for (const t of ta) {
        if (tb.has(t)) sharedTags++;
      }
      const weight = sharedConcepts * 2 + sharedTags;
      if (weight > 0) {
        edges.push({ source: a, target: b, type: 'cross_ref', weight });
      }
    }
  }

  edges.sort((e1, e2) => cmpCodePoints(e1.type, e2.type)
    || cmpCodePoints(e1.source, e2.source)
    || cmpCodePoints(e1.target, e2.target));

  // ── stats / 汇总（八键齐全，口径与 Python 一致）──
  const orphanNotes = notesData.filter((nd) => !(noteConcepts.get(nd.noteId)?.size > 0)).length;
  const userTaggedNotes = notesData.filter(
    (nd) => Object.keys(nd.explicitConcepts).length > 0,
  ).length;
  const userEdges = edges.filter((e) => e.type === 'belongs_to' && e.is_user).length;
  const aiEdges = edges.filter((e) => e.type === 'belongs_to' && !e.is_user).length;
  const stats = {
    notes: notesData.length,
    concepts: conceptDefs.length,
    domains: domainDefs.length,
    edges: edges.length,
    orphan_notes: orphanNotes,
    user_tagged_notes: userTaggedNotes,   // 有显式概念标签（含 source=ai）的笔记数
    user_concept_edges: userEdges,        // 用户标注驱动的 belongs_to 边数
    ai_concept_edges: aiEdges,            // AI 侧驱动的 belongs_to 边数
  };

  return {
    version: VERSION,
    generated_at: now || defaultGeneratedAt(),
    label_version: 'union',
    domains: domainsOut,
    concepts: conceptsOut,
    notes: notesOut,
    edges,
    stats,
    warnings,
  };
}
