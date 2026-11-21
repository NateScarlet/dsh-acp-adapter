import { acpModelSelection, isAcpModelRouteWithinBounds } from './model-selection.ts'

type ModelRoute = { readonly provider: string; readonly model: string }

/** 在绑定会话上确认具名切模、而不是另开会话的预设。 */
export const ACP_IN_PLACE_MODEL_SWITCH_PRESETS = ['acp-adapter', 'standard', 'cordis', 'ptc', 'minimal'] as const

export function permitsAcpInPlaceModelSwitch(preset: unknown): boolean {
  return typeof preset === 'string' && (ACP_IN_PLACE_MODEL_SWITCH_PRESETS as readonly string[]).includes(preset)
}

/** 只有可确认的具名模型路由才属于原地切模。 */
export function isAcpInPlaceSwitchModel(preset: unknown, model: string): boolean {
  return permitsAcpInPlaceModelSwitch(preset) && acpModelSelection(model).kind === 'declared-model'
}

/** 原地预设下的两个显式模型选择可以在实时 ACP 会话上确认。 */
export function isAcpPresetModelSwitch(
  previous: ModelRoute | null | undefined,
  next: ModelRoute,
  preset: unknown,
): boolean {
  return (
    permitsAcpInPlaceModelSwitch(preset) &&
    previous != null &&
    previous.provider === next.provider &&
    previous.model !== next.model &&
    isAcpModelRouteWithinBounds(previous.model) &&
    isAcpModelRouteWithinBounds(next.model) &&
    isAcpInPlaceSwitchModel(preset, previous.model) &&
    isAcpInPlaceSwitchModel(preset, next.model)
  )
}

/** 未知预设和无法确认的模型身份仍走独立会话交接。 */
export function requiresAcpModelSwitchExit(
  previous: ModelRoute | null | undefined,
  next: ModelRoute,
  ownsProvider: (provider: string) => boolean,
  preset?: unknown,
): boolean {
  return (
    previous != null &&
    previous.provider === next.provider &&
    previous.model !== next.model &&
    ownsProvider(next.provider) &&
    !isAcpPresetModelSwitch(previous, next, preset)
  )
}
