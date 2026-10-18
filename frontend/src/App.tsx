import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useLocalRuntime,
  useRemoteThreadListRuntime,
  type ReasoningMessagePartComponent,
  type TextMessagePartComponent,
} from '@assistant-ui/react'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  History,
  Lightbulb,
  PanelLeft,
  Plus,
  RefreshCw,
  Settings,
  SquarePen,
  Trash2,
  UserRound,
} from 'lucide-react'
import { api, fmt, type Role, type SavedRun, type Status } from './api'
import {
  logsenseChatModel,
  QUERIES_HEADING,
  queueReplay,
  setActiveRole,
  setOnSaved,
  type AnswerMeta,
} from './chat-api'
import { Insights } from './Insights'
import { Setup } from './Setup'
import { ToolCallCard } from './components/ToolCallCard'
import { createThreadListAdapter } from './thread-list-adapter'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import './App.css'

const APP_NAME = 'Serene Overfitters'
const MOBILE_QUERY = '(max-width: 768px)'

const threadListAdapter = createThreadListAdapter()

const MarkdownText: TextMessagePartComponent = ({ text }) => {
  const markdown = <MarkdownTextPrimitive className="markdown" remarkPlugins={[remarkGfm]} />
  if (!QUERIES_HEADING.test(text.trimStart().split('\n', 1)[0])) return markdown
  return (
    <details className="answer-queries">
      <summary>Queries behind these numbers (SQL)</summary>
      {markdown}
    </details>
  )
}

// What Claude said between tool calls: kept, but out of the way of the answer.
const NoteBlock: ReasoningMessagePartComponent = ({ text }) => (
  <p className="note-block">{text.length > 280 ? `${text.slice(0, 280)}…` : text}</p>
)

const AnswerFooter = () => {
  const meta = useAuiState((state) => state.message.metadata?.custom as AnswerMeta | undefined)
  if (!meta || meta.toolCalls === undefined) return null
  const parts = [`${meta.toolCalls} tool call${meta.toolCalls === 1 ? '' : 's'}`]
  if (meta.durationMs) parts.push(`${(meta.durationMs / 1000).toFixed(0)} s`)
  if (meta.costUsd != null) parts.push(`$${meta.costUsd.toFixed(2)}`)
  if (meta.replayOf) parts.push(`saved answer from ${meta.replayOf}`)
  if (meta.savedPath) parts.push(`saved to ${meta.savedPath}`)
  return <p className="answer-meta">{parts.join(' · ')}</p>
}

const CopyButton = () => (
  <ActionBarPrimitive.Copy className="action-button" aria-label="Copy">
    <Copy className="action-icon-idle" />
    <Check className="action-icon-done" />
  </ActionBarPrimitive.Copy>
)

const ThinkingIndicator = () => {
  const isWaiting = useAuiState(
    (state) => state.message.status?.type === 'running' && state.message.parts.length === 0,
  )

  if (!isWaiting) return null

  return (
    <div className="thinking-indicator" role="status" aria-live="polite">
      <span className="thinking-pulse" aria-hidden="true" />
      Thinking
    </div>
  )
}

const UserMessage = () => (
  <MessagePrimitive.Root className="message message-user">
    <div className="message-user-bubble">
      <MessagePrimitive.Parts />
    </div>
    <ActionBarPrimitive.Root
      className="action-bar action-bar-user"
      hideWhenRunning
      autohide="never"
    >
      <CopyButton />
    </ActionBarPrimitive.Root>
  </MessagePrimitive.Root>
)

const AssistantMessage = () => (
  <MessagePrimitive.Root className="message message-assistant">
    <div className="message-assistant-body">
      <ThinkingIndicator />
      <MessagePrimitive.Parts
        components={{ Text: MarkdownText, Reasoning: NoteBlock, tools: { Fallback: ToolCallCard } }}
      />
      <AnswerFooter />
      <MessagePrimitive.Error>
        <ErrorPrimitive.Root className="message-error">
          <ErrorPrimitive.Message />
        </ErrorPrimitive.Root>
      </MessagePrimitive.Error>
    </div>
    <ActionBarPrimitive.Root
      className="action-bar"
      hideWhenRunning
      autohide="never"
    >
      <CopyButton />
      <ActionBarPrimitive.Reload className="action-button" aria-label="Regenerate">
        <RefreshCw />
      </ActionBarPrimitive.Reload>
    </ActionBarPrimitive.Root>
  </MessagePrimitive.Root>
)

const DeleteThreadDialog = () => {
  const aui = useAui()

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="thread-list-delete"
            aria-label="Delete chat"
          >
            <Trash2 />
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
          <AlertDialogDescription>
            This chat will be removed from your history. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => void aui.threadListItem.delete()}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

const ThreadListItem = () => (
  <ThreadListItemPrimitive.Root className="thread-list-item">
    <ThreadListItemPrimitive.Trigger className="thread-list-trigger">
      <ThreadListItemPrimitive.Title fallback="New chat" />
    </ThreadListItemPrimitive.Trigger>
    <DeleteThreadDialog />
  </ThreadListItemPrimitive.Root>
)

type View = 'chat' | 'insights' | 'setup'

type SidebarProps = {
  isOpen: boolean
  view: View
  savedRuns: SavedRun[]
  roles: Role[]
  onToggle: () => void
  onSelectView: (view: View) => void
  onOpenRun: (run: SavedRun) => void
}

const savedDate = (mtime: number) =>
  new Date(mtime * 1000).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

type SavedAnswersProps ={ runs: SavedRun[]; roles: Role[]; onOpen: (run: SavedRun) => void }

// Saved answers grouped by the role that produced them, each group collapsed until opened.
const SavedAnswers = ({ runs, roles, onOpen }: SavedAnswersProps) => {
  if (!runs.length) return null
  const groups = runs.reduce<Record<string, SavedRun[]>>((acc, run) => {
    ;(acc[run.role ?? 'other'] ??= []).push(run)
    return acc
  }, {})
  // Roles in the backend's order, then anything saved under a role that no longer exists.
  const order = [...roles.map((r) => r.id), ...Object.keys(groups).filter((id) => !roles.some((r) => r.id === id))]
  const label = (id: string) => {
    const role = roles.find((r) => r.id === id)
    return role ? roleName(role) : (groups[id][0]?.title.split(':')[0] ?? 'Other')
  }

  return (
    <div className="saved-answers">
      <p className="sidebar-section-label">History</p>
      {order
        .filter((id) => groups[id])
        .map((id) => (
          <details key={id} className="saved-group">
            <summary>
              <ChevronRight className="saved-group-chevron" />
              <span>{label(id)}</span>
              <span className="saved-group-count">{groups[id].length}</span>
            </summary>
            {groups[id].map((run) => (
              <button
                key={run.id}
                type="button"
                className="saved-answer"
                title={`${run.question}\n(${run.source})`}
                onClick={() => onOpen(run)}
              >
                <History />
                <span className="saved-answer-text">
                  <span>{run.question || run.title}</span>
                  <span className="saved-answer-date">{savedDate(run.mtime)}</span>
                </span>
              </button>
            ))}
          </details>
        ))}
    </div>
  )
}

const Sidebar = ({ isOpen, view, savedRuns, roles, onToggle, onSelectView, onOpenRun }: SidebarProps) => (
  <aside
    className={cn(
      'sidebar',
      !isOpen && 'sidebar-collapsed',
      view !== 'chat' && 'sidebar-other-view',
    )}
  >
    <div className="sidebar-top">
      <div className="sidebar-brand">
        <span className="brand-mark" aria-hidden="true">
          SO
        </span>
        <span className="sidebar-label brand-name">{APP_NAME}</span>
      </div>
      <button
        type="button"
        className="icon-button"
        onClick={onToggle}
        aria-label={isOpen ? 'Close sidebar' : 'Open sidebar'}
        title={isOpen ? 'Close sidebar' : 'Open sidebar'}
      >
        <PanelLeft />
      </button>
    </div>
    <ThreadListPrimitive.Root className="sidebar-content">
      <ThreadListPrimitive.New
        className="new-chat-button"
        aria-label="New chat"
        title="New chat"
        onClick={() => onSelectView('chat')}
      >
        <SquarePen />
        <span className="sidebar-label">New chat</span>
      </ThreadListPrimitive.New>
      <button
        type="button"
        className={cn('new-chat-button', view === 'insights' && 'sidebar-nav-active')}
        aria-label="Insights"
        aria-current={view === 'insights' ? 'page' : undefined}
        title="Insights"
        onClick={() => onSelectView('insights')}
      >
        <Lightbulb />
        <span className="sidebar-label">Insights</span>
      </button>
      <div
        className="thread-list-items"
        onClick={(event) => {
          // Only opening a chat counts; clicks from the delete dialog bubble here too.
          if ((event.target as Element).closest('.thread-list-trigger')) onSelectView('chat')
        }}
      >
        <p className="sidebar-section-label">Recents</p>
        <ThreadListPrimitive.Items components={{ ThreadListItem }} />
        <SavedAnswers runs={savedRuns} roles={roles} onOpen={onOpenRun} />
      </div>
    </ThreadListPrimitive.Root>
    <div className="sidebar-footer">
      <button
        type="button"
        className={cn('new-chat-button', view === 'setup' && 'sidebar-nav-active')}
        aria-label="Setup"
        aria-current={view === 'setup' ? 'page' : undefined}
        title="Setup"
        onClick={() => onSelectView('setup')}
      >
        <Settings />
        <span className="sidebar-label">Setup</span>
      </button>
    </div>
  </aside>
)

type RoleMenuProps = {
  roles: Role[]
  role: Role | null
  onSelect: (role: Role) => void
}

const roleName = (role: Role) => role.title.split(':')[0]

const RoleMenu = ({ roles, role, onSelect }: RoleMenuProps) => {
  const [isOpen, setIsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setIsOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen])

  return (
    <div className="role-menu" ref={menuRef}>
      <button
        type="button"
        className="composer-tool"
        aria-label="Choose role"
        title="Choose role"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        <Plus />
      </button>
      {isOpen && (
        <div className="role-menu-popover">
          <p className="role-menu-heading">Answer as</p>
          <ul className="role-menu-list" role="menu">
            {roles.map((option) => (
              <li key={option.id} role="none">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.id === role?.id}
                  className="role-menu-item"
                  onClick={() => {
                    onSelect(option)
                    setIsOpen(false)
                  }}
                >
                  <UserRound />
                  <span className="role-menu-text">
                    <span>{roleName(option)}</span>
                    <span className="role-menu-level">{option.level}</span>
                  </span>
                  {option.id === role?.id && <Check className="role-menu-check" />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

type ComposerProps = {
  roles: Role[]
  role: Role | null
  onSelectRole: (role: Role) => void
}

const Composer = ({ roles, role, onSelectRole }: ComposerProps) => (
  <ComposerPrimitive.Root className="composer">
    <ComposerPrimitive.Input
      className="composer-input"
      placeholder={role ? `Ask AI Agent as ${roleName(role)}` : 'Ask AI Agent'}
      rows={1}
      autoFocus
    />
    <div className="composer-toolbar">
      <RoleMenu roles={roles} role={role} onSelect={onSelectRole} />
      {role && (
        <span className="role-chip" title={role.title}>
          <UserRound />
          {roleName(role)}
        </span>
      )}
      <div className="composer-actions">
        <ThreadPrimitive.If running={false}>
          <ComposerPrimitive.Send className="composer-send" aria-label="Send message">
            <ArrowUp />
          </ComposerPrimitive.Send>
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running>
          <ComposerPrimitive.Cancel className="composer-send" aria-label="Stop generating">
            <span className="stop-square" aria-hidden="true" />
          </ComposerPrimitive.Cancel>
        </ThreadPrimitive.If>
      </div>
    </div>
  </ComposerPrimitive.Root>
)

const ChatThread = (composerProps: ComposerProps) => (
  <ThreadPrimitive.Root className="chat-thread">
    <ThreadPrimitive.Viewport className="thread-viewport">
      <ThreadPrimitive.Empty>
        <div className="empty-state">
          <h1 className="empty-title">Millions of log lines. One question away.</h1>
          <Composer {...composerProps} />
          {composerProps.role && (
            <ThreadPrimitive.Suggestion className="suggestion" prompt={composerProps.role.question} send>
              <span className="suggestion-label">Suggested for {roleName(composerProps.role)}</span>
              {composerProps.role.question}
            </ThreadPrimitive.Suggestion>
          )}
        </div>
      </ThreadPrimitive.Empty>
      <div className="thread-messages">
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
      </div>
    </ThreadPrimitive.Viewport>
    <ThreadPrimitive.If empty={false}>
      <div className="thread-footer">
        <ThreadPrimitive.ScrollToBottom className="scroll-to-bottom" aria-label="Scroll to bottom">
          <ArrowDown />
        </ThreadPrimitive.ScrollToBottom>
        <ThreadPrimitive.If running>
          <div className="chat-done">
            <ComposerPrimitive.Cancel className="chat-done-button">
              <span className="stop-square" aria-hidden="true" />
              Stop
            </ComposerPrimitive.Cancel>
          </div>
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running={false}>
          <div className="chat-done">
            <span className="muted small">
              One question per chat. Every number above comes from a SereneDB query in the tool calls.
            </span>
            <ThreadListPrimitive.New className="chat-done-button">
              <SquarePen />
              Ask another question
            </ThreadListPrimitive.New>
          </div>
        </ThreadPrimitive.If>
      </div>
    </ThreadPrimitive.If>
  </ThreadPrimitive.Root>
)

const StatusPills = ({ status }: { status: Status | null }) => {
  if (!status) return null
  const db = status.db
  const t = db.tables ?? {}
  const loaded = db.ok && !!t.openstack_logs && !!t.bgl_logs
  return (
    <div className="status-pills" aria-live="polite">
      <span className="status-pill" title={db.ok ? db.version : db.error}>
        <span className={cn('dot', db.ok ? 'dot-ok' : 'dot-bad')} />
        SereneDB {db.ok ? 'connected' : 'offline'}
      </span>
      <span className="status-pill">
        <span className={cn('dot', loaded ? 'dot-ok' : 'dot-warn')} />
        {loaded ? `${fmt(t.openstack_logs)} OpenStack · ${fmt(t.bgl_logs)} BGL lines` : 'data not loaded'}
      </span>
      <span className="status-pill" title={status.claude ?? undefined}>
        <span className={cn('dot', status.claude ? 'dot-ok' : 'dot-bad')} />
        Claude Code {status.claude ? 'found' : 'not found'}
      </span>
    </div>
  )
}

const useLogsenseChatRuntime = () => useLocalRuntime(logsenseChatModel)

function App() {
  const runtime = useRemoteThreadListRuntime({
    adapter: threadListAdapter,
    runtimeHook: useLogsenseChatRuntime,
  })
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches)
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => !window.matchMedia(MOBILE_QUERY).matches)
  const [roles, setRoles] = useState<Role[]>([])
  const [role, setRole] = useState<Role | null>(null)
  const [view, setView] = useState<View>('chat')
  const [savedRuns, setSavedRuns] = useState<SavedRun[]>([])
  const [status, setStatus] = useState<Status | null>(null)

  const loadStatus = useCallback(() => {
    api<Status>('/api/status')
      .then(setStatus)
      .catch((err: Error) =>
        setStatus({ db: { ok: false, error: err.message }, claude: null, mcp_config: false, csv: {} }),
      )
  }, [])

  const loadSaved = useCallback(() => {
    api<SavedRun[]>('/api/runs')
      .then(setSavedRuns)
      .catch(() => setSavedRuns([]))
  }, [])

  useEffect(() => {
    api<Role[]>('/api/roles')
      .then((list) => {
        setRoles(list)
        setRole(list[0] ?? null)
        setActiveRole(list[0]?.id ?? null)
      })
      .catch(() => setRoles([]))
    loadStatus()
    loadSaved()
    setOnSaved(loadSaved)
    return () => setOnSaved(null)
  }, [loadSaved, loadStatus])

  // The sidebar starts open on desktop and closed on mobile, and resets when crossing the breakpoint.
  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY)
    const handleChange = () => {
      setIsMobile(query.matches)
      setIsSidebarOpen(!query.matches)
    }
    query.addEventListener('change', handleChange)
    return () => query.removeEventListener('change', handleChange)
  }, [])

  const toggleSidebar = () => setIsSidebarOpen((open) => !open)

  // On small screens the sidebar is an overlay, so close it after navigating.
  const selectView = (next: View) => {
    setView(next)
    if (isMobile) setIsSidebarOpen(false)
  }

  const selectRole = (next: Role) => {
    setRole(next)
    setActiveRole(next.id)
  }

  // Re-stream a saved answer in a fresh chat: same tool cards and answer as a live run, instantly.
  const openRun = async (run: SavedRun) => {
    if (runtime.thread.getState().isRunning) return
    selectView('chat')
    const runRole = roles.find((r) => r.id === run.role)
    if (runRole) selectRole(runRole)
    await runtime.threads.switchToNewThread()
    queueReplay(run.id)
    runtime.thread.append(run.question || run.title)
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="app-shell">
        <Sidebar
          isOpen={isSidebarOpen}
          view={view}
          savedRuns={savedRuns}
          roles={roles}
          onToggle={toggleSidebar}
          onSelectView={selectView}
          onOpenRun={(run) => void openRun(run)}
        />
        {isMobile && isSidebarOpen && (
          <div className="sidebar-backdrop" onClick={toggleSidebar} aria-hidden="true" />
        )}
        <main className="chat-main">
          <header className="chat-header">
            <button
              type="button"
              className="icon-button chat-header-toggle"
              onClick={toggleSidebar}
              aria-label="Open sidebar"
            >
              <PanelLeft />
            </button>
            <span className="chat-header-title">
              {view === 'insights' ? 'Insights' : view === 'setup' ? 'Setup' : APP_NAME}
            </span>
            <StatusPills status={status} />
          </header>
          {view === 'chat' && <ChatThread roles={roles} role={role} onSelectRole={selectRole} />}
          {view === 'insights' && <Insights />}
          {view === 'setup' && <Setup status={status} onRecheck={loadStatus} />}
        </main>
      </div>
    </AssistantRuntimeProvider>
  )
}

export default App
