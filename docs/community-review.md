# 社区扫描说明

## 0.2.0 报告与复现

核查来源：[公开社区页](https://community.obsidian.md/plugins/better-md-diff)。页面当时扫描版本为 `0.2.0`，源码提交为 `d250d56f34c394dfe309cf7456f12573e7ad99b8`。报告显示 713 条警告，另列发布产物来源证明缺失和恶意软件扫描不可用。计数可能随平台扫描更新。

用官方 `eslint-plugin-obsidianmd@0.4.2` 的推荐配置，对同一份 0.2.0 源码做受控对比，仅改变依赖是否可解析，结果如下：

| 类型安全规则 | 页面计数 | 无依赖复现 | 依赖可解析 |
| --- | ---: | ---: | ---: |
| no-unsafe-member-access | 289 | 289 | 3 |
| no-unsafe-call | 273 | 273 | 0 |
| no-unsafe-assignment | 78 | 78 | 0 |
| no-unsafe-return | 30 | 30 | 0 |
| no-unsafe-argument | 30 | 30 | 2 |
| no-redundant-type-constituents | 1 | 1 | 0 |

这说明大量 `error` / `any` 告警可由缺失 SDK、CodeMirror、Node 和 diff 声明精确复现，不应解读为同等数量的真实漏洞。我们无法直接看到平台的安装日志，因此不能断言平台为何没有解析到这些依赖。仓库较 0.2.0 标签更新的锁文件已修复 npm 10 安装兼容性；新的本地门禁在 `npm ci` 后执行官方 lint。

依赖完整时仍存在的真实类型问题，是 `Array.isArray` 将 CodeMirror 的只读区块数组收窄成 `any[]`。现使用枚举类型判别，未添加强制类型断言，也未关闭类型安全规则。

## 本地修复

- 官方 ESLint 推荐规则接入 `npm run check` 和现有跨平台 CI，零警告门禁。
- 计时器显式使用 `window.setTimeout` / `window.clearTimeout`。
- 使用 Obsidian DOM helpers；gutter 元素归属目标编辑器文档，笔记仍仅作为文本渲染。
- 设置采用共享定义：1.13+ 可搜索，1.8–1.12 保留相同设置与交互。
- 新版本使用破坏性按钮 API，旧版本保留兼容样式；移除已弃用的 slider tooltip 调用。
- 移除扫描标记的 `box-decoration-break` 样式，基础高亮与复制行为不变。
- 根 README 默认英文，保留 Installation / Usage 和简体中文版入口；界面语言自动跟随 Obsidian，支持简体中文和英文。
- 新增贡献指南和签署发布产物的工作流，发布需要人工确认草稿。

## 不应隐藏的能力提示

**Shell Execution / child_process**：本插件必须调用本机 Git。使用 `execFile` 传入参数数组，不经 shell，不执行网络同步或 Git 写入命令；路径按字面值处理，设有输出和超时限制。但用户配置的可执行文件本身仍拥有当前用户权限，因此只应使用可信 Git 路径。这个能力提示可能继续保留，不能靠改名、动态导入或包装 API 来规避扫描。

**Malware scan not available**：这是平台扫描服务的可用性披露，源码无法开启它；本地 lint 和依赖审计不等于恶意软件扫描。

**GitHub artifact attestations**：工作流已经配置，但只有在 GitHub 上对新标签成功执行并发布其原始签署附件后，才能验证来源证明。不应声称未执行的工作流已经清除了线上提示。

## 如何复核

```bash
npm ci
npm run check
npm audit --omit=dev
```

随后按 [贡献指南](../CONTRIBUTING.md#release-and-attestations) 发布新版本，等待社区页扫描该版本。如果仍出现大批相同的类型错误，向平台反馈时附上版本/提交、CI 链接、依赖安装结果和 lint 输出，请其检查类型解析环境。不要将本地“零 lint 警告”描述成社区平台“零风险”。
