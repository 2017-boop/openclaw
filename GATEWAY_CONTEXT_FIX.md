# Gateway Context Resolver 传播修复

## 问题描述

当渠道（如飞书）触发的 agent 运行中通过 `sessions_spawn` 生成子 agent 时，子 agent 成功完成但父 agent 无法收到完成通知。Gateway 日志显示：

```
error agents/subagents/announce requester settle wake failed: gateway request scope or instance binding ...
```

子 agent 运行到完成（审计通过，回复已生成），但结果无法传递给父 agent，最终回复也无法送达用户。

## 根本原因

Gateway context resolver 用于在异步边界传播调用者身份和 dispatch 能力。问题的核心在于渠道触发的 inbound run 的 dispatch 链路：

1. **Gateway 插件运行时绑定** (`src/gateway/server-plugins.ts`) 创建了一个包装过的 `dispatchReplyFromConfig`，该函数调用 `withPluginRuntimeGatewayContextResolver` 来设置 resolver 的 AsyncLocalStorage scope。

2. **插件注册表** (`src/plugins/registry-runtime.ts`) 将这个包装过的函数传递给渠道运行时：`createRuntimeChannel({ dispatchReplyFromConfig: ... })`。

3. **渠道运行时** (`src/plugins/runtime/runtime-channel.ts`) 通过 `channelRuntime.reply.dispatchReplyFromConfig` 暴露了包装过的函数，**但是** `runChannelTurn`（用于 `core.channel.inbound.run`）没有接收到它。

4. **Dispatch 回退** (`src/auto-reply/dispatch.ts`) 当没有注入自定义函数时，回退到默认导入的 `dispatchReplyFromConfig`。**这个默认版本不会设置 `withPluginRuntimeGatewayContextResolver`**。

5. **结果**：当子 agent spawn 尝试通过 `getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext` 获取 gateway context resolver 时，返回 `undefined`，因为 AsyncLocalStorage scope 从未被设置。Resolver 无法绑定到子 agent 运行记录，requester settle wake 失败。

**核心问题**：`runChannelTurn` 没有将 gateway 包装的 `dispatchReplyFromConfig` 注入到 turn plan 中，导致 dispatch 链路使用了缺少 resolver scope 设置的默认函数。

## 修复方案

修改 `src/plugins/runtime/runtime-channel.ts`，当提供了自定义 `dispatchReplyFromConfig` 时，包装 `runChannelTurn`：

```typescript
const runInbound: typeof runChannelTurn = options?.dispatchReplyFromConfig
  ? (params) => {
      const wrappedAdapter = {
        ...params.adapter,
        resolveTurn: async (...args: Parameters<typeof params.adapter.resolveTurn>) => {
          const turn = await params.adapter.resolveTurn(...args);
          if (turn && typeof turn === "object" && !("runDispatch" in turn)) {
            return { ...turn, dispatchReplyFromConfig: options.dispatchReplyFromConfig };
          }
          return turn;
        },
      };
      return runChannelTurn({ ...params, adapter: wrappedAdapter });
    }
  : runChannelTurn;
```

然后将 `inbound.run` 从 `runChannelTurn` 改为 `runInbound`：

```typescript
inbound: {
  buildContext: buildChannelInboundEventContext,
  run: runInbound,  // 原来是: runChannelTurn
  runPreparedReply: runPreparedChannelTurn,
  dispatch: dispatchInbound,
  dispatchReply: dispatchAssembledChannelTurn,
},
```

这确保了当渠道使用 `core.channel.inbound.run` 时，gateway 提供的 `dispatchReplyFromConfig` 被注入到 adapter 解析的 turn 中，因此 dispatch 链路使用了设置 `withPluginRuntimeGatewayContextResolver` 的包装函数。

## 修复后的流程

1. 飞书消息接收
2. 调用 `core.channel.inbound.run`（现在包装为 `runInbound`）
3. `runInbound` 包装 adapter 的 `resolveTurn` 以注入 `dispatchReplyFromConfig`
4. `runChannelTurn` 执行，turn plan 中包含注入的函数
5. Dispatch 使用 gateway 包装的 `dispatchReplyFromConfig`
6. `withPluginRuntimeGatewayContextResolver` 设置 AsyncLocalStorage scope
7. `getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext` 返回 resolver
8. Resolver 传播到子 agent spawn 并绑定到运行记录
9. Requester settle wake 成功使用 resolver 发送完成通知
10. 父 agent 收到子 agent 结果并发送最终回复

## 验证

修复后，以下日志序列确认成功：

```
info channels/feishu received message from ou_xxx
info channels/feishu dispatching to agent
info newsanalyst-agent replied with joke
info newsanalyst-agent audit passed
info announce:requester-settle:...:yield-1 ended with stopReason=stop
info analystsmanager-agent delivered final reply
```

没有出现 "requester settle wake failed" 错误。

## 相关文件

| 文件                                                                       | 说明                                 |
| -------------------------------------------------------------------------- | ------------------------------------ |
| `src/plugins/runtime/runtime-channel.ts`                                   | 修复位置                             |
| `src/gateway/server-plugins.ts`                                            | 创建包装的 `dispatchReplyFromConfig` |
| `src/plugins/registry-runtime.ts`                                          | 传递包装函数到渠道运行时             |
| `src/channels/turn/run-channel-turn.ts`                                    | Turn 执行                            |
| `src/auto-reply/dispatch.ts`                                               | Dispatch 回退逻辑                    |
| `src/agents/subagents/announce/subagent-announce.requester-settle-wake.ts` | Requester settle wake                |

## 影响范围

此修复影响所有使用 `core.channel.inbound.run` 进行 turn 执行的渠道触发 inbound run，包括：

- 飞书 (Feishu/Lark)
- 其他使用相同 inbound run 路径的渠道

**Production LOC delta**: +13 行（核心修复）
