# Settle-wake 机制深度分析

## 1. 问题背景

在 revise 场景下，主 agent 的 `before_agent_finalize` hook 触发 revise 审计流程，导致主 agent 处理时间延长。settle-wake 的 gateway 调用因此超时，最终标记为失败。

## 2. Settle-wake 完整流程

### 2.1 触发阶段

```
┌─────────────────────────────────────────────────────────────┐
│                    子 agent 完成流程                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────┐
        │  subagent-registry-lifecycle-wake   │
        │  检测所有子 agent 是否已 settle       │
        └─────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────┐
        │  检查 requesterTurnYielded          │
        │  （主 agent 是否已结束 yield turn）    │
        └─────────────────────────────────────┘
                    │              │
                   NO             YES
                    │              │
                    ▼              ▼
              [等待]      ┌─────────────────┐
                          │ 触发 settle-wake │
                          └─────────────────┘
                                    │
                                    ▼
```

### 2.2 投递阶段

```
┌─────────────────────────────────────────────────────────────┐
│              maybeWakeRequesterAfterAllChildrenSettled       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────┐
        │  构建 wake message:                 │
        │  "所有子 agent 已完成，请处理结果"      │
        └─────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────┐
        │  调用 deliverSubagentAnnouncement   │
        │  参数:                              │
        │  - expectsCompletionMessage: FALSE  │ ← 关键
        │  - expectFinal: TRUE                │ ← 修改为 FALSE
        │  - timeoutMs: 120_000               │ ← 2分钟超时
        └─────────────────────────────────────┘
                              │
                              ▼
```

### 2.3 Gateway 调用

```
┌─────────────────────────────────────────────────────────────┐
│ Gateway 内部处理流程                                          │
└─────────────────────────────────────────────────────────────┘

                    ┌──────────────────┐
                    │ 收到 announce 请求 │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │ 返回第一次响应:    │
                    │ {status:accepted}│
                    └────────┬─────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
              ▼                             ▼
    ┌─────────────────┐          ┌─────────────────┐
    │ expectFinal:    │          │ expectFinal:    │
    │ false           │          │ true            │
    │ (settle-wake    │          │ (普通 completion)│
    │  修改后)        │          │                 │
    └────────┬────────┘          └────────┬────────┘
             │                            │
             ▼                            ▼
    ┌─────────────────┐          ┌─────────────────┐
    │ 直接返回成功     │          │ 启动/等待        │
    │ ✅              │          │ agent turn      │
    └─────────────────┘          └────────┬────────┘
                                          │
                                          ▼
                                 ┌─────────────────┐
                                 │ 等待 turn 完成   │
                                 │ (最多 120s)     │
                                 └────────┬────────┘
                                          │
                                          ▼
                                 ┌─────────────────┐
                                 │ 返回第二次响应:   │
                                 │ {status:        │
                                 │  completed}     │
                                 └────────┬────────┘
                                          │
                                          ▼
                                 ┌─────────────────┐
                                 │ 检查 visible    │
                                 │ reply 等最终结果 │
                                 └─────────────────┘
```

### 2.4 响应处理

```
┌─────────────────────────────────────────────────────────────┐
│              deliverSubagentAnnouncement 决策树              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────────┐
        │ 检查: expectsCompletionMessage &&       │
        │       requesterActivity.isActive        │
        └─────────────────────────────────────────┘
                    │              │
                   YES            NO (settle-wake)
                    │              │
                    ▼              │
        ┌─────────────────┐        │
        │ Steering 注入    │        │
        │ → 成功返回       │        │
        └─────────────────┘        │
                                   ▼
        ┌─────────────────────────────────────────┐
        │ Gateway 调用                             │
        │ dispatchGatewayMethodInProcess          │
        │ - expectFinal: (修改前) TRUE            │
        │ - expectFinal: (修改后) FALSE           │
        │ - timeoutMs: 120_000                    │
        └─────────────────────────────────────────┘
                    │
                    ▼
        ┌─────────────────────────────────────────┐
        │ 检查: isGatewayAgentRunPending?         │
        │ (status ∈ {accepted, started, in_flight})│
        └─────────────────────────────────────────┘
                    │              │
                   YES            NO (终态)
                    │              │
                    ▼              │
          [成功: delivered]        │
                                   ▼
        ┌─────────────────────────────────────────┐
        │ 检查: expectsCompletionMessage?         │
        └─────────────────────────────────────────┘
                    │              │
                   YES            NO (settle-wake)
                    │              │
                    │              ▼
                    │     ┌───────────────────────┐
                    │     │ 跳过所有 visible_reply │
                    │     │ 检查                 │
                    │     └───────────────────────┘
                    │              │
                    │              ▼
                    │     ┌───────────────────────┐
                    │     │ 检查: requireVisible  │
                    │     │ Reply?               │
                    │     └───────────────────────┘
                    │         │          │
                    │        NO         YES
                    │         │          │
                    │         ▼          ▼
                    │    [成功]    ┌──────────────┐
                    │              │ 检查:        │
                    │              │ hasVisible   │
                    │              │ Completion?  │
                    │              └──────────────┘
                    │                  │       │
                    │                 YES     NO
                    │                  │       │
                    │                  ▼       ▼
                    │              [成功]  [失败: visible_reply_missing]
                    │                          │
                    │                          ▼
                    │                    [重试: 最多3次]
                    │
                    ▼
        ┌─────────────────────────────────────────┐
        │ 超时处理                                 │
        │ - 抛出异常                              │
        │ - settle-wake 层重试                     │
        │   - 第1次: 等待 30s                      │
        │   - 第2次: 等待 120s                     │
        │   - 第3次: 标记失败                      │
        └─────────────────────────────────────────┘
```

## 3. 成功条件分析

### 3.1 所有成功路径

| #      | 条件                                                            | 何时触发                                  | 与处理时长的关系                        |
| ------ | --------------------------------------------------------------- | ----------------------------------------- | --------------------------------------- |
| **S1** | Gateway 调用成功 + 到达 line 581                                | 所有检查都通过或跳过                      | Gateway 必须在 120s 内返回              |
| **S2** | `requireVisibleReply: false`                                    | `requesterYieldedAfterDelivery: false`    | 不要求可见回复，只要 gateway 返回即成功 |
| **S3** | `requireVisibleReply: true` + `hasVisibleCompletionReply: true` | requester yielded 且 agent 产生了可见回复 | agent 必须产生可见内容                  |

### 3.2 所有失败路径

| #      | 条件                                                       | 后果                                             |
| ------ | ---------------------------------------------------------- | ------------------------------------------------ |
| **F1** | Gateway 调用超时（> 120s）                                 | 抛异常 → 重试（最多 3 次：30s, 120s 退避）       |
| **F2** | `requireVisibleReply: true` + `!hasVisibleCompletionReply` | 返回 `visible_reply_missing` → 重试（最多 3 次） |

### 3.3 与主 agent 处理时长的关系

#### 场景 1: 主 agent 空闲（无 revise，快速回复）

```
时间线:
  t=0s: settle-wake 触发
  t=0s: gateway 开始新 turn
  t=0.5s: agent 生成回复，turn 完成
  t=0.5s: gateway 返回第二次响应（status: "completed"）
  t=0.5s: < 120s ✅ 成功

结果:
  - requireVisibleReply 通常为 false（因为 requester 没 yield）
  - 即使 requireVisibleReply: true，agent 也会产生可见回复
  - 成功 ✅
```

#### 场景 2: 主 agent 处理中（revise 或长回复，< 120s）

```
时间线:
  t=0s: settle-wake 触发
  t=0s: gateway 正在处理当前 turn（例如 revise 审计）
  t=60s: 当前 turn 完成
  t=60s: gateway 返回第二次响应（status: "completed"）
  t=60s: < 120s ✅ 成功

结果:
  - 如果 agent 产生了可见回复 → hasVisibleCompletionReply: true → 成功 ✅
  - 如果 agent 没有产生可见回复（revise 后无输出）:
    - requireVisibleReply: false → 成功 ✅
    - requireVisibleReply: true → visible_reply_missing → 重试 → 最终失败 ❌
```

#### 场景 3: 主 agent 处理中（> 120s）

```
时间线:
  t=0s: settle-wake 触发
  t=0s: gateway 正在处理当前 turn
  t=120s: gateway 调用超时 ❌
  t=120s: 抛出异常
  t=150s: 重试 1（等待 30s）
  t=270s: 重试 1 超时 ❌
  t=390s: 重试 2（等待 120s）
  t=510s: 重试 2 超时 ❌
  t=510s: 达到 MAX_ATTEMPTS=3，标记失败

结果: 失败 ❌
```

## 4. 关键发现：isGatewayAgentRunPending 是死代码

### 4.1 问题分析

对于 settle-wake：

- `expectFinal: true` → 等待第二次响应
- 第二次响应的 status 是 "completed"（终态）
- `isGatewayAgentRunPending("completed")` → `false`
- **这个检查永远不会进入**

### 4.2 设计矛盾

```
settle-wake 想要 "投递成功" 的语义
但使用了 expectFinal: true（等待完成）

如果 settle-wake 想要 "投递成功" 语义:
  应该使用 expectFinal: false
  → 返回第一次响应: {status: "accepted"}
  → isGatewayAgentRunPending("accepted") → true
  → 直接成功 ✅
  → 不需要等待 agent turn 完成
  → 不会超时

但 settle-wake 使用了 expectFinal: true:
  → 必须等待 agent turn 完成
  → 如果 agent 处理时间长（revise），超时
  → 失败 ❌

矛盾:
  - isGatewayAgentRunPending 检查暗示 "投递成功就够了"
  - 但 expectFinal: true 要求 "必须等待完成"
  - 两者不一致
```

### 4.3 为什么存在 isGatewayAgentRunPending 检查？

这个检查是为 **其他场景** 设计的，不是 settle-wake：

**场景 1: 普通子 agent completion（expectFinal: false）**

```
普通子 agent 完成流程:
  expectFinal: false（默认值）
  → 返回第一次响应: {status: "accepted"}
  → isGatewayAgentRunPending("accepted") → true
  → 直接返回成功 ✅

设计意图:
  - 消息已投递给 gateway
  - agent 是否处理完成是另一回事
  - 对 completion delivery 来说，投递成功就够了
```

**场景 2: expectFinal: true 但第一次响应不是 "accepted"**

```
异常情况:
  expectFinal: true
  第一次响应: {status: "error", message: "..."}
  → 不等待第二次响应（因为 status !== "accepted"）
  → isGatewayAgentRunPending("error") → false
  → 继续检查，最终返回失败
```

## 5. 设计原理分析

### 5.1 为什么这样设计？

```
┌─────────────────────────────────────────────────────────────┐
│                    设计意图                                  │
└─────────────────────────────────────────────────────────────┘

1. expectsCompletionMessage: FALSE
   ┌─────────────────────────────────────────────────────┐
   │ 原因: settle-wake 不是 "completion delivery"       │
   │                                                     │
   │ - 普通子 agent 完成: 需要投递结果给用户              │
   │ - settle-wake: 只是唤醒主 agent "该醒了"            │
   │                                                     │
   │ 效果: 跳过 visible_reply 检查                       │
   │ 即使 agent 没有产生可见回复，也认为成功              │
   └─────────────────────────────────────────────────────┘

2. expectFinal: TRUE（修改前）
   ┌─────────────────────────────────────────────────────┐
   │ 原因: 需要确认 agent turn 已完成                     │
   │                                                     │
   │ - 第一次响应 {status: "accepted"} = gateway 接受了   │
   │ - 第二次响应 {status: "completed"} = agent 处理完了  │
   │                                                     │
   │ 设计假设: 主 agent 应该很快完成                      │
   │ 因为 settle-wake 在主 agent yield 结束后才触发       │
   └─────────────────────────────────────────────────────┘

3. 不使用 Steering（expectsCompletionMessage=false）
   ┌─────────────────────────────────────────────────────┐
   │ 原因: 设计假设主 agent 是空闲的                     │
   │                                                     │
   │ 正常流程:                                           │
   │ 1. 主 agent 调用 sessions_yield                     │
   │ 2. 主 agent 进入等待状态                             │
   │ 3. 子 agent 完成                                    │
   │ 4. settle-wake 触发                                 │
   │ 5. 主 agent 的 yielded turn 结束                    │
   │ 6. settle-wake 调用 gateway                         │
   │ 7. Gateway 启动新 turn → 主 agent 处理 → 快速完成   │
   │                                                     │
   │ 假设: 步骤 7 应该很快（< 120s）                     │
   └─────────────────────────────────────────────────────┘
```

### 5.2 问题根源：Revise 场景

```
┌─────────────────────────────────────────────────────────────┐
│                    正常流程（无 revise）                      │
└─────────────────────────────────────────────────────────────┘

时间线:
t=0s    主 agent 调用 sessions_yield
t=0s    主 agent 进入等待状态
        │
        │  子 agent 处理中...
        ▼
t=30s   子 agent 完成
t=30s   settle-wake 触发
t=30s   Gateway 启动新 turn
t=30.5s 主 agent 处理 settle-wake message
t=31s   主 agent 生成回复
t=31s   Gateway 返回第二次响应 ✅
t=31s   Settle-wake 成功

结果: 31s < 120s ✅


┌─────────────────────────────────────────────────────────────┐
│                    问题流程（有 revise）                      │
└─────────────────────────────────────────────────────────────┘

时间线:
t=0s    主 agent 调用 sessions_yield
t=0s    主 agent 进入等待状态
        │
        │  子 agent 处理中...
        ▼
t=30s   子 agent 完成
t=30s   settle-wake 触发
t=30s   Gateway 启动新 turn
t=30.5s 主 agent 处理 settle-wake message
t=31s   主 agent 准备完成
t=31s   before_agent_finalize hook 触发
t=31s   Hook 返回: {decision: "revise"}
t=31s   主 agent 进入 revise 循环
        │
        │  主 agent 持续处理（审计、重试、长时间思考）
        ▼
t=150s  主 agent 仍在处理
t=150s  Gateway 调用超时（120s） ❌
t=150s  Settle-wake 第1次尝试失败
t=180s  Settle-wake 第2次尝试（等待30s后）
t=300s  主 agent 仍在处理
t=300s  Gateway 调用超时 ❌
t=300s  Settle-wake 第2次尝试失败
t=420s  Settle-wake 第3次尝试（等待120s后）
t=540s  主 agent 仍在处理
t=540s  Gateway 调用超时 ❌
t=540s  Settle-wake 达到 MAX_ATTEMPTS=3
t=540s  Settle-wake 标记失败 ❌

结果: 超时失败


┌─────────────────────────────────────────────────────────────┐
│                    根本矛盾                                  │
└─────────────────────────────────────────────────────────────┘

设计假设:
  settle-wake 触发时，主 agent 应该很快完成处理（< 120s）

实际情况:
  - before_agent_finalize hook 可能触发 revise
  - Revise 导致主 agent 继续处理（审计、重试、长时间思考）
  - 处理时间可能 > 120s
  - Gateway 调用超时
  - Settle-wake 失败

矛盾点:
  settle-wake 使用 expectFinal: true
  → 必须等待 agent turn 完成
  → 但 agent turn 可能因为 revise 而持续很长时间
  → 超过 120s 超时
  → 失败
```

## 6. 解决方案

### 6.1 修改方案

**只改一行代码**，在 `src/agents/subagents/announce/subagent-announce-direct-delivery.ts:386`：

```typescript
// 修改前
expectFinal: true,

// 修改后
expectFinal: params.expectsCompletionMessage,
```

**逻辑关系：**

- `expectsCompletionMessage: true` → 需要检查 visible reply → 需要等待 agent turn 完成 → `expectFinal: true`
- `expectsCompletionMessage: false` → 不需要检查 visible reply → 不需要等待完成 → `expectFinal: false`

**不需要新增参数**，直接利用已有的 `expectsCompletionMessage` 参数来决定是否需要等待完成。

### 6.2 解决方案对比

```
┌─────────────────────────────────────────────────────────────┐
│  方案 A: 当前修改 - expectFinal = expectsCompletionMessage  │
└─────────────────────────────────────────────────────────────┘

优点:
  ✓ 只改一行代码，最小化修改
  ✓ 不需要新增参数
  ✓ 语义清晰：不期望完成消息 = 不需要等待完成
  ✓ 所有场景保持一致的逻辑
  ✓ 解决 revise 场景的超时问题

缺点:
  - 无明显缺点


┌─────────────────────────────────────────────────────────────┐
│  方案 B: 新增 expectFinal 参数                              │
└─────────────────────────────────────────────────────────────┘

需要修改:
  - sendSubagentAnnounceDirectly 添加参数
  - deliverSubagentAnnouncement 添加参数
  - settle-wake 传递 expectFinal: false

优点:
  - 显式控制，更灵活

缺点:
  ✗ 需要修改多个文件
  ✗ 增加代码复杂度
  ✗ 语义冗余（expectsCompletionMessage 已经表达了同样的含义）


┌─────────────────────────────────────────────────────────────┐
│  方案 C: 修改 expectsCompletionMessage 为 true              │
└─────────────────────────────────────────────────────────────┘

效果:
  - 启用 steering 路径（如果主 agent 活跃）
  - 但也会启用 visible_reply 检查
  - 如果 revise 后无可见回复 → visible_reply_missing → 失败

问题:
  ✗ 治标不治本
  ✗ settle-wake 的语义不是 "completion delivery"
  ✗ 不应该要求可见回复


┌─────────────────────────────────────────────────────────────┐
│  方案 D: 增加超时时间                                        │
└─────────────────────────────────────────────────────────────┘

效果:
  - 将 120s 改为 300s 或更长
  - 减少超时概率

问题:
  ✗ 仍然可能超时
  ✗ 增加等待时间
  ✗ 不是根本解决方案
```

### 6.2 修改效果

```
修改后:
  expectFinal: false
  → 返回第一次响应: {status: "accepted"}
  → isGatewayAgentRunPending("accepted") → true
  → 直接返回成功 ✅
  → 不需要等待 agent turn 完成
  → 不会超时
  → isGatewayAgentRunPending 检查变得有意义

优点:
  - 符合 "投递成功" 的语义
  - 避免超时问题
  - 代码更简洁（不需要等待第二次响应）
  - 与 isGatewayAgentRunPending 检查一致

风险:
  - 无法确认 agent 是否真的处理了消息
  - 但对 settle-wake 来说，投递就够了
  - agent 最终会处理（通过 steering 或队列）
```

### 6.3 其他方案对比

**方案 B: 修改 expectsCompletionMessage 为 true**

```
效果:
  - 启用 steering 路径（如果主 agent 活跃）
  - 但也会启用 visible_reply 检查
  - 如果 revise 后无可见回复 → visible_reply_missing → 失败

问题:
  - 治标不治本
  - settle-wake 的语义不是 "completion delivery"
  - 不应该要求可见回复
```

**方案 C: 增加超时时间**

```
效果:
  - 将 120s 改为 300s 或更长
  - 减少超时概率

问题:
  - 仍然可能超时
  - 增加等待时间
  - 不是根本解决方案
```

## 7. 结论

### 7.1 设计合理性评估

**原始设计:**

- ✓ 简洁：expectFinal=true，等待 agent turn 完成
- ✓ 语义清晰：settle-wake 只是唤醒，不要求可见回复
- ✗ 假设过强：假设主 agent 处理时间 < 120s
- ✗ 未考虑 revise：revise 可能导致长时间处理

**问题本质:**
settle-wake 的设计假设 "主 agent 处理很快" 被 revise 打破了

当主 agent 进入 revise 循环时：

- 处理时间可能远超 120s
- expectFinal=true 导致必须等待
- 超时不可避免

**解决方案:**
将 `expectFinal` 改为 `false` 是最合理的：

- 只需要确认消息投递给 gateway
- 不需要等待 agent turn 完成
- 避免超时问题
- 符合 settle-wake 的 "唤醒" 语义
- 使 isGatewayAgentRunPending 检查变得有意义

### 7.2 修改总结

**修改文件:** `src/agents/subagents/announce/subagent-announce-direct-delivery.ts:386`

**修改前:**

```typescript
expectFinal: true,  // 硬编码，所有情况都等待 agent turn 完成
```

**修改后:**

```typescript
expectFinal: params.expectsCompletionMessage,  // 根据语义决定
```

**效果:**

- settle-wake (`expectsCompletionMessage: false`):
  - Gateway 返回第一次响应（status: "accepted"）后立即返回成功
  - 不再等待 agent turn 完成
  - 避免 revise 导致的超时问题

- 普通 completion (`expectsCompletionMessage: true`):
  - 保持原有行为，等待 agent turn 完成
  - 可以检查 visible reply 等最终结果

**优势:**

- 只改一行代码，最小化修改
- 不需要新增参数
- 逻辑清晰：需要检查最终结果时才等待完成
- 符合各自场景的语义

### 7.3 影响范围分析

**修改影响的所有场景：**

| 场景                               | expectsCompletionMessage | expectFinal (修改后) | 影响           |
| ---------------------------------- | ------------------------ | -------------------- | -------------- |
| **settle-wake**                    | `false`                  | `false`              | ✓ 解决超时问题 |
| **普通 completion**                | `true`                   | `true`               | ✓ 无变化       |
| **fire-and-forget** (collect=true) | `false`                  | `false`              | ✓ 语义正确     |
| **media-generate**                 | `true`                   | `true`               | ✓ 无变化       |
| **agent-harness**                  | `true`                   | `true`               | ✓ 无变化       |

**语义正确性：**

1. **`expectsCompletionMessage: false`** (不期望完成消息)
   - 场景：settle-wake、fire-and-forget (collect=true)
   - 行为：不需要检查 agent 的最终输出（如 visible reply）
   - `expectFinal: false`：不需要等待 agent turn 完成 ✓

2. **`expectsCompletionMessage: true`** (期望完成消息)
   - 场景：普通子 agent completion
   - 行为：需要检查 agent 的最终输出
   - `expectFinal: true`：需要等待 agent turn 完成 ✓

**结论：** 修改是安全的，因为：

- 只影响 `expectsCompletionMessage: false` 的场景
- 这些场景本来就不需要等待 agent turn 完成
- 逻辑上完全一致：不期望完成消息 = 不需要等待完成
- 其他所有场景保持不变
