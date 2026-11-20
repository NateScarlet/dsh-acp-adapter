// Real Host composition (LlmRuntime, SessionStore, AgentLoop, TokenMeter and the
// published automatic compaction-basic engine) around the real ACP profile
// adapter. The ACP wire is a scripted runtime; switching the route inside one
// profile must price the ACP target with its declared context capacity instead
// of failing with MODEL_SWITCH_COMPACTION_FAILED, for both short and substantial
// history that stays far below the 1M threshold.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type * as acp from '@agentclientprotocol/sdk'
import { AcpProfileAdapter, type AcpProfileRuntime } from '../../../src/host/composition/profile-adapter.ts'
import { AcpSessionFacts, acpSessionView } from '../../../src/host/composition/session-facts.ts'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'

// Resolve the published plugins from the exact CLI dependency graph so this
// integration test exercises the same compaction and token-meter code the Host
// loads, without adding monorepo aliases or fixture copies.
const requireDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const tokenMeterModule = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-token-meter')).href)
const compactionModule = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-compaction-basic')).href)

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const promptText = (blocks: readonly acp.ContentBlock[]) =>
  blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')

async function harness(scenario: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-acp-switch-${scenario}-`))
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const sidecar = createAcpSidecar({ root })
  cleanup.push(() => sidecar.dispose())
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(WorkingDirectory, { defaultDirectory: root })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(tokenMeterModule.default, {})
  await ctx.plugin(AgentLoop, { agents: [] })
  // Pin the published default: automatic compaction enabled.
  await ctx.plugin(compactionModule.default, { auto: true })
  await ctx.plugin(AcpSessionFacts)

  const prompts: string[] = []
  const runtime: AcpProfileRuntime = {
    acpSessionId: `switch-${scenario}`,
    start: async () => undefined,
    restore: async () => 'reused',
    close: async () => undefined,
    async prompt(content, onUpdate) {
      prompts.push(promptText(content))
      onUpdate({
        sessionId: `switch-${scenario}`,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `ack ${prompts.length}` } },
      })
      return { stopReason: 'end_turn' }
    },
  }
  const adapter = new AcpProfileAdapter(
    'switch',
    () => ({ name: 'Switch fixture', command: 'scripted', args: [], env: {} }),
    { ok: true, seam: undefined as never },
    (id) => acpSessionView(ctx, ctx.sessions.get(id as never)),
    {
      begin: (record) => sidecar.beginDispatch(record),
      settle: (id, key) => sidecar.settleDispatch(id as never, key),
      read: (id, key) => sidecar.readDispatch(id as never, key),
    },
    () => ({
      listModels: async (provider) => [
        { provider, id: 'model-a', name: 'Model A' },
        { provider, id: 'model-b', name: 'Model B' },
      ],
    }),
    () => runtime,
    sidecar,
  )
  ctx.llm.registerAdapter(['acp-switch'], adapter)
  const owner = await ctx.agents.create({
    sessionId: SessionId(`acp-switch-${scenario}`),
    agentOptions: { provider: 'acp-switch', model: 'model-a' },
    meta: { cwd: root },
  })
  const agent = owner.agent
  cleanup.push(() => adapter.disposeSession({ id: agent.id, identity: agent.session }))
  return { ctx, agent, prompts, sidecar }
}

describe('ACP model switch under automatic compaction', () => {
  it.each([
    { name: 'short history', priorTurns: 1, textLength: 16 },
    { name: 'substantial history', priorTurns: 8, textLength: 40_000 },
  ])(
    'continues after switching inside one profile with $name',
    async ({ name, priorTurns, textLength }) => {
      const scenario = name.replaceAll(' ', '-')
      const h = await harness(scenario)
      const compaction = h.ctx.get('compaction', false)
      expect(compaction).toBeDefined()
      const send = async (text: string) => {
        h.agent.followup(user(text))
        await h.agent.whenIdle()
      }
      const priorTexts = Array.from({ length: priorTurns }, (_, index) => `${'x'.repeat(textLength)} turn-${index + 1}`)
      for (const text of priorTexts) await send(text)
      expect(h.prompts).toHaveLength(priorTurns)
      expect(h.agent.session.requestHeader()?.config).toMatchObject({ provider: 'acp-switch', model: 'model-a' })

      const beforeSwitch = await h.sidecar.readLatestBinding(h.agent.id)
      expect(beforeSwitch).toMatchObject({
        status: 'ok',
        binding: { provider: 'acp-switch', profileId: 'switch', agentSessionId: `switch-${scenario}` },
      })

      h.agent.model.select({ provider: 'acp-switch', model: 'model-b' })
      await send('after switch')

      const events = h.agent.session.snapshotEvents()
      const ended = events.filter((event) => event.type === 'turn/end')
      expect(ended.at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
      expect(h.agent.session.requestHeader()?.config).toMatchObject({ provider: 'acp-switch', model: 'model-b' })
      // One ACP prompt per turn. A summarization attempt would either add a
      // prompt or fail the turn with ACP_AUXILIARY_CALL.
      expect(h.prompts).toHaveLength(priorTurns + 1)

      // A switch must not rebuild the ACP session: same durable binding and epoch.
      const afterSwitch = await h.sidecar.readLatestBinding(h.agent.id)
      expect(afterSwitch).toMatchObject({ status: 'ok' })
      if (beforeSwitch?.status !== 'ok' || afterSwitch?.status !== 'ok') throw new Error('binding missing')
      expect(afterSwitch.binding.agentSessionId).toBe(beforeSwitch.binding.agentSessionId)
      expect(afterSwitch.binding.bindingEpoch).toBe(beforeSwitch.binding.bindingEpoch)
      await expect(h.sidecar.listBindings()).resolves.toHaveLength(1)

      // Out-of-catalog ids still declare capacity through the Host's exact
      // model-info path (normalizeModelInfo).
      const unlisted = await h.ctx.llm.resolveModelInfo('acp-switch', 'model-unlisted')
      expect(unlisted.context).toEqual({ contextWindow: 1_048_576 })

      const admittedUserTexts = events
        .filter((event) => event.type === 'user/message')
        .flatMap((event) => event.data.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])))
      expect(admittedUserTexts).toContain('after switch')
      for (const text of priorTexts) expect(admittedUserTexts).toContain(text)
      expect(events.filter((event) => event.type.startsWith('compaction/'))).toEqual([])
    },
    60_000,
  )
})
