import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LoginView } from '../LoginView'

describe('LoginView', () => {
  const onLogin = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows validation error for empty email', async () => {
    const user = userEvent.setup()
    render(<LoginView onLogin={onLogin} />)

    // Clear default values
    const inputs = screen.getAllByRole('textbox')
    const emailInput = inputs[0]
    await user.clear(emailInput)

    // Also clear password since it has a default value
    const passwordInput = screen.getByPlaceholderText('Entrez votre mot de passe')
    await user.clear(passwordInput)
    await user.type(passwordInput, 'somepassword')

    await user.click(screen.getByRole('button', { name: /connexion/i }))
    expect(screen.getByText(/veuillez entrer votre adresse e-mail/i)).toBeInTheDocument()
    expect(onLogin).not.toHaveBeenCalled()
  })

  it('shows validation error for empty password', async () => {
    const user = userEvent.setup()
    render(<LoginView onLogin={onLogin} />)

    const passwordInput = screen.getByPlaceholderText('Entrez votre mot de passe')
    await user.clear(passwordInput)

    await user.click(screen.getByRole('button', { name: /connexion/i }))
    expect(screen.getByText(/veuillez entrer votre mot de passe/i)).toBeInTheDocument()
    expect(onLogin).not.toHaveBeenCalled()
  })

  it('calls onLogin with user data on successful login', async () => {
    const user = userEvent.setup()
    const mockUser = { username: 'Player1', uuid: 'abc-123' }
    window.launcher.login = vi.fn().mockResolvedValue({ success: true, user: mockUser })

    render(<LoginView onLogin={onLogin} />)
    await user.click(screen.getByRole('button', { name: /connexion/i }))

    await vi.waitFor(() => {
      expect(onLogin).toHaveBeenCalledWith(mockUser)
    })
  })

  it('shows error message on failed login', async () => {
    const user = userEvent.setup()
    window.launcher.login = vi.fn().mockResolvedValue({
      success: false,
      error: 'Adresse e-mail ou mot de passe incorrect.',
    })

    render(<LoginView onLogin={onLogin} />)
    await user.click(screen.getByRole('button', { name: /connexion/i }))

    await vi.waitFor(() => {
      expect(screen.getByText(/incorrect/i)).toBeInTheDocument()
    })
    expect(onLogin).not.toHaveBeenCalled()
  })

  it('shows connection error on network failure', async () => {
    const user = userEvent.setup()
    window.launcher.login = vi.fn().mockRejectedValue(new Error('Network error'))

    render(<LoginView onLogin={onLogin} />)
    await user.click(screen.getByRole('button', { name: /connexion/i }))

    await vi.waitFor(() => {
      expect(screen.getByText(/impossible de contacter le serveur/i)).toBeInTheDocument()
    })
    expect(onLogin).not.toHaveBeenCalled()
  })
})
