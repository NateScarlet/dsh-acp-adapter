// session-runtime-post-settle-text.spec.ts — 通用 ACP Agent 在 session/prompt RPC settle 之后
// 发出的助手文本，必须进入同一轮的 update 流，使 DSH 适配器能把它投影为普通助手回复。
// 这是连接层 post-settle drain 与 DSH 响应流生成器之间的接缝。Qwen 仍走私有轮次采纳路径。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import { AcpSessionRuntime } from '../../../src/runtime/session/session-runtime.ts'
import type { SubprocessSeam } from '../../../src/runtime/process/subprocess.ts'
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts'
import type { AcpSessionNotification } from '../../../src/protocol/v1/types.ts'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const LATE_TEXT_AGENT = path.join(TEST_DIR, '..', '..', 'fixtures', 'late-text-agent.mjs')
const PROMPT: acp.ContentBlock[] = [{ type: 'text', text: 'Do work.' }]

let subprocess: SubprocessSeam
const runtimes: AcpSessionRuntime[] = []
const roots: string[] = []

beforeAll(async () => {
  subprocess = (await sharedTestSubprocess()).seam
})

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(async (runtime) => await runtime.close()))
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function createRuntime(env: Record<string, string> = {}): AcpSessionRuntime {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-late-text-'))
  roots.push(root)
  const argv = [process.execPath, LATE_TEXT_AGENT, `--late-${String(process.pid)}-${String(roots.length)}`]
  const runtimeEnv = { LATE_TEXT_DELAY_MS: '20', ...env }
  const runtime = new AcpSessionRuntime({
    profileId: 'late-text-generic',
    config: { command: process.execPath, args: argv.slice(1), env: runtimeEnv },
    subprocess,
    cwd: root,
    prepareLaunch: async () => ({ argv, env: runtimeEnv, spawnPlan: { argv, env: runtimeEnv } }),
  })
  runtimes.push(runtime)
  return runtime
}

function texts(notifications: readonly AcpSessionNotification[]): string[] {
  return notifications.flatMap((n) =>
    n.update.sessionUpdate === 'agent_message_chunk' && n.update.content.type === 'text' ? [n.update.content.text] : [],
  )
}

describe('通用 ACP Agent 的 post-settle 助手文本', () => {
  it('把迟到文本送入本轮流，并归属到根会话（主 Agent）', async () => {
    const runtime = createRuntime({ LATE_TEXT_LABEL: 'GENERIC-LATE' })
    const updates: AcpSessionNotification[] = []
    const response = await runtime.prompt(PROMPT, (n) => updates.push(n))
    expect(response.stopReason).toBe('end_turn')
    expect(texts(updates)).toContain('IN-TURN')
    expect(texts(updates)).toContain('GENERIC-LATE')
    // 迟到 chunk 在根 ACP 会话上，适配器据此投影为主 Agent 回复而非外部子会话。
    expect(updates.filter((n) => texts([n]).includes('GENERIC-LATE')).map((n) => n.sessionId)).toEqual([
      'late-text-session',
    ])
    expect(texts(updates).filter((t) => t === 'IN-TURN')).toHaveLength(1)
  })

  it('类子代理完成通知之后的迟到文本仍归属主 Agent 根会话', async () => {
    const runtime = createRuntime({
      LATE_TEXT_LABEL: 'MAIN-REPLY',
      LATE_TEXT_WITH_SUBAGENT_NOTICE: '1',
    })
    const updates: AcpSessionNotification[] = []
    await runtime.prompt(PROMPT, (n) => updates.push(n))
    const thoughts = updates.flatMap((n) =>
      n.update.sessionUpdate === 'agent_thought_chunk' && n.update.content.type === 'text'
        ? [n.update.content.text]
        : [],
    )
    expect(thoughts).toContain('subagent-finished')
    const mainReplies = updates.filter((n) => texts([n]).includes('MAIN-REPLY'))
    expect(mainReplies).toHaveLength(1)
    // 迟到回复在根会话上，故 DSH 投影为主 Agent 的回复，而非子 Agent 或活动输出。
    expect(mainReplies[0]!.sessionId).toBe('late-text-session')
  })

  it('不把迟到文本重放到后续 prompt 轮次', async () => {
    const runtime = createRuntime({ LATE_TEXT_LABEL: 'ONLY-FIRST' })
    const first: AcpSessionNotification[] = []
    await runtime.prompt(PROMPT, (n) => first.push(n))
    const second: AcpSessionNotification[] = []
    await runtime.prompt(PROMPT, (n) => second.push(n))
    expect(texts(first)).toContain('ONLY-FIRST')
    expect(texts(second)).not.toContain('ONLY-FIRST')
  })
})
