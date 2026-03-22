import { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { api } from './api';
import type { User } from './api';

interface AuthCtx {
    user: User | null;
    token: string | null;
    login: (token: string, user: User) => void;
    logout: () => void;
    loading: boolean;
}

const AuthContext = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const saved = localStorage.getItem('velcord_token');
        if (saved) {
            setToken(saved);
            api.me().then(u => {
                setUser(u);
                setLoading(false);
            }).catch(() => {
                localStorage.removeItem('velcord_token');
                setToken(null);
                setLoading(false);
            });
        } else {
            setLoading(false);
        }
    }, []);

    const login = (t: string, u: User) => {
        localStorage.setItem('velcord_token', t);
        setToken(t);
        setUser(u);
    };

    const logout = () => {
        localStorage.removeItem('velcord_token');
        setToken(null);
        setUser(null);
    };

    return (
        <AuthContext.Provider value={{ user, token, login, logout, loading }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be inside AuthProvider');
    return ctx;
}
