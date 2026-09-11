/* folder-util.js —— 文件夹（= project 路径）工具：规范化 / 路径运算 / 前缀树构建
 *
 * 设计（20260911 需求 §二）：
 *   · project 值为**路径字符串**：`项目A/文献`、`项目A/实验/样品A`（任意深度）
 *   · 未归类 → **'other'**（不留空，两端一致）
 *   · 规范化：全角 ／ › 〉 > → 半角 /；去首尾 /；折叠连续 /；丢空段；超长 120 截断
 *   · 由前缀聚合出 dict-like 树（buildTree），供目录页/文件夹页渲染
 *
 * 纯函数、无 DOM/IndexedDB 依赖：浏览器与 node 测试均可加载；与 CLI storage.normalize_project 口径一致
 * （差分 fixture：app/tests/fixtures/folders-parity.json，pytest 与 node §36 双侧断言）。
 */

export const OTHERS = 'other';
const MAX_LEN = 120;

/** 规范化项目/文件夹路径；空值 → 'other' */
export function normalizeProject(value) {
  let s = String(value == null ? '' : value);
  // 全角与常见分隔符 → 半角 /
  s = s.replace(/[／⁄›〉>»→]/g, '/');
  s = s.replace(/\\/g, '/');
  // 折叠连续 /、去首尾
  s = s.replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  // 逐段规整：去空白、丢弃空段与 '.'、'..'
  const segs = s.split('/').map((x) => x.trim()).filter((x) => x && x !== '.' && x !== '..');
  s = segs.join('/');
  if (s.length > MAX_LEN) s = Array.from(s).slice(0, MAX_LEN).join('').replace(/\/+$/, '');
  return s || OTHERS;
}

/** 路径 → 段数组（'other' → ['other']） */
export function splitPath(path) {
  return normalizeProject(path).split('/').filter(Boolean);
}

/** 最后一段（显示名） */
export function displayName(path) {
  const segs = splitPath(path);
  return segs[segs.length - 1] || OTHERS;
}

/** 父路径；顶级返回 ''（根） */
export function parentPath(path) {
  const segs = splitPath(path);
  segs.pop();
  return segs.join('/');
}

/** other 视为根级直属（无父） */
export function isRootLevel(path) {
  return splitPath(path).length <= 1;
}

/** path 是否等于 base 或位于 base 子树内（base 为根 '' 时恒真） */
export function isSameOrSub(path, base) {
  const p = normalizeProject(path);
  const b = String(base == null ? '' : base).replace(/^\/+|\/+$/g, '');
  if (!b) return true;
  return p === b || p.startsWith(b + '/');
}

/** 把 base 子树内的路径换根为 newBase（重命名文件夹用）：'a/b' + base 'a' → 'x/b' */
export function rebasePath(path, oldBase, newBase) {
  const p = normalizeProject(path);
  const ob = String(oldBase || '').replace(/^\/+|\/+$/g, '');
  if (!ob) return p;
  if (p === ob) return normalizeProject(newBase);
  if (p.startsWith(ob + '/')) return normalizeProject(String(newBase || '').replace(/^\/+|\/+$/g, '') + '/' + p.slice(ob.length + 1));
  return p;
}

/**
 * 由路径集合构建前缀树（dict-like）。
 * @param {string[]} paths 已规范化的文件夹路径集合（含各级父路径自动补齐）
 * @returns {Array<{name:string, path:string, children:Array, depth:number}>} 根级节点数组（按名称排序）
 */
export function buildTree(paths) {
  const nodes = new Map();   // path -> node
  const ensure = (p) => {
    if (!p) return null;
    if (nodes.has(p)) return nodes.get(p);
    const node = { name: displayName(p), path: p, children: [], depth: splitPath(p).length };
    nodes.set(p, node);
    const parent = parentPath(p);
    if (parent) {
      const pn = ensure(parent);
      if (pn && !pn.children.includes(node)) pn.children.push(node);
    }
    return node;
  };
  for (const raw of paths || []) {
    const p = normalizeProject(raw);
    ensure(p);
  }
  const all = [...nodes.values()];
  const roots = all.filter((n) => !parentPath(n.path) || !nodes.has(parentPath(n.path)));
  const sortRec = (arr) => {
    arr.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    arr.forEach((n) => sortRec(n.children));
    return arr;
  };
  return sortRec(roots);
}

/** 直接子文件夹（不递归） */
export function directChildren(tree, basePath) {
  const base = String(basePath || '').replace(/^\/+|\/+$/g, '');
  const find = (arr) => {
    for (const n of arr) {
      if (n.path === base) return n;
      const hit = find(n.children);
      if (hit) return hit;
    }
    return null;
  };
  if (!base) return tree;
  const node = find(tree);
  return node ? node.children : [];
}

/** 直属笔记（folder 路径完全等于该 folder 的记录） */
export function directNotes(notes, folderPath) {
  const target = normalizeProject(folderPath);
  return (notes || []).filter((n) => normalizeProject(n.project) === target);
}

/** 子树笔记（含所有层级） */
export function subtreeNotes(notes, folderPath) {
  const base = String(folderPath || '').replace(/^\/+|\/+$/g, '');
  return (notes || []).filter((n) => isSameOrSub(n.project, base));
}

export default { OTHERS, normalizeProject, splitPath, displayName, parentPath, isRootLevel, isSameOrSub, rebasePath, buildTree, directChildren, directNotes, subtreeNotes, filterNotes, folderStats, typeCounts };
/**
 * 记录过滤（文件夹页/目录页共用，纯函数便于测试）
 * @param {Array} notes
 * @param {object} opt { q, types, dateFrom, dateTo, folder, subtree }
 * @returns {Array}
 */
export function filterNotes(notes, opt = {}) {
  const { q = '', types = [], dateFrom = '', dateTo = '', folder = null, subtree = false } = opt;
  let list = Array.isArray(notes) ? notes.slice() : [];
  if (folder != null && folder !== '') {
    list = subtree ? subtreeNotes(list, folder) : directNotes(list, folder);
  }
  if (Array.isArray(types) && types.length) {
    const want = new Set(types);
    list = list.filter((n) => want.has(String(n.type || 'note')));
  }
  const kw = String(q || '').trim().toLowerCase();
  if (kw) {
    list = list.filter((n) => {
      const fields = [n.title, n.content, n.readerNote, n.aiNote, n.project,
        ...(Array.isArray(n.tags) ? n.tags : []),
        ...(Array.isArray(n.concepts) ? n.concepts.map((c) => (typeof c === 'string' ? c : c && c.id)) : [])];
      return fields.some((f) => String(f == null ? '' : f).toLowerCase().includes(kw));
    });
  }
  if (dateFrom) list = list.filter((n) => String(n.date || '') >= dateFrom);
  if (dateTo) list = list.filter((n) => String(n.date || '') <= dateTo);
  return list;
}

/** 文件夹卡片统计：直属/子树条数 + 最近更新（ms） */
export function folderStats(notes, path) {
  const direct = directNotes(notes, path);
  const sub = subtreeNotes(notes, path);
  let latest = 0;
  for (const n of sub) {
    const ts = Number(n.updatedAt) || 0;
    if (ts > latest) latest = ts;
  }
  return { direct: direct.length, total: sub.length, latest };
}

/** 类型分布（用于卡片徽标）：{type: count} */
export function typeCounts(notes) {
  const m = {};
  for (const n of notes || []) {
    const k = String(n.type || 'note');
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}
