# 学习中心 · Learning Center

一个**本地、手机友好**的学习门户：把你用 [`teach`](../../.agents/skills/teach) 技能产出的多个教学
workspace 聚合到一个入口，在 iPhone（Safari）上远程浏览、阅读、管理。

- 纯 **Node.js**，零第三方依赖（用内置 `http`）。
- 自动扫描 `courses/` 下的每个子目录（有 `MISSION.md` 或 `lessons/` 即视为一个主题）。
- 阅读：讲义、参考资料、学习记录、资源、备注。
- 管理：学习进度标记、全站搜索、新建 / 删除主题。
- 默认**只监听本机**；要跨设备访问时显式开启局域网 / 加密码。

## 快速开始

```powershell
# 在本目录（C:\Users\admin\knowledge）下
node server.mjs
```

然后浏览器打开 <http://127.0.0.1:4321>。
Windows 上也可以双击 `start.cmd`。

## 在 iPhone 上访问

**方式一（推荐，安全）：局域网 + 密码**

```powershell
node server.mjs --host 0.0.0.0 --password "你的密码"
```

在手机浏览器访问 `http://<电脑局域网IP>:4321`，输入密码即可。
查电脑局域网 IP：`ipconfig` 看 `IPv4 地址`（形如 `192.168.x.x`）。
> 前提：手机与电脑在同一 Wi-Fi；Windows 防火墙需放行 Node（首次运行会弹窗，选"允许"）。

**方式二：随时随地（出门 / 4G-5G）** — 用隧道，无需公网 IP、不必暴露端口：

- [Tailscale](https://tailscale.com)：电脑和 iPhone 各装一个，登录同一账号，用电脑的 Tailscale IP 访问。私网加密，最省心。
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)：`cloudflared tunnel --url http://127.0.0.1:4321` 得到一个临时 HTTPS 地址，可再加 Cloudflare Access 做登录保护。

无论哪种，都**务必设置 `--password`**。

## 发布到 GitHub Pages（手机随时随地阅读）

把学习中心发布成一个**只读**静态站点，手机随时能看。阅读进度记在浏览器本地，
`git push` 后自动重新构建发布。

**一次性设置（只做一次）：**

1. 在 GitHub 新建一个 **public** 仓库（例如 `learning-center`）。
2. 在本地 `knowledge/` 目录把代码推上去（首次需关联远程仓库）。
3. 仓库 **Settings → Pages → Source** 选 **GitHub Actions**。
4. 等一次 Action 跑完，手机打开 `https://<你的用户名>.github.io/<仓库名>/`。

**以后更新：** 在 `courses/` 里增改内容后 `git commit && git push`，GitHub 会自动重新构建发布。

**本地预览发布效果：**

```powershell
node scripts/export.mjs   # 生成 dist/
npx --yes serve dist      # 用任意静态服务器打开
```

静态版**只读**：不能新建 / 删除主题（那由 agent 用 `teach` 在本地生成），
进度存在每台设备各自的浏览器里。技术细节见 `AGENTS.md`。

## 用 teach 生成课程内容

每个主题就是 `courses/` 下的一个目录。用 `teach` 技能在那里产出内容即可：

```powershell
# 在 OpenCode 中把工作目录切到某个主题目录，然后运行 /teach
# 例如： C:\Users\admin\knowledge\courses\rust
```

`teach` 会写入 `MISSION.md`、`lessons/*.html`、`reference/*.html`、`learning-records/*.md`
等，学习中心会自动收录，无需手动登记。

> 也可以直接在界面里点右上角 `＋` 新建主题，它会生成好 workspace 骨架，再进去运行 `teach`。

## 配置

`config.json`（可被命令行参数与环境变量覆盖，优先级：参数 > 环境变量 > config.json）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 监听地址，`0.0.0.0` 表示局域网可达 |
| `port` | `4321` | 端口 |
| `password` | `""` | 访问密码（留空=不校验） |
| `contentRoot` | `./courses` | 课程内容根目录 |

命令行：`--host` `--port` `--password` `--content` `--no-password`
环境变量：`LC_HOST` `LC_PORT` `LC_PASSWORD` `LC_CONTENT_ROOT`

## 目录结构

```
knowledge/
├─ server.mjs          # HTTP 服务 + API + 鉴权
├─ lib/                # scan / store / auth / markdown
├─ public/             # 前端（index.html / app.js / styles.css）
├─ courses/            # 每个子目录 = 一个 teach 主题
├─ data/               # progress.json（进度）、secret（会话密钥）
└─ config.json
```

## HTTP API（供参考 / 二次开发）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 登录状态、内容根目录 |
| POST | `/api/login` `{password}` | 登录，下发会话 Cookie |
| POST | `/api/logout` | 退出 |
| GET | `/api/courses` | 全部主题（含进度摘要） |
| POST | `/api/courses` `{name}` | 新建主题（生成 workspace 骨架） |
| GET | `/api/courses/:id` | 主题详情（含渲染后的 Markdown） |
| DELETE | `/api/courses/:id` | 删除主题（移入 `courses/.trash`） |
| POST | `/api/progress` `{course,file,status}` | 标记讲义 `done` / `none` |
| GET | `/api/search?q=` | 全站搜索 |
| GET | `/files/:id/...` | 讲义 / 参考原件（供阅读器 iframe 加载） |
