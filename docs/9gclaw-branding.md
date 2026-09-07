# 9GClaw 品牌版本

- 分支：`feat/9gclaw`，发布仓库：`mssssss123/PilotDeck`。
- 功能基线：`OpenBMB/PilotDeck` 的 2026-09-05 提交 `8ba2eb04cefec52fd9068d46a1a0d18b47689bea`；不引入该提交之后的功能变化。
- 品牌名称：**9GClaw**；命令和工作区包名使用 `9gclaw`、`9gclaw-ui`、`9gclaw-desktop`。
- Logo 原图：[UltraRAG/PilotDeck/ui/public/logo-256.png](https://github.com/UltraRAG/PilotDeck/blob/main/ui/public/logo-256.png)，原样保存于 `ui/public/logo-256.png`。PNG、SVG 容器、PWA 多尺寸图标、明暗字标、Windows ICO 和 macOS ICNS 均由该原图派生。大于 256px 的版本是放大图，不代表更高的原始分辨率。
- 运行 `node scripts/rebuild-brand-assets.mjs` 可重新生成全部品牌资源。运行必需的品牌图片使用普通 Git 文件，无需 Git LFS。

## 兼容性

本次是品牌替换。为保证已有配置、插件、会话和自动化继续工作，保留 `~/.pilotdeck`、`pilotdeck.yaml`、`PILOTDECK_*` 环境变量、内部模块名、协议字段、IPC 事件和本地存储键。npm 命令入口同时保留 `pilotdeck` 别名；安装脚本生成 `9gclaw` 启动命令。桌面产品名及安装包名为 `9GClaw`，应用标识为 `cn.ninegclaw.desktop`。

安装器默认下载此 fork 的 `feat/9gclaw` 分支；源码更新仍跟随当前分支。桌面更新默认读取此 fork 的 Releases，没有发布包时不会回退下载上游产品。

原始版权、许可证、上游项目链接和历史演示素材保留其来源信息。README 中的上游网站、演示与教程不是 9GClaw 的独立托管服务。

## 验证记录

使用 Node.js 22.23.2 验证：

- 后端构建、Vite 生产构建、桌面 TypeScript 编译通过；冻结锁文件检查通过。
- UI / 服务端按仓库 Web Regression CI 的既有排除规则验证：共 150 个文件、1,182 项测试通过（其中搜索示例数据修正后单独补验 3 项）。
- 桌面构建脚本测试：18 项通过。
- 核心完整测试：503 项通过、2 项跳过、8 项因事件循环提前结束而取消。在未修改的基线提交上，以相同 Node 版本编译并运行对应的 network/task 测试，复现相同的 8 项取消。
- 浏览器检查了引导页的标题、Logo 加载和显示比例；图标覆盖 PWA 各尺寸、SVG favicon、Windows ICO 和 macOS ICNS。未执行完整 Windows/macOS 安装包安装。
- 原图 SHA-256：`36c58fcbe68e6c7231358bed117acacbe37e5e76da791dd60c577ac93ed27a4b`。
