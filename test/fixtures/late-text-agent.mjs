#!/usr/bin/env node
// late-text-agent.mjs — 非 Qwen ACP 夹具，模拟 post-settle 助手文本。
// 先发一条 turn 内 chunk，settle session/prompt，再发一条 turn 外的迟到助手文本
// （可选地在类子代理完成通知之后发出）。
// 环境变量：
//   LATE_TEXT_LABEL    迟到文本的内容（默认 'LATE-TEXT'）
//   LATE_TEXT_DELAY_MS RPC 响应后的延迟毫秒数（默认 20）
//   LATE_TEXT_WITH_SUBAGENT_NOTICE  为 '1' 时，在迟到文本前发一条普通的 session/update
//   （agent_thought_chunk）作为子代理完成通知的替身，不带 Qwen 私有元数据。
import readline from 'node:readline'

const LABEL = process.env.LATE_TEXT_LABEL ?? 'LATE-TEXT'
const DELAY = Number.parseInt(process.env.LATE_TEXT_DELAY_MS ?? '20', 10)
const WITH_NOTICE = process.env.LATE_TEXT_WITH_SUBAGENT_NOTICE === '1'
const SESSION = 'late-text-session'

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}
function update(u) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION, update: u } })
}
function text(value) {
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })
}

let promptCount = 0
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  const msg = JSON.parse(trimmed)
  if (msg.id === undefined) return
  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false },
          authMethods: [],
          agentInfo: { name: 'generic-late-text', version: '1.0.0' },
        },
      })
      break
    case 'session/new':
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: SESSION } })
      break
    case 'session/prompt': {
      promptCount += 1
      const emitLate = promptCount === 1
      text('IN-TURN')
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      if (emitLate)
        setTimeout(() => {
          if (WITH_NOTICE)
            update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'subagent-finished' } })
          text(LABEL)
        }, DELAY)
      break
    }
    default:
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not found' } })
  }
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
