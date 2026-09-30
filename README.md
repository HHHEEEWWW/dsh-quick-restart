# dsh-quick-restart

给 DSH 主界面加一个「一键重启」按钮，钉在 Windows 标题栏里、紧挨原生最小化按钮的左边。

> A one-click restart button for DSH (DeepSeek Harness), pinned to the Windows titlebar strip just left of the native window controls. Built for the plugin-heavy workflow where every plugin update means relaunching the app by hand.

## 这东西解决什么

DSH 的插件在启动时装配。你改完插件、或者插件自己更新了，得手动关掉窗口、再双击 exe 打开——一天下来十几次，纯粹是浪费。这个插件把这件事压成一次点击：按钮问宿主「现在能不能重启」，拿到许可后 fork 出一个分离进程去拆掉旧的、拉起新的，页面在新宿主回来后自己刷新。

## 长什么样

按钮落在标题栏右侧，尺寸 28px 高、最小 104px 宽，近黑底 `#0b0b0e` 配白字和一圈细描边，在标题栏底色上是个明确的对比块。它用 `env(titlebar-area-x)` 和 `env(titlebar-area-width)` 算出原生窗口控件（最小化／最大化／关闭）占的宽度，`100% - x - width` 正好等于那块宽度，所以任何窗口尺寸下它都紧贴在最小化按钮左边，不重叠也不漂。

点下去后按钮进入四段状态：检查中、重启中、等待回来、重试。重启期间图标持续旋转，页面每秒探一次宿主的 pid，等它变了就自动刷新。如果检测到有任务正在跑，会先弹一个确认框——这个探测拿不到答案时（`tasksKnown: false`）就直接放行，拿不到答案不该挡住操作。

不支持 Window Controls Overlay 的环境（比如浏览器里直接开 `http://127.0.0.1:<port>`）按钮不渲染，避免浮在页面顶上。

## 安装

这个包遵循 DSH 的 bundle 约定——`package.json` 里用 `dsh.bundle.patch` 指向 `cordis.patch.yml`，用 `dsh.client` 声明前端入口。任何能装 DSH 插件的入口都能装它。

用 DSH 的插件管理器装：

```json
plugin_manager { "action": "install_bundle", "target": "github:HHHEEEWWW/dsh-quick-restart" }
```

或者从 [Releases](https://github.com/HHHEEEWWW/dsh-quick-restart/releases/latest) 下载 `.tgz`，把路径当 install spec 传进去。

手动装的话，clone 到任意目录，然后让 profile 认它：在 profile 的 `package.json` 里把包名加进 `dependencies`（指向本地目录）和 `dsh.profile.bundles` 数组，再在 profile 的 `node_modules` 下建一个指向该目录的目录联接。做完重启一次 DSH。

装完刷新页面（Ctrl+R），按钮就该出现在标题栏了。

## 机制

宿主进程跑在 Electron 二进制里（`ELECTRON_RUN_AS_NODE=1`），而重启它自己的进程不能由它自己完成——正在干活的进程没法把自己换掉。所以分三层：

```
标题栏按钮 (lib/client.js)
   │  GET  /dsh-quick-restart/api/status     ← 拿 pid、判断有没有任务在跑
   │  POST /dsh-quick-restart/api/restart    ← 带 x-dsh-quick-restart: 1
   ▼
宿主插件 (lib/index.js)
   │  校验：回环地址、无代理头、Origin 同源或 dsh-app://、CSRF 头
   │  把 helper 复制到 %TEMP%，detached + ELECTRON_RUN_AS_NODE=1 起它
   ▼
分离的 helper (lib/helper.mjs)
   │  ① 杀 Electron 主进程（只 /PID，绝不 /T）
   │  ② 等宿主自己退出（IPC 断了它会自停），超时再兜底
   │  ③ 按映像名扫残留的 renderer/GPU —— 用 tasklist 逐个杀，排除自己
   │  ④ 等端口释放
   │  ⑤ 重新拉起 exe
   ▼
新实例（宿主回到原端口）
```

## 三条踩过的坑

写这段是因为每一条都真的把应用弄死过一次，改代码前值得先看。

**`taskkill /F /T /PID <Electron 主进程>` 会杀掉 helper 自己。** helper 是从宿主 fork 出来的，跟主进程同属一棵树；递归杀会连带把「负责重启的那个进程」一起带走，结果就是应用关了再也起不来。所以杀主进程一律不带 `/T`。

**`taskkill /F /IM <exe>` 无法排除自身 pid。** helper 与被重启的应用共用同一个映像名，按映像名杀等于自杀。改用 `tasklist /FI "IMAGENAME eq ..." /FO CSV /NH` 拿列表，逐个 `/PID` 杀并跳过 `process.pid`。

**web 形态（`dsh web`）下父进程是用户的终端、映像名是共享的 `node`。** 那种情况既不能杀父进程，也不能扫映像名——扫下去会清掉机器上所有 node 进程。helper 按 payload 里的 `kind` 分支：web 只杀宿主自己。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-quick-restart/api/status` | `{ ok, plugin, kind, pid, ppid, execPath, cwd, port, activeTasks, tasksKnown, restarting }` |
| POST | `/dsh-quick-restart/api/restart` | 需要 `x-dsh-quick-restart: 1` 头；202 表示已排程，403 表示校验不过，409 表示已经在重启了 |

## 排障

日志在 `%TEMP%\dsh-quick-restart.log`，每次重启追加一段。

```
helper start pid=... host=... app=...        ← 每次重启一行
taskkill /F /PID <ppid> (electron main)
taskkill /F /PID <pid> (host)
image sweep killed N
port 19387 released=true
relaunched pid=...                            ← 成功标志
```

日志若停在 `relaunch aborted: executable missing`，说明 `process.execPath` 拿不到或文件已不在；手动打开 DSH 即可恢复。

## 开发

没有构建步骤，改完 `lib/` 直接热重载插件包就生效。`lib/index.js` 和 `lib/helper.mjs` 是普通 ESM；`lib/client.js` 手写了 `window.__ModuleLoader__.load({ id, factory })` 外壳，React 通过 `require('react')` 取，不走打包器。整个插件不到 500 行，没有任何运行时依赖。

## 许可

MIT
