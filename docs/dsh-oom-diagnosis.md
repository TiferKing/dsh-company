# DSH Web 内存溢出排查记录

排查日期：2026-09-05。用户确认退出前公司或员工任务持续运行。本轮只读检查 WSL 运行现场、已安装依赖和会话数据统计，另在独立诊断进程中测量缓存序列化；未启动 DSH、运行模型、修改安装配置或公司数据。

## 已确认的直接原因

日志中的 `25141610 ms` 约为进程启动后 6 小时 59 分钟。V8 在堆接近 4 GB 时反复回收，最后一次从约 4074 MB 降到 4056 MB，仍无法继续分配，触发 `JavaScript heap out of memory` 并主动 abort。

这是 Node 进程的 JavaScript 堆达到上限。检查时 WSL 总内存约 125 GiB、可用约 121 GiB、Swap 未使用；这些是崩溃后的观测值，不能还原崩溃瞬间的系统内存，但无需以提高 WSL 内存配额作为首要处理。

| 现场项目 | 观测结果 |
| --- | --- |
| 宿主 | `@deepseek-ai/dsh@0.1.1-rc.2` |
| Node | `v26.7.0`；独立进程默认 `heap_size_limit` 为 4192 MiB |
| 已安装公司插件 | Web profile 中的 `dsh-company@0.16.0` tarball |
| 其他已检查插件 | `dsh-context@0.41.0`、`dsh-smooth-stream@0.6.0` |
| 最大公司状态 | 3,523,842 字节，2753 条货币用量；另一 operating 公司为 2,812,427 字节、1939 条用量 |
| 会话文件 | 193 个，压缩后约 256 MB；流式解压共 709,904,546 字节 |
| 会话事件 | 731,305 条物理 JSONL 记录；展开 chunk 聚合记录后约 6,285,271 个事件 |
| 投影缓存 | `~/.dsh/storages/session_projcache.json` 为 80,601,361 字节，包含 188 个会话记录 |

MB 表示十进制文件字节量，MiB 表示二进制内存单位。磁盘中有多少会话不代表退出时全部处于加载状态。193 个压缩会话均通过逐帧解码检查；没有由本次检查确认的压缩文件损坏。

## 已定位的插件级主要峰值：恢复记账并发放大

已安装的 `dsh-company@0.16.0` 在 continuable Session 创建/冷恢复时执行历史记账补偿。旧实现直接遍历 `session.events`，对每条带 usage 的 `assistant/message` 执行 `void account(...)`；而 `accountUsage` 会先完整读取和解析当前 `company.json`，之后才检查该 usage id 是否已经入账。

这条链路对 `eda-company7` 不是小量边界条件：

- 公司状态为 2,812,427 B，其中已有 1,939 条 usage；
- 最大员工会话已有 591 条 assistant usage；
- 7 名员工累计约 117 次 continuable 激活/结束，冷恢复会反复经过 replay；
- 一次恢复 591 条已记账事件时，旧实现可同时发起 591 次约 2.8 MB 状态读取，仅源 JSON 就对应约 1.66 GB 瞬时输入，尚未计算 UTF-16 字符串、解析对象、Promise、structured clone 和同时工作的其他 Session；
- 崩溃前 e4/e7 两个 Session 同时在活动 step 中截断，符合多个恢复/执行链叠加后跨过约 4 GB 堆上限的表现。

这比单份磁盘文件大小更能解释“运行数小时后突然 OOM”。它不一定是唯一保留路径，但已是可直接修复、且足以制造多 GB 峰值的确定缺陷。

当前工作区修复为：每个 Session 只读取一次公司状态，先建立已记账 usage-id 集合，再只对缺失事件串行补账；同 Session 的 live accounting 也通过 Promise 队列串行化。新增回归测试固定“500 条已记账历史只允许一次 state read”。使用 e2 的真实 591 条 usage 做只读基准时，修复后 `stateReads=1`，显式 GC 后 heapUsed 仅增加约 0.64 MB（RSS 增加约 17.9 MB），不再形成数百个 2.8 MB 解析任务。同时 Scheduler wakeup 改为一个运行 pass 加最多一个合并 rerun，`company_status`/Web GET 不再触发调度写链。

## 宿主侧高风险放大器：投影缓存写入没有背压

以下源码位置相对于实际安装目录：

`/home/tiferking/.nvm/versions/node/v26.7.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`

1. `dsh-agent-loop/lib/index.js:619` 为每个流式 chunk 追加会话事件。
2. `dsh-web-app/cordis.patch.yml:79` 默认每个会话累计 200 个事件，或经过 5000 ms，触发投影检查点；另有 turn/end 和会话卸载触发点。
3. `dsh-session-projection/lib/index.js:148` 对各投影状态执行 `structuredClone`。
4. `dsh-session-projection-cache/lib/index.js:159` 在等待 session flush 和缓存写入前已经克隆检查点、清零计数。没有同会话 in-flight 合并，因此前次未完成时仍可产生后续检查点。
5. `dsh-storage-domain/lib/index.js:210` 将每次写入追加到 Promise 链；`:247` 的闭包保留本次会话检查点，没有按 session key 合并过时待写值。
6. `dsh-storage-json/lib/index.js:220` 执行每条写入时，都会序列化并原子重写整个投影缓存文件。

在独立 Node 进程中，只读加载真实缓存并进行三次完整 pretty JSON 序列化，结果如下。诊断进程堆上限为 512 MiB，未实际写入缓存。

| 测量 | 结果 |
| --- | --- |
| 加载并 GC 后的 heapUsed | 约 75 MiB |
| 三次序列化耗时 | 553、483、482 ms |
| 序列化时 heapUsed | 约 228 MiB |
| 再次 GC 后 | 回到约 75 MiB |

单次序列化本身可以回收，不能称为永久泄漏。但是，仅序列化已把单条写链的吞吐限制在约每秒两次，实际落盘还要增加时间。多会话持续生成检查点时，如果产生速度超过写入速度，排队检查点会持续占用堆。

这里每个排队项保留的是其对应会话的检查点，并非每个排队项都占用完整的 80.6 MB 文件。当前缓存的 `contextHeaders` 仍含历史内容字段：708 个 header epoch 中 500 个带 system，工具 schema 字段共 23,950 个。已安装 dsh-context 的新 header 记录只存元数据，但兼容读取旧记录，旧内容不会因升级立即全部消失。这增加全量重写负担。

这是有现场数据和源码支撑的高优先级风险；缺少退出时的队列深度和堆快照，尚不能断言本次就是该队列占满了 4 GB。

## 其他内存放大路径

- **宿主完整会话历史常驻。** `dsh-session/lib/index.js:1387,1474` 将恢复与新增事件保留在 append-only log 中；`:1401` 访问 events 时还缓存一个完整引用数组。压缩文件中的 chunk 行恢复后展开为大量独立事件。`eda-company7` 的 8 个会话共约 845,417 个展开事件，说明长期任务确实具有较大的对象规模。实际加载了哪些会话，以及这些对象占据多少保留堆，需运行时采样确认。
- **公司插件历史记账回放无并发限制。** 已确认为主要瞬时峰值并在当前工作区修复；旧安装包仍包含该实现，必须升级后再恢复长会话。
- **公司调度唤醒不合并。** 已在当前工作区改为 coalescing pump；状态查询也已改成纯读，不再由每次 Web poll 追加调度 pass。
- **账本增长增加每次操作成本。** [money.ts](../src/money.ts:473) 持续追加 usage，[state.ts](../src/state.ts:378) 在事务内复制、序列化完整状态。这是随历史增长的放大因素；单份公司 JSON 只有几 MB，不能据此直接解释 4 GB。

控制台出现 smooth-stream 的加载提示，只能证明它被加载。已检查的服务端部分主要负责前端配置与设置接口，尚未找到它持续保留模型流历史的证据；浏览器的打字动画也属于另一个进程的堆。

## 建议的安全恢复步骤

1. 确认旧 `dsh web` 已完全退出；不要删除 `~/.dsh/sessions` 或 `~/.dsh/dsh-company`。
2. 备份并移走可重建的全局投影缓存。该文件不是会话事实源，DSH 会从 Session 日志重新生成：

```bash
mv "$HOME/.dsh/storages/session_projcache.json" \
  "$HOME/.dsh/storages/session_projcache.json.bak.$(date +%Y%m%d-%H%M%S)"
```

3. 在不启动 Web Host 的情况下安装已修复包：

```bash
dsh plugin --profile web add /mnt/d/WorkPlace/DSH/dsh-company/dsh-company-0.16.1.tgz
```

4. 首次恢复用 8 GiB 临时堆和诊断输出启动；只保留一个浏览器标签页：

```bash
mkdir -p "$HOME/dsh-diagnostics"
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=8192 --heapsnapshot-near-heap-limit=1 --report-on-fatalerror --report-exclude-env --diagnostic-dir=$HOME/dsh-diagnostics --report-directory=$HOME/dsh-diagnostics" \
  dsh web --no-open
```

5. 若 RSS/heap 仍持续上升，可在 `~/.dsh/profiles/web/cordis.patch.yml` 中把原来的 `[]` 改为以下节流覆盖，然后重启：

```yaml
- id: session-projection-cache
  config:
    writeEveryEvents: 2000
    writeIntervalMs: 30000
```

这不会关闭检查点；`turn/end` 和 Session 卸载仍会强制写入。若还需隔离 `dsh-context`，可临时再加：

```yaml
- id: dsh-context
  disabled: true
```

禁用 `dsh-context` 只用于区分宿主投影链问题，不应替代 FrameQueue/写队列的最终修复。

## 修复与取证顺序

1. 宿主投影检查点按会话合并为“一个执行中、一个最新待写”，在真正开始写入时生成需要的副本；保留卸载和 flush 的持久化等待语义。
2. 缓存后端采用按记录写入或合并批次，避免更新单会话却重写全局文件；兼容迁移旧 contextHeaders，移除可从历史读取的重复内容字段。
3. 公司插件合并工作区调度唤醒，并将记账历史回放改为单次状态读取、提前批量去重和逐 Session 串行补账；本项已在 `0.16.1` 工作区修复。不能通过删除真实 usage 账本降低内存，否则会破坏成本与审批依据。
4. 对长期会话和已退休员工增加宿主支持的历史分页、冷卸载或恢复机制；必须保持事件顺序、上下文和持久化契约。

当前没有退出进程的堆快照，无法直接取得其保留对象图。上面的 8 GiB 只提供恢复和取证余量，不能修复持续积压。堆接近上限时 Node 会尝试生成快照，致命错误时生成诊断报告；快照可能包含会话与凭据，应仅在本机妥善保存。

下一步应检查快照的 dominator/retaining path，区分 `Session.log`、等待写入的 checkpoint/Promise 闭包、公司记账或调度任务，再据此确认主因。仅凭退出日志和静态审查，不把任一插件判定为唯一责任方。

## 重启后公司图标消失：已确认并恢复

同日用户重启 DSH 后，公司入口不显示。这是已取得直接证据的后续故障，与上文尚待确认的 OOM 内存占用主因分别记录。

- 当前 DSH 进程为 `18584`；启动清单含 `dsh-company`，客户端脚本返回 200，浏览器未报告插件加载错误。
- `eda-company7` 的 `identity.json.lock` 仍记录 `8322`，与 OOM 日志中的崩溃进程一致。锁时间为 15:11:17；同一 WSL 内 `/proc/8322` 已不存在。
- 首页及无效会话查询约 0.04 秒返回，有效 Founder 的状态请求等待约 39.52 秒后返回 422：`atomic-write: timed out waiting for the writer lock`。
- 已安装 `dsh-atomic-write/lib/index.js:92` 用独占创建实现文件锁，仅在正常退出操作的 finally 中移除锁，没有检查死亡 PID 并回收锁的逻辑。
- 状态查询经过模型目录失效标记等需要事务的路径，受遗留锁阻塞。[CompanyButton.tsx](../src/client/CompanyButton.tsx:10) 在没有有效快照时直接返回 null，因此接口超时表现为图标完全消失。

恢复时再次核对旧 PID 不存在、锁为普通文件、内容和 inode/mtime 未变，随后把这一个文件原子重命名为同目录的 `identity.json.lock.stale-8322-20260905-210115`，保留备份。没有删除公司状态、账本或事务数据，也没有重启当前 DSH。

恢复验证：Founder 状态接口约 0.06 秒返回 200，返回原公司 `c_11c98cda-2395-4c46-9f37-8e55f380e78b`、7 名员工、20 项工作；浏览器中重新显示“智构流 EDA”，按钮标签为“打开公司面板: 智构流 EDA, 2 项进行中”。

后续代码改进应包括安全的死亡进程锁恢复，以及首次状态加载失败时显示可重试的错误入口。本次完成的是现场恢复，尚未实施这两项长期修复。

## 2026-09-06 再次重启后入口消失：现场恢复与长期修复

本次 Web profile 实际安装 `dsh-company@0.16.1`，DSH 进程为 `12013`。工作区 `46c176973a9b50739db0a094` 的 `identity.json.lock` 内容为 `901\n`，inode 为 `772612`；同一 WSL 内 PID 901 已不存在。有效 Founder 状态请求等待 45 秒超时。插件仍已安装，前端却因首次没有有效快照而把按钮隐藏。

再次核对文件为普通文件、内容及 inode/mtime/ctime 均未变化，并用进程存在性检查确认死亡后，将这一个锁原子改名为 `identity.json.lock.stale-901-20260906-164527`。没有删除公司状态、用量或会话历史。恢复后首页 0.02 秒返回 200，原 Founder 状态接口 1.29 秒返回 200、约 523 KB，仍是原公司、9 名员工和 74 项工作；现有浏览器页面显示“打开公司面板: 智构流 EDA, 1 项待审批”。

代码修复版本为 `0.17.1`：项目写锁增加新锁所有者环境证据和保守死亡锁恢复，恢复者之间使用独占 claim 防止竞争；旧纯 PID 锁、未知环境与活锁继续拒绝自动夺取。客户端首次加载或异常时保留可打开的公司入口，提供错误信息与重试，当前会话发现也不再依赖 overlay 挂载。只有明确查无活动及归档公司才隐藏按钮。

最终 `pnpm verify` 通过 311 项测试、前后端类型检查、生产构建与包加载检查。安装前将公司数据、原插件以及 profile 元数据备份到 `/home/tiferking/.dsh/backups/company-entry-fix-20260906-165745/`。离线安装因既有 `dsh-opencode-usage` 固定 GitHub 提交缺少缓存而失败并还原 profile 元数据；随后补取该已声明依赖、禁用安装脚本，成功将 Web profile 的公司插件更新至 `0.17.1`，其余六个直接插件版本保持原值。

安装后状态接口约 0.12 秒返回 200，原公司仍为 9 名员工。当前运行进程未重启，仍提供旧版快照；现场入口已恢复，新增锁协议与错误入口在正常重启 DSH 后生效。
