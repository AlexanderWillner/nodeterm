import type { CanvasNodeState } from '@shared/types'
import { NODE_COLORS } from '../state/workspace'
import type { KanbanSession } from '../components/kanban/KanbanView'

export function toKanbanSessionState(n: CanvasNodeState): KanbanSession | null {
  if (n.kind === 'browser') {
    return {
      id: n.id,
      title: n.title || 'Browser',
      color: n.color ?? NODE_COLORS[0],
      kind: 'browser',
      url: n.url,
      partition: n.partition,
      spawn: {}
    }
  }
  if (n.kind === 'sticky') {
    const txt = n.text ?? ''
    return {
      id: n.id,
      title: txt.trim().split('\n')[0].replace(/^#{1,6}\s+/, '').trim().slice(0, 80) || 'Note',
      color: n.color ?? NODE_COLORS[2],
      kind: 'sticky',
      text: txt,
      textUpdatedAt: n.textUpdatedAt,
      textUpdatedBy: n.textUpdatedBy,
      spawn: {}
    }
  }
  if (n.kind !== 'terminal') return null
  const raw = n as unknown as Record<string, unknown>
  const initialCommand = (raw.initialCommand as string | undefined) ?? (raw.pendingLaunch as { command?: string } | undefined)?.command
  return {
    id: n.id,
    title: n.title ?? '',
    color: n.color ?? NODE_COLORS[0],
    kind: 'terminal',
    agentId: n.agentId as string | undefined,
    spawn: {
      shell: n.shell,
      cwd: n.cwd,
      agentId: n.agentId as string | undefined,
      accountId: n.accountId as string | undefined,
      ssh: n.ssh,
      sshRemoteTmux: !!n.sshRemoteTmux,
      ...(initialCommand ? { initialCommand } : {})
    } as never
  }
}
