# iSub 运维方案 · 单机房（Single-Host）

*日期：2026-06-17 ｜ 前提：**无多机房预算** → 不做跨机房 HA（那本就被卡在一个尚不存在的 Postgres 组件上）。本方案是单主机下把"可用性、收入、安全"做到位的运维手册。*

---

## 0. 一句话

单主机跑一个 `IsubGateway`(托管多租户) + SQLite 单库。可用性靠**进程级自愈(systemd 自动重启)+ 单实例锁自恢复**;主机硬件故障 = 计划内停机,靠**快照备份 + 快速重建**兜底。因为**停机时长 ≈ 漏收入**(见 §3 与"漏收入"问题),核心 KPI 是**重启快、备份紧、gas 不断**。

---

## 1. 拓扑（单主机）

```
        商家/agent ──api-key──▶  IsubGateway (node:http, :443)
                                    │  签名用 iSub keeper 私钥(仅活性权力)
                                    ├─ IsubService(每租户) ─ IsubBiller(PAYG 结算循环)
                                    ├─ IsubKeeper(Fixed 订阅扣款循环)
                                    └─ SQLite(db.ts)  ◀── 唯一真相源:usage / journal / locks
                                          │
                          fullnode (gRPC, testnet/mainnet)  ◀── 链是最终权威
```

- **1 台 VM**(本地 SSD)。**1 个 gateway 进程**(可选:keeper 单独进程)。**1 个 SQLite 文件**。
- **单实例锁是正确选择**(无跨机房需求)。锁在 SQLite `locks` 表,带 `heartbeat_ms` + `holder=host:pid` + pid 存活探测;崩溃后心跳过期 + pid 不存活 → 重启的进程自动接管(`sql-store.ts` / `store-file.ts` 已实现)。

---

## 2. 可用性：单主机的"热备"= 进程自愈

没有第二台机,所以 HA 落在**进程级**和**快速恢复**:

1. **systemd 守护 + 自动重启**(这就是单机房的"热备"):
   ```ini
   # /etc/systemd/system/isub-gateway.service
   [Service]
   ExecStart=/usr/bin/node /opt/isub/dist/gateway-main.js
   Restart=always
   RestartSec=2
   EnvironmentFile=/opt/isub/env          # 密钥/网络/包id(见 §4)
   LimitNOFILE=65536
   [Install]
   WantedBy=multi-user.target
   ```
   进程崩溃 → 秒级拉起 → 锁因心跳过期+pid 不存活被新进程接管。**链上幂等**(interval 闸 / charge_seq)保证重启瞬间的任何重叠只浪费 gas、不会双扣。
2. **健康探针**:`GET /health` → systemd/watchdog 或外部探针每 30s 检查;连续失败触发重启 + 告警。
3. **接受的现实**:**主机硬件故障 = 停机**(无多机房)。靠 §5 的快照在新 VM 上 ≤15 分钟重建(目标 RTO)。**把 RTO 当收入指标**——见 §3。

---

## 3. ⚠️ 停机 = 漏收入(为什么运维 KPI 这么严）

链上合约对 Fixed 订阅是"一个周期最多扣一次、且扣款时刻重置计时"——**keeper 停机错过的周期永久收不回**(详见 self-audit / exec-brief 的"漏收入"问题)。所以对运维的硬性要求:

- **keeper/biller 任何停摆都要分钟级恢复**(systemd 自愈 + 告警),不能放任过夜。
- 上线"漏收可见"指标后(路线图 Phase 1),把 **schedule-lag / past_due 数**纳入告警——**它直接换算成正在流失的收入**。
- 维护窗口要短:停→迁移→起 一气呵成(§6)。

---

## 4. 密钥与 gas（最敏感）

- **keeper 签名私钥(热钥)**:gateway 用它签所有 charge。它**只有活性权力**(链上 cap 死、钱进商家 payout),但仍要保护:
  - 存于 **secrets manager / KMS / 受限 env 文件**(`chmod 600`,`EnvironmentFile`),**绝不进 repo**(`.secrets/` 已 gitignore)。
  - 轮换计划:目前单钥;路线图 Phase 4 上"按商家分钥 + 赞助 gas 账户"(被盗即零作案预算)。
- **gas 钱包(keeper 地址)**:必须持有 SUI 付 gas。**gas 耗尽 = 计费全停 = 收入停**。
  - 监控余额,**低于 N 笔扣款的阈值即告警 + 自动/手动补充**。
  - 微额订阅注意 gas 经济学(price < gas 不划算)——路线图 Phase 4 处理。

---

## 5. 持久化与备份（SQLite 是唯一真相源）

`usage_records / journal / locks` 全在 SQLite。**journal 丢失 = 失去对账基线**(也失去漏收基线)。所以:

- **WAL 模式**(并发读 + 崩溃安全):`PRAGMA journal_mode=WAL`。
- **定时快照到异地对象存储**:每 5–15 分钟 `sqlite3 .backup` / `VACUUM INTO` → 上传 S3/对象存储,保留 N 天 + 每日一份长留。
- **恢复演练**:文档化"拉最新快照 → 起进程 → **跑 `reconcile` 对链核账**(发现漂移)"。
- **磁盘**:监控 SQLite 文件 + WAL 增长(journal 当前无界——路线图 Phase 5 加压缩);磁盘水位告警。

---

## 6. 部署 / 升级（单主机,短窗口）

```
1) 备份当前 DB(§5 快照)
2) systemctl stop isub-gateway        # 锁释放
3) 部署新 build
4) 跑 DB 迁移(路线图 Phase 0 的幂等 ALTER 迁移器——加列前置)
5) systemctl start isub-gateway       # 起来后跑一次 reconcile 自检
```
- 停机要短(§3)。链上幂等 → 升级期的瞬时重叠安全。
- **合约升级**走另一套(version gate + migrate),不在日常运维内。

---

## 7. 监控 / 告警（最小集）

| 指标 | 含义 | 告警阈值 |
|---|---|---|
| `/health` | 进程活着 | 连续失败 → 重启+告警 |
| keeper/biller last-tick | 收款循环在跑 | N 分钟无 tick → **严重**(=正在漏收) |
| charge 成功/失败率 | 计费健康 | 失败率突增 |
| **gas 余额** | 能不能付 gas | 低于 N 笔 → **严重** |
| schedule-lag / past_due 数 | **漏收/落后**(Phase 1 上线后) | 任何持续 >0 |
| DB / WAL 大小、磁盘 | 持久化健康 | 水位/备份失败 |

告警接 PagerDuty/飞书/钉钉;**gas 低、keeper 停摆**两条是 P1(直接停收入)。

---

## 8. 事故处置（runbook 摘要）

- **进程挂** → systemd 自愈;锁卡住 → 心跳过期+pid 探测自动接管;**手动删锁仅在确认无活进程后**。
- **gas 耗尽** → 给 keeper 地址补 SUI → 下一 tick 自动恢复。
- **用户余额不足** → dunning 自动处理(past_due → 宽限 → lapsed),商家按事件门控服务,**不动链上 mandate**(免签恢复)。
- **疑似双扣/漂移** → 跑 `reconcile`,**链上 `charge_seq` 为准**(永不双扣是合约保证)。
- **DB 损坏** → 从最新快照恢复 → **跑 reconcile 对链核账**。

---

## 9. 容量与成本

- **单主机有上限**(对应路线图"规模"问题):先**垂直扩**(更大 VM),分批读/并发/按到期调度(Phase 3)能把单机天花板顶很高;真到瓶颈再谈分片(届时才需要 Postgres,即多机房预算的事)。
- **成本**:VM + 存储 + **gas**(随扣款量,需监控)。

---

## 10. 这套方案的边界（诚实）

- **不抗主机级灾难**(无多机房):硬件故障靠快照 + 快速重建,有分钟级 RTO 缺口。可接受的前提是**链上幂等 + 非托管**——停机不丢钱安全性,只丢"按时收"。等收入规模值得多机房预算时,再按路线图上 Postgres advisory-lock 跨机房(那是唯一需要多机房的部分)。
