/* type-fields.js —— 笔记类型字段快照与“其他字段”纯函数（需求 20261107）
 *
 * 设计：
 *   · typeData[typeKey] 保存该类型字段快照，切换类型不删除；
 *   · extensions 保存当前类型 schema 之外的标量扩展字段；
 *   · 旧记录自动迁移：book/pages → note，done/due → memo，未知 meta → extensions；
 *   · 核心字段永不进入 orphan 删除区。
 *
 * 无 DOM 依赖，浏览器与 node 测试共用。
 */

export const CORE_FIELD_KEYS = Object.freeze([
  'id', 'type', 'title', 'author', 'date', 'tags', 'concepts', 'rating',
  'project', 'contentFormat', 'content', 'contentCache', 'source',
  'media', 'images', 'readerNote', 'aiNote', 'imageData', 'quotes', 'characters',
  'extension', 'meta', 'typeData', 'extensions', 'style', 'createdAt', 'updatedAt',
  'pinned', 'history', 'sync', 'schemaVersion', 'storageMode',
]);

export const FIELD_OWNER = Object.freeze({
  book: 'note',
  pages: 'note',
  done: 'memo',
  due: 'memo',
});

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (isPlainObject(v)) {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = clone(val);
    return out;
  }
  return v;
}

export function isScalarFieldValue(v) {
  return v == null || ['string', 'number', 'boolean'].includes(typeof v);
}

export function normalizeTypeData(raw) {
  if (!isPlainObject(raw)) return {};
  const out = {};
  for (const [typeKey, fields] of Object.entries(raw)) {
    const k = String(typeKey || '').trim();
    if (!k || !isPlainObject(fields)) continue;
    const bucket = {};
    for (const [field, value] of Object.entries(fields)) {
      const f = String(field || '').trim();
      if (f && isScalarFieldValue(value)) bucket[f] = clone(value);
    }
    out[k] = bucket;
  }
  return out;
}

export function normalizeExtensions(raw) {
  if (!isPlainObject(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const k = String(key || '').trim();
    if (k && isScalarFieldValue(value)) out[k] = clone(value);
  }
  return out;
}

/** 旧记录字段 → typeData/extensions 初始快照（幂等，不覆盖已有桶内值）。 */
export function hydrateTypeData(rec = {}) {
  const typeData = normalizeTypeData(rec.typeData);
  const extensions = normalizeExtensions(rec.extensions);
  const currentType = String(rec.type || 'general') || 'general';
  // 一旦记录已有 typeData，就以它为真源：不再用旧顶层/meta 回填已明确删除的字段。
  const hasTypeData = isPlainObject(rec.typeData) && Object.keys(rec.typeData).length > 0;

  const ensure = (typeKey) => {
    if (!typeData[typeKey]) typeData[typeKey] = {};
    return typeData[typeKey];
  };

  const meta = isPlainObject(rec.meta) ? rec.meta : {};
  if (!hasTypeData) {
    // 旧记录带阅读/备忘字段，按字段归属补到对应类型桶，供切换后恢复/删除。
    // 当前自定义类型通过 fieldValueForType 的 legacy fallback 读取，不重复造桶。
    const noteBucket = ensure('note');
    if (!Object.prototype.hasOwnProperty.call(noteBucket, 'book') && rec.book != null && String(rec.book) !== '') noteBucket.book = String(rec.book);
    if (!Object.prototype.hasOwnProperty.call(noteBucket, 'pages') && rec.pages != null && String(rec.pages) !== '') noteBucket.pages = String(rec.pages);
    const memoBucket = ensure('memo');
    for (const k of ['done', 'due']) {
      if (!Object.prototype.hasOwnProperty.call(memoBucket, k) && Object.prototype.hasOwnProperty.call(meta, k)) memoBucket[k] = clone(meta[k]);
    }

    // 未知 meta 键 → extensions（核心 meta 已知键除外）
    for (const [k, value] of Object.entries(meta)) {
      if (k === 'done' || k === 'due') continue;
      if (!Object.prototype.hasOwnProperty.call(extensions, k) && isScalarFieldValue(value)) extensions[k] = clone(value);
    }
  }
  return { typeData, extensions };
}

/** 取某类型某字段值：typeData 优先，随后 legacy fallback。 */
export function fieldValueForType(typeData, typeKey, field, rec = {}) {
  const bucket = isPlainObject(typeData && typeData[typeKey]) ? typeData[typeKey] : {};
  if (Object.prototype.hasOwnProperty.call(bucket, field)) return bucket[field];
  const meta = isPlainObject(rec.meta) ? rec.meta : {};
  if (field === 'book') return rec.book || '';
  if (field === 'pages') return rec.pages || '';
  if (field === 'done' || field === 'due') return meta[field];
  return '';
}

/** 把当前表单值快照进 typeData[typeKey]（返回新对象）。 */
export function snapshotTypeFields(typeData, typeDef, values) {
  const out = normalizeTypeData(typeData);
  const typeKey = String(typeDef && typeDef.key || '').trim();
  if (!typeKey) return out;
  const bucket = { ...(out[typeKey] || {}) };
  for (const field of (typeDef.fields || [])) {
    if (!Object.prototype.hasOwnProperty.call(values || {}, field)) continue;
    bucket[String(field)] = clone(values[field]);
  }
  out[typeKey] = bucket;
  return out;
}

/** 当前类型 active fields 集合。 */
export function activeTypeFieldSet(typeDef) {
  return new Set((typeDef && typeDef.fields || []).map(String));
}

/**
 * 生成「其他字段（当前类型未使用）」分组。
 * @param {object} typeData
 * @param {object} extensions
 * @param {object} currentTypeDef
 * @param {Function} labelOf  typeKey → 显示名
 * @returns {Array<{kind:'type'|'extension', typeKey?:string, label:string, items:Array<{key:string,value:any}>}>}
 */
export function orphanFieldGroups(typeData, extensions, currentTypeDef, labelOf) {
  const currentKey = String(currentTypeDef && currentTypeDef.key || '');
  const active = activeTypeFieldSet(currentTypeDef);
  const groups = [];
  const td = normalizeTypeData(typeData);
  for (const [typeKey, fields] of Object.entries(td)) {
    const items = [];
    for (const [key, value] of Object.entries(fields)) {
      if (typeKey === currentKey && active.has(key)) continue;
      items.push({ key, value });
    }
    if (!items.length) continue;
    const label = typeKey === currentKey
      ? '当前类型的额外字段'
      : `${labelOf ? labelOf(typeKey) : typeKey}（当前类型未使用）`;
    groups.push({ kind: 'type', typeKey, label, items });
  }
  const exts = normalizeExtensions(extensions);
  const extItems = Object.entries(exts).map(([key, value]) => ({ key, value }));
  if (extItems.length) groups.push({ kind: 'extension', label: '扩展字段', items: extItems });
  return groups;
}

/** 删除一个 orphan 字段（返回新 state；核心字段不会被删除）。 */
export function deleteOrphanField(typeData, extensions, groupKind, typeKey, field) {
  const td = normalizeTypeData(typeData);
  const exts = normalizeExtensions(extensions);
  const key = String(field || '');
  if (CORE_FIELD_KEYS.includes(key)) return { typeData: td, extensions: exts, deleted: false };
  if (groupKind === 'extension') {
    if (!Object.prototype.hasOwnProperty.call(exts, key)) return { typeData: td, extensions: exts, deleted: false };
    delete exts[key];
    return { typeData: td, extensions: exts, deleted: true };
  }
  const t = String(typeKey || '');
  if (!td[t] || !Object.prototype.hasOwnProperty.call(td[t], key)) {
    return { typeData: td, extensions: exts, deleted: false };
  }
  delete td[t][key];
  if (!Object.keys(td[t]).length) delete td[t];
  return { typeData: td, extensions: exts, deleted: true };
}

export default {
  CORE_FIELD_KEYS, FIELD_OWNER, normalizeTypeData, normalizeExtensions, hydrateTypeData,
  fieldValueForType, snapshotTypeFields, activeTypeFieldSet, orphanFieldGroups, deleteOrphanField,
};
