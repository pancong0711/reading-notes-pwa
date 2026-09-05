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
var CACHE_NAME = 'reading-notes-v26';

/* 安装时预缓存的核心资源（相对路径，与页面同目录） */
var CORE_ASSETS = [
  './',
  './index.html',
  './book.html',
  './book.js',
  './styles.css',
  './data.js',
  './types.js',
  './type.html',
  './type.js',
  './activity.js',
  './file-warning.js',
  './sw-register.js',
  './heatmap.js',
  './heatmap.css',
  './reading-font.js',   // v25：阅读字号档位应用器（批次三）
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
  './vendor/mathjax3/mathjax-boot.js',   // v16：公式启动与定点排版辅助
  './vendor/mathjax3/tex-svg.js',   // v16：MathJax v3 离线组件（2.1MB 单文件，SW 预缓存后离线可用）
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
var IMAGE_DB_VERSION = 6;
var IMAGE_STORE = 'image_store';
var IMAGE_RE = /\.(jpg|jpeg|png|gif|webp)$/i;

function openImageDb() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(IMAGE_DB, IMAGE_DB_VERSION);
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

  // 图片自包含：/assets/* 先查 image_store（迁移包导入/历史回填），未命中走网络并回填
  if (IMAGE_RE.test(url.pathname) && url.pathname.indexOf('/assets/') !== -1) {
    event.respondWith(
      idbGetImage(decodeURIComponent(url.pathname.split('/assets/')[1])).then(function (blob) {
        if (blob) return new Response(blob, { headers: { 'Content-Type': blob.type || 'image/jpeg' } });
        return fetch(request).then(function (response) {
          if (response && response.ok) {
            response.clone().blob().then(function (b) { idbPutImage(decodeURIComponent(url.pathname.split('/assets/')[1]), b); });
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
