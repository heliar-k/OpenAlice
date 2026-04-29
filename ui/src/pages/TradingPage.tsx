import { useState, useEffect, useCallback, useMemo } from 'react'
import { Section, Field, inputClass } from '../components/form'
import { Toggle } from '../components/Toggle'
import { GuardsSection, CRYPTO_GUARD_TYPES, SECURITIES_GUARD_TYPES } from '../components/guards'
import { SDKSelector } from '../components/SDKSelector'
import type { SDKOption } from '../components/SDKSelector'
import { ReconnectButton } from '../components/ReconnectButton'
import { useTradingConfig } from '../hooks/useTradingConfig'
import { useAccountHealth } from '../hooks/useAccountHealth'
import { useSchemaForm, type SchemaField } from '../hooks/useSchemaForm'
import { PageHeader } from '../components/PageHeader'
import { api } from '../api'
import type { AccountConfig, BrokerPreset, BrokerHealthInfo, SubtitleField } from '../api/types'

// ==================== Dialog state ====================

type DialogState =
  | { kind: 'edit'; accountId: string }
  | { kind: 'add' }
  | null

// ==================== Page ====================

export function TradingPage() {
  const tc = useTradingConfig()
  const healthMap = useAccountHealth()
  const [dialog, setDialog] = useState<DialogState>(null)
  const [presets, setPresets] = useState<BrokerPreset[]>([])

  // Fetch broker preset metadata on mount
  useEffect(() => {
    api.trading.getBrokerPresets().then(r => setPresets(r.presets)).catch(() => {})
  }, [])

  useEffect(() => {
    if (dialog?.kind === 'edit') {
      if (!tc.accounts.some((a) => a.id === dialog.accountId)) setDialog(null)
    }
  }, [tc.accounts, dialog])

  if (tc.loading) return <PageShell subtitle="Loading..." />
  if (tc.error) {
    return (
      <PageShell subtitle="Failed to load trading configuration.">
        <p className="text-[13px] text-red">{tc.error}</p>
        <button onClick={tc.refresh} className="mt-2 btn-secondary">Retry</button>
      </PageShell>
    )
  }

  const deleteAccount = async (accountId: string) => {
    await tc.deleteAccount(accountId)
    setDialog(null)
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader title="Trading" description="Configure your trading accounts." />

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5">
        <div className="max-w-[720px] space-y-3">
          {tc.accounts.length === 0 ? (
            <EmptyState onAdd={() => setDialog({ kind: 'add' })} />
          ) : (
            <>
              {tc.accounts.map((account) => (
                <AccountCard
                  key={account.id}
                  account={account}
                  preset={presets.find(p => p.id === account.presetId)}
                  health={healthMap[account.id]}
                  onClick={() => setDialog({ kind: 'edit', accountId: account.id })}
                />
              ))}
              <button
                onClick={() => setDialog({ kind: 'add' })}
                className="w-full py-2.5 text-[12px] text-text-muted hover:text-text border border-dashed border-border hover:border-text-muted/40 rounded-lg transition-colors"
              >
                + Add Account
              </button>
            </>
          )}
        </div>
      </div>

      {/* Create Wizard */}
      {dialog?.kind === 'add' && (
        <CreateWizard
          presets={presets}
          existingAccountIds={tc.accounts.map((a) => a.id)}
          onSave={async (account) => {
            await tc.saveAccount(account)
            const result = await tc.reconnectAccount(account.id)
            if (!result.success) {
              throw new Error(result.error || 'Connection failed')
            }
            setDialog(null)
          }}
          onClose={() => setDialog(null)}
        />
      )}

      {/* Edit Dialog */}
      {dialog?.kind === 'edit' && (() => {
        const account = tc.accounts.find((a) => a.id === dialog.accountId)
        if (!account) return null
        return (
          <EditDialog
            account={account}
            preset={presets.find(p => p.id === account.presetId)}
            health={healthMap[account.id]}
            onSaveAccount={tc.saveAccount}
            onDelete={() => deleteAccount(account.id)}
            onClose={() => setDialog(null)}
          />
        )
      })()}
    </div>
  )
}

// ==================== Page Shell ====================

function PageShell({ subtitle, children }: { subtitle: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader title="Trading" description={subtitle} />
      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5">{children}</div>
    </div>
  )
}

// ==================== Empty State ====================

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-border p-12 text-center">
      <h3 className="text-[16px] font-semibold text-text mb-2">No trading accounts</h3>
      <p className="text-[13px] text-text-muted mb-6 max-w-[320px] mx-auto leading-relaxed">
        Connect a crypto exchange or brokerage account to start automated trading.
      </p>
      <button onClick={onAdd} className="btn-primary">
        + Add Account
      </button>
    </div>
  )
}

// ==================== Dialog ====================

function Dialog({ onClose, width, children }: {
  onClose: () => void
  width?: string
  children: React.ReactNode
}) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className={`relative ${width || 'w-[560px]'} max-w-[95vw] max-h-[85vh] bg-bg rounded-xl border border-border shadow-2xl flex flex-col overflow-hidden`}>
        {children}
      </div>
    </div>
  )
}

// ==================== Health Badge ====================

function HealthBadge({ health, size = 'sm' }: { health?: BrokerHealthInfo; size?: 'sm' | 'md' }) {
  const textSize = size === 'md' ? 'text-[12px]' : 'text-[11px]'
  const dotSize = size === 'md' ? 'w-2 h-2' : 'w-1.5 h-1.5'

  if (!health) return <span className="text-text-muted/40">—</span>

  if (health.disabled) {
    return (
      <span className={`inline-flex items-center gap-1.5 ${textSize} text-text-muted`} title={health.lastError}>
        <span className={`${dotSize} rounded-full bg-text-muted/40 shrink-0`} />
        Disabled
      </span>
    )
  }

  switch (health.status) {
    case 'healthy':
      return (
        <span className={`inline-flex items-center gap-1.5 ${textSize} text-green`}>
          <span className={`${dotSize} rounded-full bg-green shrink-0`} />
          Connected
        </span>
      )
    case 'degraded':
      return (
        <span className={`inline-flex items-center gap-1.5 ${textSize} text-yellow-400`}>
          <span className={`${dotSize} rounded-full bg-yellow-400 shrink-0`} />
          Unstable
        </span>
      )
    case 'offline':
      return (
        <span className={`inline-flex items-center gap-1.5 ${textSize} text-red`} title={health.lastError}>
          <span className={`${dotSize} rounded-full bg-red shrink-0 animate-pulse`} />
          {health.recovering ? 'Reconnecting...' : 'Offline'}
        </span>
      )
  }
}

// ==================== Subtitle builder ====================

function buildSubtitle(account: AccountConfig, preset?: BrokerPreset): string {
  if (!preset) return account.presetId
  const pc = account.presetConfig
  const parts: string[] = []
  for (const sf of preset.subtitleFields) {
    const val = pc[sf.field]
    if (typeof val === 'boolean') {
      if (val && sf.label) parts.push(sf.label)
      else if (!val && sf.falseLabel) parts.push(sf.falseLabel)
    } else if (val != null && val !== '') {
      // For mode field, prefer the human-readable label from preset.modes
      let display = String(val)
      if (sf.field === 'mode' && preset.modes) {
        const mode = preset.modes.find(m => m.id === val)
        if (mode) display = mode.label
      }
      parts.push(`${sf.prefix ?? ''}${display}`)
    }
  }
  return parts.join(' · ') || preset.label
}

// ==================== Account Card ====================

function AccountCard({ account, preset, health, onClick }: {
  account: AccountConfig
  preset?: BrokerPreset
  health?: BrokerHealthInfo
  onClick: () => void
}) {
  const isDisabled = health?.disabled || account.enabled === false
  const badge = preset
    ? { text: preset.badge, color: `${preset.badgeColor} ${preset.badgeColor.replace('text-', 'bg-')}/10` }
    : { text: account.presetId.slice(0, 2).toUpperCase(), color: 'text-text-muted bg-text-muted/10' }

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-lg border border-border px-4 py-3.5 transition-all hover:border-text-muted/40 hover:bg-bg-tertiary/20 ${isDisabled ? 'opacity-50' : ''}`}
    >
      <div className="flex items-center gap-3">
        <span className={`text-[10px] font-bold px-2 py-1 rounded-md shrink-0 ${badge.color}`}>
          {badge.text}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-text truncate">{account.id}</div>
          <div className="text-[11px] text-text-muted truncate mt-0.5">
            {buildSubtitle(account, preset)}
            {account.guards.length > 0 && <span className="ml-2 text-text-muted/50">{account.guards.length} guard{account.guards.length > 1 ? 's' : ''}</span>}
          </div>
        </div>
        <div className="shrink-0">
          {account.enabled === false
            ? <span className="text-[11px] text-text-muted">Disabled</span>
            : <HealthBadge health={health} />
          }
        </div>
      </div>
    </button>
  )
}

// ==================== Schema-driven form fields ====================

function SchemaFormFields({ fields, formData, setField, showSecrets }: {
  fields: SchemaField[]
  formData: Record<string, string>
  setField: (key: string, value: string) => void
  showSecrets: boolean
}) {
  return (
    <div className="space-y-3">
      {fields.map(f => {
        const value = formData[f.key] ?? f.defaultValue ?? ''
        switch (f.type) {
          case 'select':
            return (
              <Field key={f.key} label={f.title}>
                <select className={inputClass} value={value} onChange={(e) => setField(f.key, e.target.value)}>
                  {f.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                {f.description && <p className="text-[11px] text-text-muted/60 mt-1">{f.description}</p>}
              </Field>
            )
          case 'password':
            return (
              <Field key={f.key} label={f.title}>
                <input
                  className={inputClass}
                  type={showSecrets ? 'text' : 'password'}
                  value={value}
                  onChange={(e) => setField(f.key, e.target.value)}
                  placeholder={f.required ? 'Required' : ''}
                />
                {f.description && <p className="text-[11px] text-text-muted/60 mt-1">{f.description}</p>}
              </Field>
            )
          case 'text':
          default:
            return (
              <Field key={f.key} label={f.title}>
                <input
                  className={inputClass}
                  type="text"
                  value={value}
                  onChange={(e) => setField(f.key, e.target.value)}
                  placeholder={f.required ? 'Required' : ''}
                />
                {f.description && <p className="text-[11px] text-text-muted/60 mt-1">{f.description}</p>}
              </Field>
            )
        }
      })}
    </div>
  )
}

// ==================== Hint renderer (markdown-lite) ====================

function HintBlock({ text }: { text: string }) {
  // Very simple **bold** + paragraph rendering. Splits paragraphs on \n\n.
  return (
    <div className="rounded-md border border-border bg-bg-secondary/50 px-3 py-2.5 space-y-2">
      {text.trim().split('\n\n').map((para, i) => (
        <p key={i} className="text-[12px] text-text-muted leading-relaxed">
          {para.split(/(\*\*[^*]+\*\*)/).map((seg, j) =>
            seg.startsWith('**') && seg.endsWith('**')
              ? <strong key={j} className="text-text">{seg.slice(2, -2)}</strong>
              : <span key={j}>{seg}</span>
          )}
        </p>
      ))}
    </div>
  )
}

// ==================== Create Wizard ====================

function CreateWizard({ presets, existingAccountIds, onSave, onClose }: {
  presets: BrokerPreset[]
  existingAccountIds: string[]
  onSave: (account: AccountConfig) => Promise<void>
  onClose: () => void
}) {
  const [presetId, setPresetId] = useState<string | null>(null)
  const [id, setId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [showSecrets, setShowSecrets] = useState(false)

  const preset = presets.find(p => p.id === presetId)
  const hasSensitive = preset?.schema && Object.values((preset.schema as { properties?: Record<string, { writeOnly?: boolean }> }).properties ?? {}).some(p => p.writeOnly)

  const { fields, formData, setField, getSubmitData, validate } = useSchemaForm(preset?.schema)

  const defaultId = preset?.defaultName ?? ''
  const finalId = id.trim() || defaultId

  const platformOptions: SDKOption[] = useMemo(() => presets.map(p => ({
    id: p.id,
    name: p.label,
    description: p.description,
    badge: p.badge,
    badgeColor: p.badgeColor,
  })), [presets])

  const handleCreate = async () => {
    if (!preset) return
    if (existingAccountIds.includes(finalId)) {
      setError(`Account "${finalId}" already exists`)
      return
    }
    const validationError = validate()
    if (validationError) {
      setError(validationError)
      return
    }
    setSaving(true); setError('')
    try {
      const account: AccountConfig = {
        id: finalId,
        presetId: preset.id,
        enabled: true,
        guards: [],
        presetConfig: getSubmitData(),
      }

      const testResult = await api.trading.testConnection(account)
      if (!testResult.success) {
        setError(testResult.error || 'Connection failed')
        setSaving(false)
        return
      }

      await onSave(account)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create account')
      setSaving(false)
    }
  }

  return (
    <Dialog onClose={onClose}>
      {/* Header */}
      <div className="shrink-0 px-6 py-4 border-b border-border flex items-center justify-between">
        <h3 className="text-[14px] font-semibold text-text">New Account</h3>
        <button onClick={onClose} className="text-text-muted hover:text-text p-1 transition-colors">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="space-y-5">
          <div>
            <p className="text-[12px] font-medium text-text-muted uppercase tracking-wide mb-3">Platform</p>
            <SDKSelector options={platformOptions} selected={presetId ?? ''} onSelect={(p) => setPresetId(p)} />
          </div>

          {preset && (
            <>
              {preset.hint && <HintBlock text={preset.hint} />}

              <div className="space-y-3 pt-2 border-t border-border">
                <p className="text-[12px] font-medium text-text-muted uppercase tracking-wide mb-1">Configuration</p>
                <Field label="Account ID">
                  <input className={inputClass} value={id} onChange={(e) => setId(e.target.value.trim())} placeholder={defaultId} />
                </Field>
                <SchemaFormFields
                  fields={fields}
                  formData={formData}
                  setField={setField}
                  showSecrets={showSecrets}
                />
                {hasSensitive && (
                  <button
                    onClick={() => setShowSecrets(!showSecrets)}
                    className="text-[11px] text-text-muted hover:text-text transition-colors"
                  >
                    {showSecrets ? 'Hide secrets' : 'Show secrets'}
                  </button>
                )}
              </div>
            </>
          )}

          {error && <p className="text-[12px] text-red">{error}</p>}
        </div>
      </div>

      {/* Footer */}
      <div className="shrink-0 flex items-center justify-between px-6 py-4 border-t border-border">
        <button onClick={onClose} className="btn-secondary">Cancel</button>
        <button onClick={handleCreate} disabled={saving || !preset} className="btn-primary">
          {saving ? 'Connecting...' : 'Create Account'}
        </button>
      </div>
    </Dialog>
  )
}

// ==================== Edit Dialog ====================

function EditDialog({ account, preset, health, onSaveAccount, onDelete, onClose }: {
  account: AccountConfig
  preset?: BrokerPreset
  health?: BrokerHealthInfo
  onSaveAccount: (a: AccountConfig) => Promise<void>
  onDelete: () => Promise<void>
  onClose: () => void
}) {
  const [draft, setDraft] = useState(account)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [guardsOpen, setGuardsOpen] = useState(false)
  const [showKeys, setShowKeys] = useState(false)

  // Schema-driven form pre-populated from account.presetConfig.
  const initialValues = useMemo(() => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(account.presetConfig)) {
      if (v != null) out[k] = String(v)
    }
    return out
  }, [account])
  const { fields, formData, setField, getSubmitData } = useSchemaForm(preset?.schema, initialValues)
  const hasSensitive = fields.some(f => f.type === 'password')

  // Sync draft.presetConfig from form state on every form change
  useEffect(() => {
    const submitData = getSubmitData()
    setDraft(d => ({ ...d, presetConfig: submitData }))
  }, [formData, getSubmitData])

  useEffect(() => { setDraft(account) }, [account])

  const dirty = JSON.stringify(draft) !== JSON.stringify(account)

  const patchGuards = (guards: AccountConfig['guards']) => {
    setDraft(d => ({ ...d, guards }))
  }

  const handleSave = async () => {
    setSaving(true); setMsg('')
    try {
      await onSaveAccount(draft)
      setMsg('Saved')
      setTimeout(() => setMsg(''), 2000)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const guardTypes = (preset?.guardCategory === 'crypto') ? CRYPTO_GUARD_TYPES : SECURITIES_GUARD_TYPES

  return (
    <Dialog onClose={onClose} width="w-[560px]">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-3 min-w-0">
          <h3 className="text-[14px] font-semibold text-text truncate">{account.id}</h3>
          <HealthBadge health={health} size="md" />
        </div>
        <button onClick={onClose} className="text-text-muted hover:text-text p-1 transition-colors shrink-0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-5">
        <Section title="Configuration">
          <div className="mb-3">
            <span className="text-[12px] text-text-muted">Type</span>
            <span className="ml-2 text-[12px] font-medium text-text">{preset?.label ?? account.presetId}</span>
          </div>
          <SchemaFormFields
            fields={fields}
            formData={formData}
            setField={setField}
            showSecrets={showKeys}
          />
          {hasSensitive && (
            <button
              onClick={() => setShowKeys(!showKeys)}
              className="text-[11px] text-text-muted hover:text-text transition-colors mt-2"
            >
              {showKeys ? 'Hide secrets' : 'Show secrets'}
            </button>
          )}
        </Section>

        {/* Guards */}
        <div>
          <button
            onClick={() => setGuardsOpen(!guardsOpen)}
            className="flex items-center gap-1.5 text-[13px] font-semibold text-text-muted uppercase tracking-wide"
          >
            <svg
              width="12" height="12" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={`transition-transform duration-150 ${guardsOpen ? 'rotate-90' : ''}`}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            Guards ({draft.guards.length})
          </button>
          {guardsOpen && (
            <div className="mt-3">
              <GuardsSection
                guards={draft.guards}
                guardTypes={guardTypes}
                description="Guards validate operations before execution. Order matters."
                onChange={patchGuards}
                onChangeImmediate={patchGuards}
              />
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="shrink-0 flex items-center px-6 py-4 border-t border-border">
        <div className="flex items-center gap-3">
          {dirty && (
            <button onClick={handleSave} disabled={saving} className="btn-primary">
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
          {draft.enabled !== false && <ReconnectButton accountId={account.id} />}
          <label className="flex items-center gap-2 cursor-pointer">
            <Toggle checked={draft.enabled !== false} onChange={async (v) => {
              const updated = { ...draft, enabled: v }
              setDraft(updated)
              await onSaveAccount(updated)
            }} />
            <span className="text-[12px] text-text-muted">{draft.enabled !== false ? 'Enabled' : 'Disabled'}</span>
          </label>
          {msg && <span className="text-[12px] text-text-muted">{msg}</span>}
        </div>
        <div className="flex-1" />
        <DeleteButton label="Delete Account" onConfirm={onDelete} />
      </div>
    </Dialog>
  )
}

// ==================== Delete Button ====================

function DeleteButton({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false)

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <button onClick={() => { onConfirm(); setConfirming(false) }} className="btn-danger">
          Confirm
        </button>
        <button onClick={() => setConfirming(false)} className="btn-secondary">
          Cancel
        </button>
      </div>
    )
  }

  return (
    <button onClick={() => setConfirming(true)} className="btn-danger">
      {label}
    </button>
  )
}

// SubtitleField is referenced via preset.subtitleFields elements, kept here for type consumers.
export type { SubtitleField as _SubtitleField }
