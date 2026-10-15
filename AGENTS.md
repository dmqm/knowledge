# AGENTS.md

给在这个仓库里工作的 agent 的说明。

## 这是什么

一个**本地、手机友好**的学习门户:把 `teach` 技能产出的多个教学 workspace 聚合到一个入口,
在手机上阅读。项目定位是**阅读器**,不是编辑器。

- 纯 Node.js,零第三方依赖。
- 内容 = `courses/` 下的每个子目录,一个子目录就是一门**主题**(课程)。

## 目录结构

```
knowledge/
├─ server.mjs           # 本地 HTTP 服务 + JSON API + 鉴权
├─ scripts/export.mjs   # 把站点导出成静态文件到 dist/(用于 GitHub Pages)
├─ lib/                 # scan / store / auth / markdown
├─ public/              # 前端(index.html / app.js / styles.css)
├─ courses/             # 每个子目录 = 一个主题;内容由 teach 生成
├─ data/                # progress.json(进度)、secret(会话密钥)—— 不要提交
├─ .github/workflows/   # pages.yml:push 后自动构建并发布
└─ config.json
```

## 两种运行模式

前端 `public/app.js` 通过 `window.__LC_STATIC__` 区分:

- **服务器模式**(本地 `node server.mjs`):走 JSON API,可读可写(新建 / 删除主题、
  进度写回 `data/progress.json`)。
- **静态模式**(导出的 `dist/`,GitHub Pages):读 `api/*.json`,进度存浏览器
  `localStorage`,隐藏"新建 / 删除"。**只读。**

两套模式共用同一份 `public/app.js` 与同一套渲染逻辑,只有数据来源不同。

## 怎么加课程

**不要通过界面或手写文件来加课程**——课程内容由 agent 用 `teach` 技能生成:

1. 在 OpenCode 里把工作目录切到目标主题目录(如 `courses/rust/`),运行 `teach`。
2. `teach` 会写入 `MISSION.md`、`lessons/*.html`、`reference/*.html`、
   `learning-records/*.md` 等,学习中心会自动收录。
3. 需要新建目录时,在 `courses/` 下建一个含 `MISSION.md` 或 `lessons/` 的文件夹即可;
   也可以本地跑服务器后用界面右上角 `＋` 生成骨架。

## 怎么发布(重点)

发布是**自动**的,不用手动构建:

1. 在 `courses/` 下新增 / 修改内容。
2. `git add . && git commit -m "..." && git push`(推到 `main`)。
3. GitHub Actions(`.github/workflows/pages.yml`)自动跑 `node scripts/export.mjs`,
   把 `dist/` 发布到 GitHub Pages。
4. 稍等片刻,手机打开站点即可看到更新(可能需要刷新)。

本地想预览发布效果:

```powershell
node scripts/export.mjs          # 生成 dist/
npx --yes serve dist             # 或任何静态服务器,然后打开提示的地址
```

## 不要提交这些

`.gitignore` 已排除,请勿手动 `-f` 加进来:

- `data/` —— 本地进度和会话密钥,含个人状态。
- `config.json` —— 可能含访问密码;缺失时服务用内置默认值。
- `dist/` —— 构建产物,由 CI 重新生成。
- `courses/.trash/` —— 被删除的主题。

想临时把某门课"留一手"、不发布也不在列表里出现,把它的目录名改成以 `.` 开头即可
(扫描会跳过点开头的目录)。

另外,导出时会**整目录镜像**每门课到发布内容的 `files/` 下(这样讲义里的相对链接,
包括指向 `MISSION.md` / `RESOURCES.md` / `learning-records/*.md` 的,都成立),
但会跳过编辑器备份(`*.bak`)。

## 本地开发

```powershell
node server.mjs                  # http://127.0.0.1:4321
node server.mjs --host 0.0.0.0 --password "xxx"   # 局域网 + 密码
```

配置优先级:命令行参数 > 环境变量 > `config.json`。
详见 `README.md`。

## 约定

- 保持零第三方依赖(只用 Node 内置模块)。
- 改前端时,两种模式都要能跑:静态模式别依赖服务器 API,服务器模式别依赖静态 JSON。
- 静态构建使用**相对路径**(站点可能挂在 `/<repo>/` 子路径下);
  `scripts/export.mjs` 会把 `public/index.html` 里的绝对路径改写掉,改动该文件时注意别破坏这些锚点。
