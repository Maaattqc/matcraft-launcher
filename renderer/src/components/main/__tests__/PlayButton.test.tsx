import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PlayButton } from '../PlayButton'
import type { LaunchPhase } from '@/hooks/useLaunchState'

const phases: { phase: LaunchPhase; label: string; disabled: boolean }[] = [
  { phase: 'idle', label: 'Lancer', disabled: false },
  { phase: 'launching', label: 'Lancement...', disabled: true },
  { phase: 'downloading', label: 'Téléchargement...', disabled: true },
  { phase: 'extracting', label: 'Extraction...', disabled: true },
  { phase: 'patching', label: 'Patch...', disabled: true },
  { phase: 'loading_mods', label: 'Chargement des mods...', disabled: true },
  { phase: 'running', label: 'En jeu', disabled: true },
  { phase: 'error', label: 'Réessayer', disabled: false },
]

describe('PlayButton', () => {
  it.each(phases)('renders correct label for phase=$phase', ({ phase, label }) => {
    render(<PlayButton phase={phase} onClick={() => {}} />)
    expect(screen.getByRole('button')).toHaveTextContent(label)
  })

  it.each(phases.filter(p => p.disabled))(
    'is disabled for phase=$phase',
    ({ phase }) => {
      render(<PlayButton phase={phase} onClick={() => {}} />)
      expect(screen.getByRole('button')).toBeDisabled()
    }
  )

  it.each(phases.filter(p => !p.disabled))(
    'is enabled for phase=$phase',
    ({ phase }) => {
      render(<PlayButton phase={phase} onClick={() => {}} />)
      expect(screen.getByRole('button')).toBeEnabled()
    }
  )

  it('calls onClick when enabled', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<PlayButton phase="idle" onClick={onClick} />)
    await user.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('does not call onClick when disabled', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<PlayButton phase="launching" onClick={onClick} />)
    await user.click(screen.getByRole('button'))
    expect(onClick).not.toHaveBeenCalled()
  })
})
