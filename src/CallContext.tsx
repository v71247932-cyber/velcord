import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './api';
import type { CallSignal, User } from './api';
import { useAuth } from './AuthContext';
import Avatar from './components/Avatar';

type Phase = 'idle' | 'calling' | 'ringing' | 'connecting' | 'active';

interface CallContextValue {
    phase: Phase;
    startCall: (friend: User) => void;
}

const CallContext = createContext<CallContextValue>({ phase: 'idle', startCall: () => {} });
export const useCall = () => useContext(CallContext);

const RTC_CONFIG: RTCConfiguration = {
    iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
    ],
};
const RING_TIMEOUT_MS = 45_000;
const INVITE_MAX_AGE_S = 45;

function describeMediaError(e: any): string {
    if (e?.name === 'NotAllowedError') return 'Microphone permission was denied. Allow it in your browser and try again.';
    if (e?.name === 'NotFoundError') return 'No microphone found.';
    return e?.message || 'Could not access the microphone.';
}

export function CallProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    const [phase, setPhase] = useState<Phase>('idle');
    const [peer, setPeer] = useState<User | null>(null);
    const [muted, setMuted] = useState(false);
    const [hasMic, setHasMic] = useState(true);
    const [sharing, setSharing] = useState(false);
    const [remoteSharing, setRemoteSharing] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [askShare, setAskShare] = useState(false);
    const [seconds, setSeconds] = useState(0);

    // Mutable call state lives in refs so the polling loop never sees stale values
    const phaseRef = useRef<Phase>('idle');
    const peerRef = useRef<User | null>(null);
    const pcRef = useRef<RTCPeerConnection | null>(null);
    const micRef = useRef<MediaStream | null>(null);
    const screenRef = useRef<MediaStream | null>(null);
    const screenSenderRef = useRef<RTCRtpSender | null>(null);
    const remoteStreamRef = useRef<MediaStream>(new MediaStream());
    const politeRef = useRef(false);
    const makingOfferRef = useRef(false);
    const ignoreOfferRef = useRef(false);
    const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
    const ringTimerRef = useRef<number | null>(null);
    const lastIdRef = useRef<number | null>(null);
    const queueRef = useRef<Promise<void>>(Promise.resolve());
    const videoRef = useRef<HTMLVideoElement>(null);

    const setPhaseBoth = (p: Phase) => { phaseRef.current = p; setPhase(p); };

    const send = useCallback((type: string, payload?: unknown) => {
        const to = peerRef.current?.id;
        if (to === undefined) return Promise.resolve();
        return api.callSignal(to, type, payload).then(() => {}).catch(() => {});
    }, []);

    const cleanup = useCallback(() => {
        if (ringTimerRef.current) { clearTimeout(ringTimerRef.current); ringTimerRef.current = null; }
        pcRef.current?.close();
        pcRef.current = null;
        micRef.current?.getTracks().forEach(t => t.stop());
        micRef.current = null;
        screenRef.current?.getTracks().forEach(t => t.stop());
        screenRef.current = null;
        screenSenderRef.current = null;
        remoteStreamRef.current = new MediaStream();
        if (videoRef.current) videoRef.current.srcObject = null;
        pendingIceRef.current = [];
        makingOfferRef.current = false;
        ignoreOfferRef.current = false;
        peerRef.current = null;
        setPeer(null);
        setMuted(false);
        setHasMic(true);
        setSharing(false);
        setRemoteSharing(false);
        setAskShare(false);
        setSeconds(0);
        setPhaseBoth('idle');
    }, []);

    const endCall = useCallback((message?: string, notifyPeer = true) => {
        if (notifyPeer && peerRef.current) {
            // Fire and forget: the signal must go out before refs are cleared
            const to = peerRef.current.id;
            api.callSignal(to, 'hangup').catch(() => {});
        }
        cleanup();
        if (message) setNotice(message);
    }, [cleanup]);

    const updateRemoteSharing = useCallback(() => {
        const live = remoteStreamRef.current.getVideoTracks().some(t => t.readyState === 'live' && !t.muted);
        setRemoteSharing(live);
    }, []);

    const createPeerConnection = useCallback((polite: boolean) => {
        politeRef.current = polite;
        const pc = new RTCPeerConnection(RTC_CONFIG);
        pcRef.current = pc;

        if (micRef.current) {
            micRef.current.getTracks().forEach(t => pc.addTrack(t, micRef.current!));
        } else {
            // No microphone: still receive the other side's audio
            pc.addTransceiver('audio', { direction: 'recvonly' });
        }

        pc.onicecandidate = e => { if (e.candidate) send('ice', e.candidate.toJSON()); };

        pc.onnegotiationneeded = async () => {
            try {
                makingOfferRef.current = true;
                await pc.setLocalDescription();
                await send('desc', pc.localDescription);
            } catch { /* noop */ }
            finally { makingOfferRef.current = false; }
        };

        pc.ontrack = e => {
            const stream = remoteStreamRef.current;
            if (!stream.getTracks().includes(e.track)) stream.addTrack(e.track);
            if (videoRef.current && videoRef.current.srcObject !== stream) {
                videoRef.current.srcObject = stream;
                videoRef.current.play().catch(() => {});
            }
            e.track.onmute = updateRemoteSharing;
            e.track.onunmute = updateRemoteSharing;
            e.track.onended = updateRemoteSharing;
            updateRemoteSharing();
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'connected') setPhaseBoth('active');
            if (pc.connectionState === 'failed') endCall('Connection lost. Both sides may be behind a strict network.');
        };
        return pc;
    }, [send, endCall, updateRemoteSharing]);

    const flushIce = async (pc: RTCPeerConnection) => {
        const pending = pendingIceRef.current;
        pendingIceRef.current = [];
        for (const c of pending) { try { await pc.addIceCandidate(c); } catch { /* noop */ } }
    };

    // The microphone is optional: without it you can still call, listen and share your screen.
    const getMic = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
            micRef.current = stream;
            setHasMic(true);
        } catch (e) {
            micRef.current = null;
            setHasMic(false);
            setNotice(`${describeMediaError(e)} Calling without a microphone: you can listen and share your screen.`);
        }
    };

    const handleSignal = useCallback(async (sig: CallSignal, serverNow: number) => {
        const fromId = sig.from.id;

        if (sig.type === 'invite') {
            if (serverNow - sig.createdAt > INVITE_MAX_AGE_S) return; // stale ring
            if (phaseRef.current !== 'idle') {
                // busy: tell the caller (peerRef is another user, so call the API directly)
                api.callSignal(fromId, 'reject', 'busy').catch(() => {});
                return;
            }
            peerRef.current = sig.from;
            setPeer(sig.from);
            setPhaseBoth('ringing');
            ringTimerRef.current = window.setTimeout(() => {
                if (phaseRef.current === 'ringing') endCall('Missed call', false);
            }, RING_TIMEOUT_MS);
            return;
        }

        if (peerRef.current?.id !== fromId) return; // not our call

        switch (sig.type) {
            case 'accept': {
                if (phaseRef.current !== 'calling') return;
                if (ringTimerRef.current) { clearTimeout(ringTimerRef.current); ringTimerRef.current = null; }
                setPhaseBoth('connecting');
                createPeerConnection(false); // caller is impolite; adding mic tracks triggers the first offer
                break;
            }
            case 'reject':
                endCall(sig.payload && JSON.parse(sig.payload) === 'busy' ? `${sig.from.username} is on another call.` : `${sig.from.username} declined the call.`, false);
                break;
            case 'hangup':
                endCall(phaseRef.current === 'ringing' ? 'Missed call' : 'Call ended', false);
                break;
            case 'desc': {
                const pc = pcRef.current;
                if (!pc || !sig.payload) return;
                const desc = JSON.parse(sig.payload) as RTCSessionDescriptionInit;
                const collision = desc.type === 'offer' && (makingOfferRef.current || pc.signalingState !== 'stable');
                ignoreOfferRef.current = !politeRef.current && collision;
                if (ignoreOfferRef.current) return;
                await pc.setRemoteDescription(desc);
                await flushIce(pc);
                if (desc.type === 'offer') {
                    await pc.setLocalDescription();
                    await send('desc', pc.localDescription);
                }
                break;
            }
            case 'ice': {
                const pc = pcRef.current;
                if (!pc || !sig.payload) return;
                const cand = JSON.parse(sig.payload) as RTCIceCandidateInit;
                if (!pc.remoteDescription) { pendingIceRef.current.push(cand); return; }
                try { await pc.addIceCandidate(cand); } catch { if (!ignoreOfferRef.current) { /* ignore */ } }
                break;
            }
        }
    }, [createPeerConnection, endCall, send]);

    // Poll for incoming signals. Slow while idle, fast during a call.
    useEffect(() => {
        if (!user) return;
        let stopped = false;
        let timer: number;
        const tick = async () => {
            try {
                if (lastIdRef.current === null) {
                    const init = await api.callPoll(-1);
                    lastIdRef.current = init.lastId ?? 0;
                } else {
                    const res = await api.callPoll(lastIdRef.current);
                    for (const sig of res.signals) {
                        lastIdRef.current = Math.max(lastIdRef.current, sig.id);
                        queueRef.current = queueRef.current.then(() => handleSignal(sig, res.now)).catch(() => {});
                    }
                }
            } catch { /* offline: try again */ }
            if (!stopped) timer = window.setTimeout(tick, phaseRef.current === 'idle' ? 1500 : 500);
        };
        tick();
        return () => { stopped = true; clearTimeout(timer); };
    }, [user, handleSignal]);

    // Call timer
    useEffect(() => {
        if (phase !== 'active') return;
        const t = setInterval(() => setSeconds(s => s + 1), 1000);
        return () => clearInterval(t);
    }, [phase]);

    // Ringtone: ring-ring for incoming calls, a softer ringback while calling
    useEffect(() => {
        if (phase !== 'ringing' && phase !== 'calling') return;
        const Ctx = window.AudioContext || (window as any).webkitAudioContext;
        if (!Ctx) return;
        const ctx: AudioContext = new Ctx();
        ctx.resume().catch(() => {});
        const incoming = phase === 'ringing';
        const beep = (freqs: number[], start: number, dur: number, vol: number) => {
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0, ctx.currentTime + start);
            gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + start + 0.02);
            gain.gain.setValueAtTime(vol, ctx.currentTime + start + dur - 0.03);
            gain.gain.linearRampToValueAtTime(0, ctx.currentTime + start + dur);
            gain.connect(ctx.destination);
            for (const f of freqs) {
                const osc = ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.value = f;
                osc.connect(gain);
                osc.start(ctx.currentTime + start);
                osc.stop(ctx.currentTime + start + dur);
            }
        };
        const pattern = () => {
            if (incoming) { beep([880, 1100], 0, 0.35, 0.18); beep([880, 1100], 0.5, 0.35, 0.18); }
            else beep([440, 480], 0, 1.2, 0.08);
        };
        pattern();
        const iv = setInterval(pattern, incoming ? 2200 : 3000);
        const prevTitle = document.title;
        if (incoming) document.title = '📞 Incoming call';
        return () => { clearInterval(iv); ctx.close().catch(() => {}); document.title = prevTitle; };
    }, [phase]);

    // Auto-hide notices
    useEffect(() => {
        if (!notice) return;
        const t = setTimeout(() => setNotice(null), 5000);
        return () => clearTimeout(t);
    }, [notice]);

    // Leave the call if the tab is closed
    useEffect(() => {
        const onUnload = () => {
            const p = peerRef.current;
            const token = localStorage.getItem('velcord_token');
            if (p && token) {
                fetch('/api/calls/signal', {
                    method: 'POST', keepalive: true,
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ to: p.id, type: 'hangup' }),
                }).catch(() => {});
            }
        };
        window.addEventListener('beforeunload', onUnload);
        return () => window.removeEventListener('beforeunload', onUnload);
    }, []);

    const startCall = useCallback(async (friend: User) => {
        if (phaseRef.current !== 'idle') return;
        await getMic();
        if (phaseRef.current !== 'idle') return;
        peerRef.current = friend;
        setPeer(friend);
        setPhaseBoth('calling');
        try {
            await api.callSignal(friend.id, 'invite');
        } catch (e: any) {
            endCall(e.message || 'Could not start the call', false);
            return;
        }
        ringTimerRef.current = window.setTimeout(() => {
            if (phaseRef.current === 'calling') endCall(`${friend.username} didn't answer.`);
        }, RING_TIMEOUT_MS);
    }, [endCall]);

    async function acceptCall() {
        if (phaseRef.current !== 'ringing') return;
        if (ringTimerRef.current) { clearTimeout(ringTimerRef.current); ringTimerRef.current = null; }
        await getMic();
        if (phaseRef.current !== 'ringing') { micRef.current?.getTracks().forEach(t => t.stop()); micRef.current = null; return; }
        setPhaseBoth('connecting');
        createPeerConnection(true);
        await send('accept');
    }

    function declineCall() {
        send('reject');
        cleanup();
    }

    function toggleMute() {
        const next = !muted;
        micRef.current?.getAudioTracks().forEach(t => { t.enabled = !next; });
        setMuted(next);
    }

    async function startScreenShare() {
        setAskShare(false);
        const pc = pcRef.current;
        if (!pc) return;
        try {
            // The browser shows its own picker (screen / window / tab) and asks for permission here
            const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
            const track = stream.getVideoTracks()[0];
            screenRef.current = stream;
            screenSenderRef.current = pc.addTrack(track, stream);
            track.onended = () => stopScreenShare();
            setSharing(true);
        } catch (e: any) {
            if (e?.name === 'NotAllowedError') setNotice('Screen sharing was cancelled or not allowed.');
            else setNotice(e?.message || 'Could not share the screen.');
        }
    }

    function stopScreenShare() {
        const pc = pcRef.current;
        if (pc && screenSenderRef.current) {
            try { pc.removeTrack(screenSenderRef.current); } catch { /* noop */ }
        }
        screenRef.current?.getTracks().forEach(t => t.stop());
        screenRef.current = null;
        screenSenderRef.current = null;
        setSharing(false);
    }

    const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
    const ss = String(seconds % 60).padStart(2, '0');
    const inCall = phase === 'connecting' || phase === 'active';

    return (
        <CallContext.Provider value={{ phase, startCall }}>
            {children}

            {notice && <div className="call-toast" onClick={() => setNotice(null)}>{notice}</div>}

            {/* Always mounted so the remote audio keeps playing */}
            <video ref={videoRef} className={remoteSharing && inCall ? 'call-remote-video' : 'call-hidden'} autoPlay playsInline />

            {phase === 'ringing' && peer && (
                <div className="call-card call-incoming">
                    <Avatar name={peer.username} color={peer.avatarColor} src={peer.avatarUrl} size="lg" />
                    <div className="call-title">{peer.username}</div>
                    <div className="call-sub">is calling you…</div>
                    <div className="call-buttons">
                        <button className="call-btn call-btn-accept" onClick={acceptCall}>Accept</button>
                        <button className="call-btn call-btn-end" onClick={declineCall}>Decline</button>
                    </div>
                </div>
            )}

            {phase === 'calling' && peer && (
                <div className="call-card">
                    <Avatar name={peer.username} color={peer.avatarColor} src={peer.avatarUrl} size="lg" />
                    <div className="call-title">{peer.username}</div>
                    <div className="call-sub">Calling…</div>
                    <div className="call-buttons">
                        <button className="call-btn call-btn-end" onClick={() => endCall()}>Cancel</button>
                    </div>
                </div>
            )}

            {inCall && peer && (
                <div className={`call-card call-active ${remoteSharing ? 'call-with-video' : ''}`}>
                    <div className="call-row">
                        <Avatar name={peer.username} color={peer.avatarColor} src={peer.avatarUrl} size="sm" />
                        <div>
                            <div className="call-title">{peer.username}</div>
                            <div className="call-sub">
                                {phase === 'active' ? `${mm}:${ss}` : 'Connecting…'}
                                {sharing && ' · You are sharing your screen'}
                                {remoteSharing && ' · Watching their screen'}
                            </div>
                        </div>
                    </div>
                    <div className="call-buttons">
                        <button className={`call-btn ${muted ? 'call-btn-on' : ''}`} onClick={toggleMute} disabled={!hasMic} title={hasMic ? '' : 'No microphone'}>
                            {!hasMic ? 'No mic' : muted ? 'Unmute' : 'Mute'}
                        </button>
                        {sharing
                            ? <button className="call-btn call-btn-on" onClick={stopScreenShare}>Stop sharing</button>
                            : <button className="call-btn" onClick={() => setAskShare(true)} disabled={phase !== 'active'}>Share screen</button>}
                        <button className="call-btn call-btn-end" onClick={() => endCall()}>Hang up</button>
                    </div>
                </div>
            )}

            {askShare && (
                <div className="modal-overlay" onClick={() => setAskShare(false)}>
                    <div className="modal-content" style={{ maxWidth: 400 }} onClick={e => e.stopPropagation()}>
                        <div className="modal-header"><h2>Share your screen?</h2></div>
                        <div className="modal-body">
                            <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.5 }}>
                                {peer?.username} will see what you pick in the next window. Your browser will ask you
                                to choose a screen, window or tab and to allow sharing. You can stop at any time.
                            </p>
                        </div>
                        <div className="modal-footer">
                            <button className="btn-link" onClick={() => setAskShare(false)}>Cancel</button>
                            <button className="btn-primary" onClick={startScreenShare}>Continue</button>
                        </div>
                    </div>
                </div>
            )}
        </CallContext.Provider>
    );
}
