/* sw.js —— Service Worker：离线能力
 * 策略：
 *   install 时预缓存核心资源（逐个缓存，个别资源缺失不影响整体安装）
 *   fetch  时 cache-first，未命中则回退网络，成功后将响应写入运行时缓存
 *   fetch  对 /assets/* 图片：先查 IndexedDB image_store（迁移包导入/历史回填），
 *          未命中走网络并回填 IDB——图片自包含（需求：PWA 图片自包含与同步语义）
 * 升级：修改 CACHE_NAME 版本号即可触发整体换新。
 */
'use strict';

/* 版本号常量：资源有更新时递增，如 'reading-notes-v2' */
var CACHE_NAME = 'reading-notes-v51';   // v51: 20261108 缩略图卡片直接旋转图片/视频（含 v50 全量）

/* 安装时预缓存的核心资源（相对路径，与页面同目录） */
var CORE_ASSETS = [
  './',
  './index.html',
  './book.html',
  './book.js',
  './styles.css',
  './data.js',
  './folder-util.js',   // v32：文件夹路径工具（规范化/前缀树）
  './data-actions.js',   // v35：数据管理共享模块（导入/备份/导出生成/类型/标签）
  './folders.html',   // v33：笔记目录页（文件夹卡片网格）
  './folders.js',
  './folder.html',   // v33：文件夹页（子文件夹/直属笔记/多选移动）
  './folder.js',
  './types.js',
  './type.html',
  './type.js',
  './editor.html',   // 独立编辑页（新建/编辑统一入口；v44 随编辑入口/返回修复一起换新缓存）
  './editor.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './activity.js',
  './file-warning.js',
  './sw-register.js',
  './heatmap.js',
  './heatmap.css',
  './reading-font.js',   // v25：阅读字号档位应用器（批次三）
  './panel-modal.js',   // v31：模态面板辅助（遮罩点击/Esc 关闭）
  './note.html',   // v18：笔记详情页（全屏阅读+编辑入口）
  './note.js',   // v18：详情页逻辑
  './notes.html',
  './notes.js',
  './diary.html',
  './diary.js',
  './manifest.webmanifest',
  './graph.html',
  './graph.js',
  './graph.css',
  './graph-build.js',   // v12 补上（阶段一遗漏）：本机重算 union 图谱的纯函数模块
  './note-detail.js',   // v14：笔记详情共享渲染（markdown/图片可达）
  './print-export.js',   // v15：导出/生成打印草稿与书稿（范围过滤/打印 HTML 纯函数）
  './md-toolbar.js',   // v16：富文本工具栏纯函数（插入 markdown 语法/预览）
  './html-doc.js',   // v39：HTML 笔记 sandbox 安全预览
  './source-import.js',   // v39：md/html/txt 统一 JSON 导入解析
  './media-util.js',   // v40：图片非破坏性版式纯函数（width/rotate/align）
  './type-fields.js',   // v46：类型字段快照/无关字段纯函数
  './doc-style.js',   // v41：文档级样式白名单（字体/对齐/行距）
  './vendor/mathjax3/mathjax-boot.js',   // v16：公式启动与定点排版辅助
  './vendor/mathjax3/tex-svg.js',   // v16：MathJax v3 离线组件（2.1MB 单文件，SW 预缓存后离线可用）
  './vendor/heic2any.min.js',   // v48：HEIC/HEIF → JPEG 本地转换（WASM，按需加载/预缓存）
  './vendor/markdown-lite.js',   // v14：本地 markdown 受控渲染器（无外链）
  './graph.json',
    './concepts.html',
    './concepts.js',
  './vendor/d3.min.js'
];

/* 仅处理同源 http(s) GET 请求 */
function isCacheable(request) {
  var url = new URL(request.url);
  return request.method === 'GET' &&
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.origin === self.location.origin;
}

/* ── 图片自包含：image_store（IndexedDB）──────────────
 * DB 与页面同库同名（reading-notes，v6 起）；SW 打开时缺库则补建（与 data.js/diary.js 同 schema）。
 */
var IMAGE_DB = 'reading-notes';
/* 不带版本号打开：避免与页面侧 data.js/diary.js 的 DB_VERSION 漂移（低于现存版本会抛 VersionError）。
 * 升级/建仓由页面侧负责；SW 仅在缺 store 时补建（见 openImageDb）。 */
var IMAGE_STORE = 'image_store';
var ASSET_MEDIA_RE = /\.(jpg|jpeg|png|gif|webp|bmp|avif|mp3|wav|m4a|aac|ogg|oga|opus|webm|mp4|m4v|mov|pdf|docx?|pptx?|xlsx?|txt|md|csv|zip|epub)$/i;

function openImageDb() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(IMAGE_DB);
    req.onupgradeneeded = function () {
      var db = req.result;
      // 仅补建图片仓（其余 store 由页面侧 data.js/diary.js 升级负责，避免 schema 冲突）
      if (!db.objectStoreNames.contains(IMAGE_STORE)) {
        db.createObjectStore(IMAGE_STORE, { keyPath: 'path' });
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function idbGetImage(path) {
  return openImageDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var req = db.transaction(IMAGE_STORE, 'readonly').objectStore(IMAGE_STORE).get(path);
      req.onsuccess = function () { resolve(req.result ? req.result.blob : null); };
      req.onerror = function () { reject(req.error); };
    });
  }).catch(function () { return null; });
}

var PASSIVE_MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  webm: '', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
};

/**
 * 媒体仓响应必须收口 content-type：
 * - 被动媒体（图片/音频/视频）→ 已知 MIME，允许页面内联播放；
 * - PDF/Office/压缩包/未知类型 → application/octet-stream + attachment，避免同源主动 HTML 执行。
 */
function responseForStoredMedia(blob, path) {
  var clean = decodeURIComponent(String(path || '')).split(/[?#]/)[0].toLowerCase();
  var ext = clean.indexOf('.') !== -1 ? clean.split('.').pop() : '';
  var mime = PASSIVE_MIME_BY_EXT[ext] || '';
  if (ext === 'webm') {
    var bt = String(blob && blob.type || '').toLowerCase();
    mime = bt.startsWith('audio/') ? 'audio/webm' : (bt.startsWith('video/') ? 'video/webm' : 'application/octet-stream');
  }
  var headers = {
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
  if (!mime) {
    mime = 'application/octet-stream';
    headers['Content-Disposition'] = 'attachment';
  }
  headers['Content-Type'] = mime;
  return new Response(blob, { headers: headers });
}

function idbPutImage(path, blob) {
  return openImageDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(IMAGE_STORE, 'readwrite');
      tx.objectStore(IMAGE_STORE).put({ path: path, blob: blob, updatedAt: Date.now() });
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error); };
    });
  }).catch(function () {});
}

/* install：逐个预缓存，用 allSettled 保证个别文件缺失（如并行任务尚未生成）时不阻塞安装 */
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.allSettled(
        CORE_ASSETS.map(function (asset) {
          return cache.add(asset).catch(function (err) {
            console.warn('[SW] 预缓存失败（跳过）:', asset, err);
          });
        })
      );
    }).then(function () {
      // 新 SW 安装完成后立即接管，避免等用户二次刷新
      return self.skipWaiting();
    })
  );
});

/* activate：清理旧版本缓存，并接管已打开的页面 */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) { return key !== CACHE_NAME; })
            .map(function (key) { return caches.delete(key); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/* fetch：cache-first，未命中回退网络；网络成功则顺手写入缓存供下次离线使用。
 * 例外：export.json（CLI 同步文件）始终走网络，避免返回旧缓存导致同步不到新数据。 */
self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (!isCacheable(request)) return;

  var url = new URL(request.url);

  // 媒体/附件自包含：/assets/* 先查 Blob 仓（迁移包导入/历史回填），未命中走网络并回填。
  // 兼容两种 key：'assets/foo.jpg'（新写入/迁移包）与 'foo.jpg'（旧历史数据）。
  if (url.pathname.indexOf('/assets/') !== -1) {
    var ai = url.pathname.indexOf('/assets/');
    var fullAssetPath = decodeURIComponent(url.pathname.slice(ai + 1));       // assets/foo.jpg
    var baseAssetPath = decodeURIComponent(url.pathname.slice(ai + '/assets/'.length)); // foo.jpg
    event.respondWith(
      idbGetImage(fullAssetPath).then(function (blob) {
        return blob || idbGetImage(baseAssetPath);
      }).then(function (blob) {
        if (blob) return responseForStoredMedia(blob, fullAssetPath);
        return fetch(request).then(function (response) {
          if (response && response.ok) {
            response.clone().blob().then(function (b) {
              idbPutImage(fullAssetPath, b);
            }).catch(function () {});
            return response.clone().blob().then(function (b) {
              return responseForStoredMedia(b, fullAssetPath);
            }).catch(function () { return response; });
          }
          return response;
        });
      })
    );
    return;
  }

  if (url.pathname.endsWith('/export.json')) {
    // CLI 同步文件（export.json）始终走网络，避免返回旧缓存
    event.respondWith(fetch(request));
    return;
  }
  if (url.pathname.endsWith('/graph.json')) {
    // 图谱数据：network-first，在线拉最新并写入缓存；离线回退预缓存/上次缓存
    event.respondWith(
      fetch(request).then(function (response) {
        if (response && response.ok) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(request, clone);
          });
        }
        return response;
      }).catch(function () {
        return caches.match(request);
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(function (cached) {
      if (cached) return cached;               // 命中缓存，直接返回
      return fetch(request).then(function (response) {
        // 只缓存有效响应（非跨域 / 非错误）
        if (response && response.ok) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(request, clone);
          });
        }
        return response;
      });
    }).catch(function () {
      // 离线且缓存未命中：导航请求回退到日记页作为离线首页提示
      if (request.mode === 'navigate') {
        return caches.match('./diary.html');
      }
      return new Response('离线模式：资源暂不可用', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    })
  );
});
