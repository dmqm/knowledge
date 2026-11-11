# AGENTS.md

给在这个仓库里工作的 agent 的说明。

**这是什么**:一个**本地、手机友好**的学习门户(阅读器,不是编辑器),把 `teach` 技能产出的
多个教学 workspace 聚合到一个入口。纯 Node.js(>=18),**零第三方依赖**——只用内置模块,
加依赖等于改架构,先说明。内容 = `courses/` 下的每个子目录(一门主题/课程)。

## 命令(已实测)

```powershell
node server.mjs                        # http://127.0.0.1:4321
node server.mjs --host 0.0.0.0 --password "xxx"
node --test                            # 全量:49 个用例,约 4s
node --test tests/store.test.mjs       # 单文件
node scripts/export.mjs                # 生成 dist/(静态发布产物)
npx --yes serve dist                   # 本地预览静态版
```

`package.json` 只映射 `start / export / test`;没有 build、lint、typecheck、codegen 步骤。
CI(`.github/workflows/pages.yml`)用 Node 22,`main` 上 push 即自动导出并发布到 Pages。

## 分层(不看代码就会猜错的)

- `server.mjs` — 唯一服务入口:配置加载、鉴权、路由、静态文件。
- `lib/scan.mjs` 扫描/读取/搜索主题;`lib/store.mjs` 进度存储;`lib/auth.mjs` 会话;
  `lib/md.mjs` Markdown;`lib/safe-path.mjs` **路径包含判断,服务器与导出器共用**。
- `public/route-logic.js` — 无 DOM 的纯路由/URL 帮助函数,**浏览器与 `node --test` 都 import**。
  新增导航/URL 逻辑放这里,别写进 `app.js`,否则测不了。
- `tests/*.test.mjs` — 全 `node:test`;`tests/helpers.mjs` 会起真实 HTTP 服务(临时端口 +
  `os.tmpdir()` 下的临时目录)。
- `docs/superpowers/` — 历史设计文档(如 Pages 发布设计),不是规范,以代码为准。

## 改动时的硬约束

- **安全不变量,不许放松**:课程 id 必须是 `courses/` 下的单段目录名;校验走
  `isSafeCourseId()`(拒绝点开头、`..`、原型键、Windows 设备名/保留字符)。
  所有路径判断用 `lib/safe-path.mjs` 的 `realPath()` + `isSameOrInside()`
  (**realpath 包含关系**,不是字符串前缀),无法解析时失败即拒绝。新代码不要自己写
  `startsWith`。
- **`public/index.html` 里四个绝对路径字面量**(`href="/assets/styles.css"`、`/assets/favicon.svg`、
  `/assets/apple-touch-icon.png`、`src="/assets/app.js"`)是 `scripts/export.mjs` 用 `.replace()`
  改写的锚点;字符串对不上会**抛错中断 CI**。改 head / script 标签时保持原样,别顺手改成相对路径。
- 静态版靠导出时写入的 `assets/config.js`(`window.__LC_STATIC__ = true;`)切换数据源。
  改前端时两种模式都要能跑:静态模式不许依赖服务器 API,服务器模式不许依赖静态 JSON。
- 导出目标目录不许与仓库任意顶层目录重叠(`export.mjs` 会抛);镜像整门课到 `files/<id>/`
  时跳过点开头、`*.bak`、`_originals/`。
- 进度写入必须串行化 + 原子替换;`progress.json` 损坏时备份并**显式告警**,不许静默合并。
- `config.json` 存在但损坏 → 拒绝启动,不得退化成无密码。`data/`(progress.json、secret)、
  `config.json`、`dist/`、`courses/.trash/` 已 gitignore,不要 `-f` 加进来。

## 加课程 / 写内容

内容只能由 agent 用 `teach` 技能生成,**不要手写文件,也不走界面**(界面没有"新建"入口):

1. 工作目录切到 `courses/<主题>/` 跑 `teach`,产出 `MISSION.md`、`lessons/*.html`、
   `reference/*.html`、`learning-records/*.md`;含 `MISSION.md` 或 `lessons/` 即被自动收录。
2. 要分组就把目录名加进 `courses/categories.json` 的 `groups[].courses`(该文件要提交);
   没登记的落到首页「更多主题」。
3. 想临时不发布也不出现在列表:目录名以 `.` 开头(扫描跳过)。
4. `teach` / `show-me` 不在技能默认列表,装在 `C:\Users\admin\.agents\skills\` 下。

内容标准:**一开始就按整本书深度写**,单讲正文 2500–4000 字,讲「机制 + 真实案例 + 决策链」;
每页配内联 SVG 示意图(离线可用、跟随主题、**不写死颜色**);外部资源 URL 必须查证可达,
不许凭记忆编。

## Windows 坑

- 命令走 PowerShell,复杂引号容易搞乱 → 把命令写成临时 `.mjs` 脚本再 `node` 跑。
- 读写文本显式 UTF-8;大段内容别一次 `write`,分块写。
- `core.autocrlf` 会造成「`git status` 有改动、`git diff` 为空」的假改动,先看 diff 再决定。
- `git push` 的凭据来自仓库本地 `.git/config` 的 `credential.helper`(一个包装脚本,指向 Git 自带的
  GCM)。`credential.helper` 的值会被按空格切开,所以**不能直接写带空格的路径**,要用无空格的
  包装脚本转发。

## 协作偏好

- 默认直接做完、给结果,不逐步征求意见;需要澄清时一次问完。
- 用户常在手机上看 push 后的站点,而不是本地预览。
- 不打印密钥/密码;不修改 `.env`;破坏性命令先说明再执行;不为通过检查造假。
