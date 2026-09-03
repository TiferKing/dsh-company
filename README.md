# dsh-company 插件公司

**不想当牛马了？来当老板！开插件公司，雇AI牛马，过赛博人生！**


> 面向 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的决策驱动 AI 软件公司编排插件 —— HR 治理、货币预算、工作 DAG、工单、审批与完整 Web 控制台。

`dsh-company` 把当前根会话变成**创始人（Founder）**，把持久 continuable 子代理变成**员工**，用一家真正的公司来组织软件开发：分阶段成立方案 + 人类审批、HR 先行的招聘治理、多级组织树、以货币计价的预算体系、三档费率模型价格矩阵、带尝试栅栏的依赖 DAG 工作项、人类工单、类型化审批，以及不可变审计账本。

目标宿主：`@deepseek-ai/dsh@0.1.1-rc.2`（DSH rc.2）。

[English documentation](README.en.md)

---

## 为什么需要它

让 AI 帮你干活很容易，让 AI **替你经营一家研发团队**却很难。当你对一段对话说"把这个产品做出来"，通常会遇到这些痛点：

**委托会退化。** 你想要的是一个统筹全局的决策者，得到的却是一个埋头写码的执行者——CEO 亲自下场修 bug，没人做规划、没人盯进度、没人对结果负责。

**组织会失控。** 代理为了"高效"随手拉起新的帮手：身份不明、不在编制里、不受你约束。事后你甚至说不清这个项目里到底有谁、谁干了什么。

**成本是笔糊涂账。** 模型调用在暗处计费，你不知道这个功能烧了多少钱、哪个环节最贵、预算还剩多少——等发现超支时为时已晚。

**决策没有凭据。** "当时为什么这么做？"没有人能回答。代理换了上下文就忘了承诺，关键变更（预算、发布、人事）既没有审批记录，也没有你的明确背书。

**质量无人把关。** 谁验证过这个实现？谁评审的？能不能发布？没有验收标准和独立审查，"完成了"只是代理的一面之词。

dsh-company 用一家**真正的公司**来回答这些问题：你出决策，公司出执行——有编制、有账本、有审批、有审计。它把"管理一个 AI 团队"变成"经营一家看得见、管得住、算得清的公司"。

## 特性亮点

- **决策先行** —— AI 起草名称/标语/使命/章程/首款产品/预算/价格；人类编辑并明确批准后才启动。成立批准只配额一名 HR 负责人。
- **HR 治理** —— 每次招聘、路线变更或退休都从 HR 评估开始（难度、provider/model、推理强度、员工预算、组织路径、岗位），再经人类批准的 `organization_change`。
- **章程即结构化数据** —— 宿主把章程文本解析为条款树（`company.charter_outline`）；Web 端零解析直接渲染为可展开树。
- **招聘页** —— 逐模型启用开关（默认关 = 未启用）把住招聘入口：HR 只能推荐已启用（三档定价完整）的路线。内置 OpenAI / DeepSeek / 智谱 BigModel 常见模型官方价目预设（按公司币种匹配 USD/CNY），打开开关自动预填——预设绝不自动启用任何路线。
- **工单** —— 人类从 Web 控制台提交产品问题工单；创始人（或派驻支持工程师）分级、派发；关联修复工作完成即自动 resolved；关闭时回复人类。
- **货币优先记账** —— 整数微货币是唯一权威；Web 端收人类单位（最多 6 位小数），在宿主边界一次转换。BigInt 汇总后统一一次半向上舍入；reasoning token 绝不重复计费。
- **审计** —— 公司/产品预算、支出/预留/可用、按 provider/model 分色的全生命周期开销图表，以及基于只追加事件日志的有界审计明细窗口。
- **Web 控制台与设置页同权** —— 回环同源页面即命名会话的参与者（编辑/审批/派发，直接落盘）；远程客户端严格只读。每次控制台决策都会向创始人会话注入权威记录（steer）。
- **冷恢复纪律** —— 员工是持久 continuable 会话；宿主重启后调度器以同一 attempt 恢复未完成工作。创始人策略明确禁止复刻员工身份。

## 安装

要求：Node `^22.19.0 || >=24`、pnpm、运行中的 DSH rc.2 宿主。

```bash
git clone https://github.com/<you>/dsh-company.git
cd dsh-company
pnpm install
pnpm verify        # typecheck + test + build + package:check
pnpm pack          # 产出 dsh-company-<version>.tgz

dsh plugin --profile/web add /absolute/path/to/dsh-company-<version>.tgz
```

重启原有 DSH Web 进程并刷新原 URL——不要另起替代服务器。

## 快速上手

   一个可以直接粘贴的完整样例：

   > 成立一个公司，并且我任命你为公司的CEO，公司的使命是"将知识惠及全球"，公司第一款产品是"以AI为基础的生成式学习平台"，请成立公司并运营，定期汇报产品进度和竞争力，公司总预算300 CNY，其中用于产品的预算为250 CNY。成立产品、研发、测试三个部门，并配备相应人员，先进行产品定义，产品经理岗位不要吝啬预算，我要最好的产品定义，在产品定义结束后再根据产品功能招聘相应的架构师、研发和测试。

1. **要一家公司** —— 在一个工作区为产品仓库的 DSH 会话里，明确要求 agent 成立一家有具体使命的公司。它通过 `company_bootstrap` 起草完整方案（staged 状态，什么都不会启动）。

2. **审阅并批准** —— 打开 Web 控制台（会话头的公司按钮）。在概览表单编辑方案（或让 agent 执行 `company_edit_formation`），然后批准。只有 HR 负责人会被配额。
3. **在招聘页启用模型** —— 打开允许 HR 推荐的路线开关；预设价格自动预填；提交审批。
4. **通过 HR 招聘** —— `company_request_staffing` → HR 认领并提交评估 → 你批准 `organization_change` → 创始人应用招聘。
5. **规划工作、提工单** —— 工作项组成带验收条件的依赖 DAG；产品反馈进入工单页，由决策派发为修复工作。
6. **盯紧钱** —— 审计页展示预算、预留与分路线全生命周期成本；每次变更都进审计账本。

## Web 控制台

标签页：**概览 / 组织 / 产品 / 工作 / 工单 / 招聘 / 审计 / 审批**。

- **概览** —— 标语与使命、章程树、阻塞事项、实时活动。
- **组织** —— 可折叠组织树（负载分带、内联成员、部门子树金额与模型分布、负责人归属、员工详情与授权面板）。
- **工单** —— 人类提交表单 + 状态分组（待分级/待派发、已解决待关闭、已关闭含回复）。
- **招聘** —— 上文所述的启用开关价格矩阵。
- **审计** —— 金额统计、用量成本图表、有界审计明细。
- **审批** —— 决策卡：审批内容常显，范围摘要与详细信息默认折叠。

远程浏览器看到只读降级视图；回环页面获得完整参与者视图与变更能力（见[宿主/Web 契约与安全](#宿主web-契约与安全)）。

## 宿主工具

| 工具 | 谁可用 | 用途 |
|---|---|---|
| `company_bootstrap` / `company_edit_formation` / `company_approve` | 创始人 | 起草 / 编辑 / 批准成立方案 |
| `company_request_staffing` / `company_claim_staffing_assessment` / `company_submit_staffing_assessment` | 创始人 / HR | HR 治理招聘流水线 |
| `company_add_employee` / `company_remove_employee` / `company_apply_staffing_adjustment` | 创始人 | 应用已批准的组织变更 |
| `company_create_work` / `company_edit_work` / `company_reassign_work` | 创始人 | 工作 DAG 规划 |
| `company_claim_work` / `company_update_work` | 员工 | 尝试栅栏下的执行与举证 |
| `company_send_message` | 参与者 | 持久跨参与者消息（不可信数据框架） |
| `company_request_approval` / `company_resolve_approval` | 参与者 / 创始人 | 类型化人类审批 |
| `company_request_budget_change` / `company_request_governance_change` / `company_reprobe_models` | 创始人 | 预算与价格审批、目录重探测 |
| `company_triage_ticket` / `company_dispatch_ticket` / `company_close_ticket` / `company_designate_support` | 创始人 / 支持 | 工单生命周期 |
| `company_grant_temporary_authorization` / `company_revoke_temporary_authorization` | 创始人 | 有界未知成本授权 |
| `company_control` / `company_status` | 创始人 / 参与者 | 暂停/恢复/归档；角色过滤快照 |

## 状态与数据

```
~/.dsh/dsh-company/v1/workspaces/<工作区哈希>/
├── identity.json      # 工作区锚点（规范路径 + sha256）
├── active/            # 运营中的公司
│   ├── company.json   # 全量状态（schemaVersion 1）
│   ├── events.jsonl   # 只追加审计账本（每次变更一行）
│   └── mailboxes/     # 每参与者持久收件箱
└── archive/<id>/      # 归档公司（同构布局）
```

员工对话转录存放在 DSH 会话存储（`~/.dsh/sessions/`），以其保留的会话 id 索引——重启后带完整上下文恢复。

## 宿主/Web 契约与安全

- `GET /plugins/dsh-company/state?sessionId=…` —— snake_case 投影。回环同源页面获得该会话真实参与者视图（创始人得到可编辑的 founder 视图）；远程客户端（仅 `allowRemoteUi` 开启后可达）获得降级只读视图，私有证据全部剥离。
- `POST /plugins/dsh-company/action` —— 回环页面以命名会话参与者身份执行（修订栅栏；运行时二次校验精确在世创始人与公司绑定）。远程客户端固定拒绝（`403 web_mutations_require_loopback`）。成功的控制台决策会 steer 创始人会话。
- 快照永不携带 attempt capability、执行 prompt、凭据或私有工作证据。临时授权绝不改变 DSH 工具权限或沙箱。

## 开发

```bash
pnpm verify          # typecheck && test && build && package:check
pnpm test            # test/ 下的 node:test 套件
pnpm build           # tsc（宿主+客户端）+ tsdown 打包
```

CI 在每次 push 和 PR 上运行同一 `pnpm verify` 门禁（见 `.github/workflows/ci.yml`）。

### 发布

1. 同时改 `package.json` 与 `scripts/verify-package.mjs` 中的版本断言。
2. 运行 `pnpm verify && pnpm pack`。
3. 打 `v<version>` 标签并推送；release 工作流校验后把 tarball 附到 GitHub Release。
4. 用 `dsh plugin --profile/web add <tarball>` 安装。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
