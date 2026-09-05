# 📚 读书笔记 PWA（公开版）

> 🌐 **在线使用**：<https://pancong0711.github.io/reading-notes-pwa/>
> （手机浏览器打开 → 添加到主屏幕 → 导入自己的数据包即可开始）

> 读书笔记项目的**前端静态版**（CLI + PWA 架构：电脑端 CLI 为主数据源，网页端跨终端阅读/轻编辑）。
> **本仓库不包含任何个人数据**：`notes/`、`export.json`、`graph.json` 均为示例/空数据，
> 个人数据只存储在你自己的设备本地（浏览器 IndexedDB）与你的电脑（Markdown）。无服务器、无云端、无跟踪。

## 功能

- 📖 阅读笔记 / 日记 / 日志 / 备忘（统一记录页，可自定义类型）
- 📊 阅读热力图（年视图按天 / 近 6 月按周 / 近 3 年按月，拖拽/缩放）
- 🕸️ 知识图谱（概念 → 笔记可视化；未编目概念在图谱页提示、一键去收集编目）
- 🧭 **概念管理**：知识图谱 key 的本地增删改（新增/编辑/删除 + 删除引用保护 + 导出 `concepts.yaml` 回电脑端 `graph build`）——校验与 CLI 一致，改动存本机 IndexedDB；「🧩 收集未编目概念」从本机记录一键编目（新建域自动配色）；本机重算基线=工作副本（删除语义生效）
- 🔠 **阅读字号**：详情页题头「Aa」四档（小/标准/大/特大，存本机；详情/图谱面板/预览同源）＋ 流式字号随屏幕自适应；桌面宽屏自动放宽版面（详情阅读列保持舒适行长）
- 🏷️ 自由标签 + 概念标签（知识图谱概念），批量统计/重命名/删除
- 📷 拍照/选图插入（自动压缩 ≤900px，存入本地）
- 🔄 导入 / 导出 JSON（多终端数据搬运），导入支持**差异对比与合并策略**（智能合并/仅新增/完整替换），导入前自动备份；迁移包可携带概念目录（增量并入本机，不写任何服务器）
- 📖 笔记详情页：全屏阅读 + 返回顶部悬浮钮 + 标签/概念 chips 点击过滤；表格渲染修复（表头/数据行对齐）
- 📴 离线可用（Service Worker 缓存，首次访问后断网可读）

## 部署到 GitHub Pages

1. 在 GitHub 新建一个**空仓库**（如 `reading-notes-pwa`，公开或私有均可）
2. 把本目录内全部文件推上去：
   ```bash
   git init
   git add .
   git commit -m "init: 读书笔记 PWA 公开版"
   git remote add origin https://github.com/pancong0711/reading-notes-pwa.git
   git push -u origin main
   ```
3. GitHub 仓库 → **Settings → Pages** → Source: `Deploy from a branch` → `main` / 根目录 → Save
4. 等 1-2 分钟，访问 `https://pancong0711.github.io/reading-notes-pwa/`
5. 手机浏览器打开 → 菜单「添加到主屏幕」→ 像 App 一样使用（首次访问后离线可用）

> 更新版本：重新复制最新前端文件 → `git add -A && git commit && git push`；记得把 `sw.js` 里 `CACHE_NAME` 版本号 +1。

## 数据从哪来？（重要）

- 公开站打开是**空壳**：没有任何你的笔记。
- 使用自己的数据：电脑上运行 `cd app && python -m reading_notes.cli sync` 生成 `export.json`
  → 通过微信/网盘私链发到自己手机 → PWA 记录页「导入 JSON」→ 选**智能合并**或**完整替换**。
- 手机端写的新内容 → 「导出 JSON」→ 传回电脑 → `python -m reading_notes.cli import-json 笔记包.json --strategy merge`。
- 你的数据始终在你自己手里：浏览器 IndexedDB（本机）+ 电脑 Markdown（git 版本管理）。

## 契约（开发者参考）

- 数据包 v2：`{ notes, books, exportedAt, schemaVersion: 2 }`，每条记录带稳定 `id` + `updatedAt`（毫秒）。
- 图谱数据：`graph.json`（CLI `graph build` 生成；公开版为示例概念，不含个人笔记）。
- 全部相对路径，支持 GitHub Pages 子路径部署（仓库名目录），无需改配置。
- Service Worker：修改 `sw.js` 顶部 `CACHE_NAME` 版本号触发全终端换新；`export.json` 走 network-first 保证拉到最新。

## 已知事项

- `manifest.webmanifest` 的 `icons` 为空——「添加到主屏幕」暂用默认图标（可补充 192/512 图标）。
- 多终端之间**不自动同步**：靠「导出 → 传输 → 导入（差异对比合并）」显式搬运，这是刻意的 local-first 设计。

## License

[MIT](./LICENSE) © 2026 pancong0711 —— 代码可自由使用/修改/分发（保留版权声明即可）；`vendor/d3.min.js` 为 D3.js（BSD-3-Clause，版权归其作者）。
