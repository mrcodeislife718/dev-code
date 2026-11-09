# JobFlow 本地生产交付工厂（2026-10-28）

## 问题
GitHub Copilot 的月度额度限制中断了开发。JobFlow 需要从本地已经完成的第 1–4 组继续，保留原分支，并通过真实验证完成全部功能、集成与生产部署，而不是只生成代码。现有 DevCode 具备无界面执行和会话恢复能力，但这些能力本身并不保证产品交付。

## 实现
- workflows/jobflow/CONTRACT.md 定义预约类企业全年全天候的业务目标、全部渠道和真实交付验收要求。
- scripts/jobflow-factory.mjs 明确接收本地 JobFlow 路径，要求当前分支为 jobflow-completion，不自动重置、变基或推送。
- 运行器读取现有 QWEN_HOME/settings.json，确认模型服务位于本机或私有网络，并拒绝自动改用有额度限制的 Copilot 或云端服务。不会修改凭据或重新安装模型。
- 在 JobFlow 工作目录中调用 DevCode CLI，保存结构化输出与会话 ID，并在下一轮继续同一个会话。
- 在 JobFlow/.devcode-factory 保存原子化状态、日志与测试证据；保留目录中已有的内容。
- 每轮运行 npm test、npm run build 以及明确命名的生产验收脚本。缺失脚本视为未验证，涵盖真实电话、短信、支付、确认与生产部署。
- 如果多轮没有代码进展，则如实报告 BLOCKED，不无意义地消耗计算资源。硬件及外部服务限制不同于厂商令牌配额。
- 不自动推送、部署、购买、修改 DNS 或发送真实营销通讯；这些操作需要操作者批准。

## 使用
- npm run jobflow:factory -- --project /absolute/path/to/jobflow
- npm run jobflow:factory -- --project /absolute/path/to/jobflow --once
- npm run jobflow:factory -- --project /absolute/path/to/jobflow --verify
- npm run jobflow:factory -- --project /absolute/path/to/jobflow --status
- npm run test:jobflow-factory

## 边界
GitHub 连接器无法访问包含最新工作进度的 JobFlow 本地目录。因此本变更不创建相互冲突的第 5 组实现，而是使 DevCode 在正确的本地目录中执行。工厂测试通过并不代表 JobFlow 已上线。真实渠道和生产验证必须使用已授权的服务及部署环境实际执行。

## 验证
运行 Node 内建单元测试，再在用户的实际 JobFlow 工作目录中运行工厂并检查验证结果与证据日志。不能通过始终返回成功的伪验收脚本。合并前应审查全部差异。
