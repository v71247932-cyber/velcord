import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../AuthContext';

type Mode = 'login' | 'ask' | 'pin';

export default function Login() {
    const [mode, setMode] = useState<Mode>('login');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [pin, setPin] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [repeat, setRepeat] = useState('');
    const [endsAt, setEndsAt] = useState(0);
    const [left, setLeft] = useState(0);
    const [error, setError] = useState('');
    const [info, setInfo] = useState('');
    const [loading, setLoading] = useState(false);
    const { login } = useAuth();
    const navigate = useNavigate();

    // countdown of the PIN (3 minutes)
    useEffect(() => {
        if (mode !== 'pin') return;
        const tick = () => setLeft(Math.max(0, Math.round((endsAt - Date.now()) / 1000)));
        tick();
        const iv = setInterval(tick, 500);
        return () => clearInterval(iv);
    }, [mode, endsAt]);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            const { token, user } = await api.login(username.trim(), password);
            login(token, user);
            navigate('/app');
        } catch (err: any) {
            setError(err.message || 'Login failed');
        } finally {
            setLoading(false);
        }
    }

    async function askPin(e: React.FormEvent) {
        e.preventDefault();
        setError('');
        setInfo('');
        setLoading(true);
        try {
            const r = await api.forgotPassword(username.trim());
            setEndsAt(Date.now() + r.expiresIn * 1000);
            setPin('');
            setMode('pin');
        } catch (err: any) {
            setError(err.message || 'Could not send the request');
        } finally {
            setLoading(false);
        }
    }

    async function changePassword(e: React.FormEvent) {
        e.preventDefault();
        setError('');
        if (newPassword !== repeat) return setError('The two passwords are not the same');
        setLoading(true);
        try {
            await api.resetPassword(username.trim(), pin, newPassword);
            setPassword('');
            setNewPassword('');
            setRepeat('');
            setPin('');
            setMode('login');
            setInfo('Password changed. Log in with the new password.');
        } catch (err: any) {
            setError(err.message || 'Could not change the password');
        } finally {
            setLoading(false);
        }
    }

    const mm = String(Math.floor(left / 60));
    const ss = String(left % 60).padStart(2, '0');

    return (
        <div className="auth-page">
            <div className="auth-card">
                <div className="auth-logo">
                    <img className="logo-img" src="/logo.svg" width="76" height="76" alt="Velcord" />
                    <h1>{mode === 'login' ? 'Welcome back!' : 'Change password'}</h1>
                    <p className="subtitle">
                        {mode === 'login' && 'Velcord is happy to see you again.'}
                        {mode === 'ask' && 'Type your username. A 4-digit PIN is sent to the person who looks after Velcord.'}
                        {mode === 'pin' && 'Ask for the PIN, then type it here with your new password.'}
                    </p>
                </div>

                {error && <div className="error-msg">⚠ {error}</div>}
                {info && mode === 'login' && <div className="info-msg">{info}</div>}

                {mode === 'login' && (
                    <form onSubmit={handleSubmit}>
                        <div className="form-group">
                            <label htmlFor="username">Username</label>
                            <input
                                id="username"
                                type="text"
                                value={username}
                                onChange={e => setUsername(e.target.value)}
                                placeholder="Enter your username"
                                autoFocus
                                autoComplete="username"
                                required
                            />
                        </div>
                        <div className="form-group">
                            <label htmlFor="password">Password</label>
                            <input
                                id="password"
                                type="password"
                                value={password}
                                onChange={e => setPassword(e.target.value)}
                                placeholder="Enter your password"
                                autoComplete="current-password"
                                required
                            />
                        </div>
                        <button className="btn btn-primary" type="submit" disabled={loading}>
                            {loading ? 'Signing in...' : 'Log In'}
                        </button>
                        <button type="button" className="link-btn" onClick={() => { setError(''); setInfo(''); setMode('ask'); }}>
                            Forgot your password?
                        </button>
                    </form>
                )}

                {mode === 'ask' && (
                    <form onSubmit={askPin}>
                        <div className="form-group">
                            <label htmlFor="fusername">Username</label>
                            <input id="fusername" type="text" value={username} onChange={e => setUsername(e.target.value)}
                                placeholder="Your username" autoFocus autoComplete="username" required />
                        </div>
                        <button className="btn btn-primary" type="submit" disabled={loading}>
                            {loading ? 'Sending...' : 'Get a PIN'}
                        </button>
                        <button type="button" className="link-btn" onClick={() => { setError(''); setMode('login'); }}>Back to log in</button>
                    </form>
                )}

                {mode === 'pin' && (
                    <form onSubmit={changePassword}>
                        <div className="pin-timer" aria-live="polite">
                            {left > 0 ? <>PIN valid for <strong>{mm}:{ss}</strong></> : <>The PIN has expired</>}
                        </div>
                        <div className="form-group">
                            <label htmlFor="pin">PIN (4 digits)</label>
                            <input id="pin" className="pin-input" type="text" inputMode="numeric" pattern="\d{4}" maxLength={4}
                                value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                                placeholder="••••" autoFocus autoComplete="one-time-code" required />
                        </div>
                        <div className="form-group">
                            <label htmlFor="np">New password</label>
                            <input id="np" type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
                                placeholder="At least 6 characters" autoComplete="new-password" minLength={6} required />
                        </div>
                        <div className="form-group">
                            <label htmlFor="np2">New password again</label>
                            <input id="np2" type="password" value={repeat} onChange={e => setRepeat(e.target.value)}
                                autoComplete="new-password" minLength={6} required />
                        </div>
                        <button className="btn btn-primary" type="submit" disabled={loading || left === 0}>
                            {loading ? 'Saving...' : 'Change password'}
                        </button>
                        <button type="button" className="link-btn" onClick={askPin}>Send a new PIN</button>
                        <button type="button" className="link-btn" onClick={() => { setError(''); setMode('login'); }}>Back to log in</button>
                    </form>
                )}

                {mode === 'login' && (
                    <div className="auth-switch">
                        Don't have an account? <Link to="/register">Register</Link>
                    </div>
                )}
            </div>
        </div>
    );
}
