# 学习中心 · GitHub Pages 只读发布 — 设计

## 意图

让 `knowledge/` 这个学习中心在手机上随时随地可读。做法是发布一个**只读**的静态版本到
GitHub Pages;本地 `node server.mjs` 的编辑 / 管理能力保持不变。

## 为什么

- 目前跨设备只有局域网或隧道方案,出门不方便。
- 内容不含敏感信息,可以公开托管。
- 课程由 agent(`teach` 技能)在电脑上生成,手机端只需要阅读。

## 目标

- 手机浏览器打开一个 URL 即可:看主题列表 → 读讲义 / 参考 / 学习记录 → 全站搜索 → 标记阅读进度。
- 进度存在浏览器本地(`localStorage`),不同设备各自独立。
- 新增 / 更新课程后,`git push` 即自动重建并发布,无需手动构建。
- 本地开发体验与现在的 `node server.mjs` 完全一致。

## 非目标

- 静态版不提供"新建主题""删除主题"(静态托管无法写文件)。
- 不做登录 / 鉴权(内容公开)。
- 不做离线 PWA / Service Worker(留作后续)。

## 反目标

- 把 `data/`(进度、会话密钥)、`courses/.trash/`、备份文件(`*.bak`)发布出去。
- 破坏本地 `node server.mjs`。
- 每次更新线上都要手动构建。

## 约束

- 零第三方依赖,只用 Node 内置模块(现有仓库即如此;`engines: node >= 18`,CI 用 Node 22)。
- GitHub Pages 只能托管静态文件;免费账户需 **public** 仓库。
- 项目站点形如 `https://<user>.github.io/<repo>/`,页面必须用**相对路径**。现有
  `public/index.html` 用了 `/assets/...` 绝对路径,静态构建里需改写。
- 讲义之间的链接已是相对路径(`../assets/style.css`、`../reference/…`),保持目录结构即可。
- 环境里没有 `gh` CLI;仓库创建与首次推送由用户手动完成。

## 由用户决定的部分

- **自动发布**:push → CI 构建 → Pages,而非每次手动构建。
- 手机端**只读**。
- 新增一份 `AGENTS.md` 说明这套流程。

## 留给构建者的部分

- 静态数据的 JSON 布局与命名。
- 前端"模式检测"的具体机制。
- 搜索索引的字段与体积控制。
- workflow 的具体步骤。
- 排除 / 清理规则。

## 方案

### 1. 静态导出脚本 `scripts/export.mjs`

复用 `lib/scan.mjs`(`scanCourses` / `readCourse` / `htmlTitle` / `exists`)与
`lib/md.mjs`(`renderMarkdown`),不引第三方。输出到 `dist/`:

```
dist/
  index.html            # 由 public/index.html 改写(相对路径 + 静态标记)
  assets/
    app.js              # 由 public/app.js 复制(适配层已内置)
    styles.css          # 复制
    favicon.svg         # 复制
    config.js           # 生成:window.__LC_STATIC__ = true
  api/
    courses.json        # 课程列表(等价 GET /api/courses)
    courses/<id>.json   # 每门课详情(等价 GET /api/courses/:id)
    search-index.json   # 全站搜索索引
  files/                # 讲义 / 参考 / 附件原件,保持结构
    <id>/lessons/*.html
    <id>/reference/*.html
    <id>/assets/*
  .nojekyll             # 跳过 GitHub Pages 的 Jekyll 处理
```

要点:

- **`api/courses.json`**:复用 `courseSummary` 的字段,但**不含进度**——静态模式下 `done/total`
  由前端用 `localStorage` 计算。字段:`id, title, counts, total, lastLesson, mtime`。
- **`api/courses/<id>.json`**:等价于 `GET /api/courses/:id` 的 `course` 部分
  (`missionHtml`、`resourcesHtml`、`notesHtml`、`lessons`、`reference`、`records`(含 html)、
  `counts`、`hasResources`、`hasNotes`),**不含 progress**。
- **`api/search-index.json`**:对每门课的 mission / 每篇讲义 / 每条学习记录生成
  `{courseId, courseTitle, label, kind, url, text}`;`text` 为去标签纯文本(沿用 `scan.mjs`
  的 `stripTags` 思路),每篇截断(默认 20000 字符)以控制体积。
- **`files/`**:整目录镜像每门课(保持 `<id>/…` 结构),排除编辑器备份(`*.bak`)与点文件。
  这样讲义里指向 `../assets/style.css`、`../reference/…`、`../MISSION.md`、`../RESOURCES.md`、
  `../learning-records/*.md` 的相对链接全部成立。学习记录同时已在详情 JSON 里渲染为 HTML。
- 复制时保持 `<id>/<kind>/<file>` 结构,确保相对链接有效。

### 2. 前端适配层 `public/app.js`

引入一个极小的"数据源"抽象,按模式走不同实现:

- **模式判定**:`window.__LC_STATIC__ === true`(由生成的 `assets/config.js` 设置)→ 静态;
  否则视为有服务器。
- `listCourses()`:服务器走 `GET /api/courses`;静态走 `GET api/courses.json`。
- `getCourse(id)`:服务器走 `GET /api/courses/:id`;静态走 `GET api/courses/<id>.json`。
- `getProgress(courseId)` / `setProgress(courseId, file, status)`:
  服务器走 `POST /api/progress`;静态写 `localStorage['lc:progress']`,结构与 `lib/store.mjs`
  一致(`{ courses: { <id>: { lessons: { <file>: { status } } } } }`),便于日后导入导出。
- `search(q)`:服务器走 `GET /api/search?q=`;静态懒加载 `api/search-index.json`,在内存里做
  不区分大小写的 `indexOf`,取前 60 条并生成 snippet(与服务端同逻辑)。
- `fileUrl(id, kind, file)`:服务器 `/files/<id>/<kind>/<file>`;静态 `files/<id>/<kind>/<file>`。
- 静态模式隐藏顶部"+"与课程的"⋯/删除";`boot()` 不再请求 `/api/state`。

保持零依赖、纯 ES module、与现有代码风格一致。阅读器仍用 iframe 加载原件。

### 3. GitHub Actions `.github/workflows/pages.yml`

- 触发:`push` 到 `main`,以及 `workflow_dispatch`。
- 权限:`contents: read`、`pages: write`、`id-token: write`;并发组 `pages`。
- 步骤:checkout → `actions/setup-node`(22)→ `node scripts/export.mjs` →
  `actions/configure-pages` → `actions/upload-pages-artifact`(path `dist`)→
  `actions/deploy-pages`(job `deploy`,environment `github-pages`)。
- 用户需在仓库 Settings → Pages 把 Source 选为 "GitHub Actions"。

### 4. 仓库卫生

- `.gitignore`:`data/`、`config.json`、`dist/`、`courses/.trash/`、`node_modules/`、`*.log`、
  `.DS_Store`。
- `dist/` 由 CI 构建,不进仓库;`data/` 与 `config.json`(可能含访问密码)绝不进仓库。

## 构建中定下的取舍

评审提出三点,除"是否允许无条件发布"属用户偏好外均由构建者定下:

- 讲义里指向 `.md` 的相对链接(见上):用**整目录镜像**解决,不重写链接。
- `config.json` 可能含访问密码 → 加入 `.gitignore`;缺失时服务用内置默认值,无副作用。
- 无条件发布 `courses/` 下的一切,但保留一个天然的"留一手"开关:目录名以 `.` 开头的课程
  会被 `scanCourses` 跳过(服务器与导出都不收录)。

### 5. 文档

- `AGENTS.md`:给 agent 看的工作流说明(仓库是什么、课程放哪、如何发布、哪些别提交、
  本地怎么跑)。
- `README.md`:新增"发布到 GitHub Pages"一节。

### 6. Git 初始化

- 在 `knowledge/` 执行 `git init`,默认分支 `main`,首次提交。
- 提供"创建仓库 → 推送 → 开启 Pages"的步骤(含无 `gh` 的手动路径)。

## 成功标准

1. 本地跑 `node scripts/export.mjs` 生成 `dist/`,用静态服务器打开后能:看列表、读讲义
   (交叉链接可达)、搜索、标记进度(刷新后仍在)。
2. `node server.mjs` 本地原行为不变(列表 / 详情 / 搜索 / 进度 / 新建 / 删除都可用)。
3. `data/`、`.trash`、`*.bak` 都不会进入 `dist/`。
4. 用户按步骤推到 GitHub 后,Pages 构建成功,手机可访问。
5. `dist/` 使用相对路径,放在子路径(`/<repo>/`)下也能工作。
