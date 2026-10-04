import { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { api } from './api';
import type { User } from './api';

interface AuthCtx {
    user: User | null;
    token: string | null;
    login: (token: string, user: User) => void;
    logout: () => void;
    updateUser: (user: User) => void;
    loading: boolean;
}

const AuthContext = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const saved = localStorage.getItem('velcord_token');
        if (!saved) { setLoading(false); return; }
        setToken(saved);
        let alive = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        // Only a clear "401 Unauthorized" means the token is bad. A network error or a server error
        // (for example the database being over its limit) keeps the login and tries again.
        const check = () => {
            api.me().then(u => {
                if (!alive) return;
                setUser(u);
                setLoading(false);
            }).catch((e: any) => {
                if (!alive) return;
                if (e?.status === 401) {
                    localStorage.removeItem('velcord_token');
                    setToken(null);
                    setLoading(false);
                } else {
                    timer = setTimeout(check, 3000);
                }
            });
        };
        check();
        return () => { alive = false; if (timer) clearTimeout(timer); };
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

    const updateUser = (u: User) => {
        setUser(u);
    };

    return (
        <AuthContext.Provider value={{ user, token, login, logout, updateUser, loading }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be inside AuthProvider');
    return ctx;
}
