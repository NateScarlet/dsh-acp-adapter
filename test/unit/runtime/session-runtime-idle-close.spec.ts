import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { AcpClientConnection } from '../../../src/protocol/v1/connection.ts'
import { AcpSessionRuntime } from '../../../src/runtime/session/session-runtime.ts'
import type { AcpSubprocessExitFact, AcpSubprocessHandle, SubprocessSeam } from '../../../src/runtime/process/subprocess.ts'

/** 受控子进程 seam：退出事实随 stdin EOF 落定，托管范围证明由 confirmExit 控制。 */
function fakeSubprocess(confirmExit = true): {
  readonly seam: SubprocessSeam
  readonly handles: AcpSubprocessHandle[]
} {
  const handles: AcpSubprocessHandle[] = []
  const seam: SubprocessSeam = {
    resolveExecutable: async (command) => command,
    spawn: () => {
      const stdin = new PassThrough()
      let settleDone!: (fact: AcpSubprocessExitFact) => void
      const done = new Promise<AcpSubprocessExitFact>((resolve) => {
        settleDone = resolve
      })
      stdin.once('end', () => settleDone({ exitCode: 0, signal: null }))
      let terminated = false
      const handle: AcpSubprocessHandle = {
        stdin,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        done,
        terminate: vi.fn(() => {
          terminated = true
        }),
        waitForExit: vi.fn(async () => confirmExit && terminated),
      }
      handles.push(handle)
      return handle
    },
  }
  return { seam, handles }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > until) throw new Error('condition was not met before the deadline')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

function mockConnection() {
  return vi.spyOn(AcpClientConnection.prototype, 'initialize').mockResolvedValue({
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { resume: {} } },
  })
}

describe('idle agent process reclamation', () => {
  it('closes an idle process through the bounded ladder and reports a confirmed exit', async () => {
    const fake = fakeSubprocess()
    const initialize = mockConnection()
    const outcomes: Array<{ readonly confirmed: boolean }> = []
    const runtime = new AcpSessionRuntime({
      profileId: 'idle-close',
      config: { command: 'fake-agent', args: [], env: {} },
      cwd: process.cwd(),
      subprocess: fake.seam,
      prepareLaunch: async () => ({
        argv: ['fake-agent'],
        env: {},
        spawnPlan: { argv: ['fake-agent'], env: {} },
      }),
      idleProcessCloseMs: 20,
      onIdleProcessClose: (outcome) => outcomes.push(outcome),
    })
    try {
      await runtime.initialize()
      expect(fake.handles).toHaveLength(1)
      await waitFor(() => outcomes.length === 1)
      expect(outcomes).toEqual([{ confirmed: true }])
      expect(fake.handles[0]!.terminate).toHaveBeenCalledOnce()
      expect(fake.handles[0]!.waitForExit).toHaveBeenCalled()
      expect(runtime.agentCapabilities).toBeUndefined()
    } finally {
      await runtime.close()
      initialize.mockRestore()
    }
  })

  it('reports an unconfirmed managed-range exit instead of claiming a successful reclaim', async () => {
    const fake = fakeSubprocess(false)
    const initialize = mockConnection()
    const outcomes: Array<{ readonly confirmed: boolean }> = []
    const runtime = new AcpSessionRuntime({
      profileId: 'idle-close-unconfirmed',
      config: { command: 'fake-agent', args: [], env: {} },
      cwd: process.cwd(),
      subprocess: fake.seam,
      prepareLaunch: async () => ({
        argv: ['fake-agent'],
        env: {},
        spawnPlan: { argv: ['fake-agent'], env: {} },
      }),
      idleProcessCloseMs: 20,
      onIdleProcessClose: (outcome) => outcomes.push(outcome),
    })
    try {
      await runtime.initialize()
      await waitFor(() => outcomes.length === 1)
      expect(outcomes).toEqual([{ confirmed: false }])
      expect(fake.handles[0]!.terminate).toHaveBeenCalledOnce()
    } finally {
      await runtime.close()
      initialize.mockRestore()
    }
  })

  it('warns loudly when no cleanup proof is available and no observer is injected', async () => {
    const fake = fakeSubprocess(false)
    const initialize = mockConnection()
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = new AcpSessionRuntime({
      profileId: 'idle-close-default-warn',
      config: { command: 'fake-agent', args: [], env: {} },
      cwd: process.cwd(),
      subprocess: fake.seam,
      prepareLaunch: async () => ({
        argv: ['fake-agent'],
        env: {},
        spawnPlan: { argv: ['fake-agent'], env: {} },
      }),
      idleProcessCloseMs: 20,
    })
    try {
      await runtime.initialize()
      await waitFor(() => warn.mock.calls.some((call) => String(call[0]).includes('idle agent process reclamation')))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not confirm managed-range exit'))
    } finally {
      await runtime.close()
      initialize.mockRestore()
      warn.mockRestore()
    }
  })

  it('relaunches the process and resumes the bound session on the next input', async () => {
    const fake = fakeSubprocess()
    const initialize = mockConnection()
    const capabilities = vi
      .spyOn(AcpClientConnection.prototype, 'agentCapabilities', 'get')
      .mockReturnValue({ sessionCapabilities: { resume: {} } })
    const resume = vi.spyOn(AcpClientConnection.prototype, 'resumeSession').mockResolvedValue({} as never)
    const outcomes: boolean[] = []
    const runtime = new AcpSessionRuntime({
      profileId: 'idle-close-relaunch',
      config: { command: 'fake-agent', args: [], env: {} },
      cwd: process.cwd(),
      subprocess: fake.seam,
      prepareLaunch: async () => ({
        argv: ['fake-agent'],
        env: {},
        spawnPlan: { argv: ['fake-agent'], env: {} },
      }),
      idleProcessCloseMs: 20,
      onIdleProcessClose: () => outcomes.push(true),
    })
    try {
      await runtime.restore({ agentSessionId: 'saved-session' })
      expect(fake.handles).toHaveLength(1)
      await waitFor(() => outcomes.length === 1)
      expect(fake.handles[0]!.terminate).toHaveBeenCalledOnce()
      expect(runtime.acpSessionId).toBeUndefined()

      await runtime.restore({ agentSessionId: 'saved-session' })
      expect(fake.handles).toHaveLength(2)
      expect(resume).toHaveBeenCalledTimes(2)
      expect(runtime.acpSessionId).toBe('saved-session')
    } finally {
      await runtime.close()
      initialize.mockRestore()
      capabilities.mockRestore()
      resume.mockRestore()
    }
  })

  it('keeps an in-flight turn alive and only reclaims after its result settles', async () => {
    const fake = fakeSubprocess()
    const initialize = mockConnection()
    vi.spyOn(AcpClientConnection.prototype, 'newSession').mockResolvedValue({ sessionId: 'active-session' } as never)
    let releasePrompt: (() => void) | undefined
    const promptSpy = vi
      .spyOn(AcpClientConnection.prototype, 'prompt')
      .mockImplementation(
        () =>
          new Promise<never>((resolve) => {
            releasePrompt = () => resolve({ stopReason: 'end_turn' } as never)
          }),
      )
    const outcomes: Array<{ readonly confirmed: boolean }> = []
    const runtime = new AcpSessionRuntime({
      profileId: 'idle-close-busy',
      config: { command: 'fake-agent', args: [], env: {} },
      cwd: process.cwd(),
      subprocess: fake.seam,
      prepareLaunch: async () => ({
        argv: ['fake-agent'],
        env: {},
        spawnPlan: { argv: ['fake-agent'], env: {} },
      }),
      idleProcessCloseMs: 20,
      onIdleProcessClose: (outcome) => outcomes.push(outcome),
    })
    try {
      await runtime.start()
      const running = runtime.prompt([{ type: 'text', text: 'hello' }], () => {})
      await waitFor(() => promptSpy.mock.calls.length === 1)
      await new Promise<void>((resolve) => setTimeout(resolve, 80))
      expect(outcomes).toHaveLength(0)
      expect(fake.handles[0]!.terminate).not.toHaveBeenCalled()

      releasePrompt?.()
      await running
      await waitFor(() => outcomes.length === 1)
      expect(outcomes).toEqual([{ confirmed: true }])
    } finally {
      releasePrompt?.()
      await runtime.close().catch(() => {})
      initialize.mockRestore()
      promptSpy.mockRestore()
    }
  })
})
