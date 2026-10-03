import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './api';
import type { CallSignal, User } from './api';
import { useAuth } from './AuthContext';
import Avatar from './components/Avatar';
import { MicIcon, MicOffIcon, VideoIcon, VideoOffIcon } from './components/Icons';
import { notify } from './notify';
import { callBusy } from './callBusy';
import { startRinging } from './ringtones';
import { onLive } from './live';

type Phase = 'idle' | 'calling' | 'ringing' | 'connecting' | 'active';

interface CallContextValue {
    phase: Phase;
    startCall: (friend: User, opts?: { video?: boolean }) => void;
    /** Mic and headphones state, usable inside and outside a call */
    muted: boolean;
    deafened: boolean;
    toggleMute: () => void;
    toggleDeafen: () => void;
}

const CallContext = createContext<CallContextValue>({
    phase: 'idle', startCall: () => {}, muted: false, deafened: false, toggleMute: () => {}, toggleDeafen: () => {},
});
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

/** Calls onChange(true/false) when the audio in the stream is loud enough to count as speaking. */
function watchSpeaking(stream: MediaStream, onChange: (speaking: boolean) => void): () => void {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx || stream.getAudioTracks().length === 0) return () => {};
    const ctx: AudioContext = new Ctx();
    ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    let speaking = false;
    let lastLoud = 0;
    const iv = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const loud = Math.sqrt(sum / buf.length) > 0.02;
        const now = Date.now();
        if (loud) lastLoud = now;
        const next = now - lastLoud < 350; // hold briefly so the ring does not flicker
        if (next !== speaking) { speaking = next; onChange(next); }
    }, 80);
    return () => { clearInterval(iv); ctx.close().catch(() => {}); onChange(false); };
}

export function CallProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    const [phase, setPhase] = useState<Phase>('idle');
    const [peer, setPeer] = useState<User | null>(null);
    const [muted, setMuted] = useState(false);
    const [hasMic, setHasMic] = useState(true);
    const [deafened, setDeafened] = useState(false);
    const mutedRef = useRef(false);
    const deafenedRef = useRef(false);
    const [sharing, setSharing] = useState(false);
    const [remoteSharing, setRemoteSharing] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [askShare, setAskShare] = useState(false);
    const [seconds, setSeconds] = useState(0);
    const [localSpeaking, setLocalSpeaking] = useState(false);
    const [remoteSpeaking, setRemoteSpeaking] = useState(false);
    const [localCam, setLocalCam] = useState(false);
    const [remoteCam, setRemoteCam] = useState(false);
    const [incomingVideo, setIncomingVideo] = useState(false);
    const [startedVideo, setStartedVideo] = useState(false); // I started this call as a video call
    const [sawCam, setSawCam] = useState(false); // someone turned a camera on during this call
    const [trackVersion, setTrackVersion] = useState(0);

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
    const audioElRef = useRef<HTMLAudioElement>(null);
    const screenElRef = useRef<HTMLVideoElement>(null);
    const camElRef = useRef<HTMLVideoElement>(null);
    const localCamElRef = useRef<HTMLVideoElement>(null);
    const camRef = useRef<MediaStream | null>(null);
    const camSenderRef = useRef<RTCRtpSender | null>(null);
    const camCarrierRef = useRef<MediaStream | null>(null);
    const screenCarrierRef = useRef<MediaStream | null>(null);
    // Incoming video arrives as separate streams; signals say which one is the camera and which the screen
    const remoteVideoStreams = useRef<Map<string, MediaStream>>(new Map());
    const remoteScreenIdRef = useRef<string | null>(null);
    const remoteCamIdRef = useRef<string | null>(null);
    const startingShareRef = useRef(false);
    const stopLocalMeterRef = useRef<(() => void) | null>(null);
    const stopRemoteMeterRef = useRef<(() => void) | null>(null);

    const setPhaseBoth = (p: Phase) => { phaseRef.current = p; setPhase(p); };

    const send = useCallback((type: string, payload?: unknown) => {
        const to = peerRef.current?.id;
        if (to === undefined) return Promise.resolve();
        return api.callSignal(to, type, payload).then(() => {}).catch(() => {});
    }, []);

    const cleanup = useCallback(() => {
        if (ringTimerRef.current) { clearTimeout(ringTimerRef.current); ringTimerRef.current = null; }
        stopLocalMeterRef.current?.(); stopLocalMeterRef.current = null;
        stopRemoteMeterRef.current?.(); stopRemoteMeterRef.current = null;
        pcRef.current?.close();
        pcRef.current = null;
        micRef.current?.getTracks().forEach(t => t.stop());
        micRef.current = null;
        screenRef.current?.getTracks().forEach(t => t.stop());
        screenSenderRef.current?.track?.stop();
        screenRef.current = null;
        screenSenderRef.current = null;
        startingShareRef.current = false;
        remoteStreamRef.current = new MediaStream();
        camSenderRef.current?.track?.stop();
        camRef.current?.getTracks().forEach(t => t.stop());
        camRef.current = null; camSenderRef.current = null; camCarrierRef.current = null; screenCarrierRef.current = null;
        remoteVideoStreams.current = new Map(); remoteScreenIdRef.current = null; remoteCamIdRef.current = null;
        for (const el of [audioElRef.current, screenElRef.current, camElRef.current, localCamElRef.current]) if (el) el.srcObject = null;
        pendingIceRef.current = [];
        makingOfferRef.current = false;
        ignoreOfferRef.current = false;
        peerRef.current = null;
        setPeer(null);
        setHasMic(true);
        setSharing(false);
        setRemoteSharing(false);
        setLocalCam(false);
        setRemoteCam(false);
        setIncomingVideo(false);
        setStartedVideo(false);
        setSawCam(false);
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
            if (e.track.kind === 'audio') {
                const audio = remoteStreamRef.current;
                if (!audio.getTracks().includes(e.track)) audio.addTrack(e.track);
                const el = audioElRef.current;
                if (el && el.srcObject !== audio) { el.srcObject = audio; el.play().catch(() => {}); }
                if (!stopRemoteMeterRef.current) {
                    stopRemoteMeterRef.current = watchSpeaking(new MediaStream([e.track]), setRemoteSpeaking);
                }
            } else {
                const st = e.streams[0] ?? new MediaStream([e.track]);
                remoteVideoStreams.current.set(st.id, st);
                setTrackVersion(v => v + 1);
            }
            // Ask the browser to keep playback buffering minimal (less delay)
            try { (e.receiver as any).jitterBufferTarget = 0; } catch { /* unsupported */ }
            try { (e.receiver as any).playoutDelayHint = 0; } catch { /* unsupported */ }
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'connected') setPhaseBoth('active');
            if (pc.connectionState === 'failed') endCall('Connection lost. Both sides may be behind a strict network.');
        };
        return pc;
    }, [send, endCall]);

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
            stream.getAudioTracks().forEach(t => { t.enabled = !(mutedRef.current || deafenedRef.current); });
            setHasMic(true);
            stopLocalMeterRef.current?.();
            stopLocalMeterRef.current = watchSpeaking(stream, setLocalSpeaking);
        } catch (e) {
            micRef.current = null;
            setHasMic(false);
            setNotice(`${describeMediaError(e)} Calling without a microphone: you can listen and share your screen.`);
        }
    };

    // The camera is optional too: a call can start with it or get it later with the Camera button.
    const getCamera = async (): Promise<boolean> => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
                audio: false,
            });
            camRef.current = stream;
            setLocalCam(true);
            return true;
        } catch (e: any) {
            camRef.current = null;
            setLocalCam(false);
            setNotice(e?.name === 'NotAllowedError'
                ? 'Camera permission was denied. Allow it in your browser or system settings and try again.'
                : e?.name === 'NotFoundError' ? 'No camera found.' : 'Could not access the camera.');
            return false;
        }
    };

    /** Sends the camera to the other side. The video sender is reused when the camera is turned on again. */
    const publishCamera = useCallback((pc: RTCPeerConnection) => {
        const stream = camRef.current;
        const track = stream?.getVideoTracks()[0];
        if (!stream || !track) return;
        try { track.contentHint = 'motion'; } catch { /* unsupported */ }
        track.onended = () => { if (camRef.current === stream) stopCameraRef.current(); }; // unplugged or revoked
        if (camSenderRef.current) {
            camSenderRef.current.replaceTrack(track)
                .then(() => send('cam', { on: true, id: camCarrierRef.current?.id }))
                .catch(() => {});
        } else {
            const carrier = new MediaStream(); // its id tells the viewer which stream is the camera
            camCarrierRef.current = carrier;
            const tr = pc.addTransceiver(track, {
                direction: 'sendonly',
                streams: [carrier],
                sendEncodings: [{ maxBitrate: 2_500_000, maxFramerate: 30 }],
            });
            camSenderRef.current = tr.sender;
            // Give the first negotiation a moment so the viewer is ready for frames
            setTimeout(() => { if (camRef.current === stream) send('cam', { on: true, id: carrier.id }); }, 700);
        }
    }, [send]);

    const stopCameraRef = useRef<() => void>(() => {});

    const handleSignal = useCallback(async (sig: CallSignal, serverNow: number) => {
        const fromId = sig.from.id;

        if (sig.type === 'invite') {
            if (serverNow - sig.createdAt > INVITE_MAX_AGE_S) return; // stale ring
            if (phaseRef.current !== 'idle' || callBusy.conference) {
                // busy: tell the caller (peerRef is another user, so call the API directly)
                api.callSignal(fromId, 'reject', 'busy').catch(() => {});
                return;
            }
            peerRef.current = sig.from;
            setPeer(sig.from);
            try { setIncomingVideo(!!(sig.payload && JSON.parse(sig.payload)?.video)); } catch { setIncomingVideo(false); }
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
                const pc0 = createPeerConnection(false); // caller is impolite; adding mic tracks triggers the first offer
                publishCamera(pc0);
                break;
            }
            case 'reject':
                endCall(sig.payload && JSON.parse(sig.payload) === 'busy' ? `${sig.from.username} is on another call.` : `${sig.from.username} declined the call.`, false);
                break;
            case 'hangup':
                endCall(phaseRef.current === 'ringing' ? 'Missed call' : 'Call ended', false);
                break;
            case 'share':
            case 'cam': {
                // Older tabs send a bare true/false, newer ones {on, id}
                const raw = sig.payload ? JSON.parse(sig.payload) : null;
                const on = typeof raw === 'object' && raw ? !!raw.on : !!raw;
                const id = typeof raw === 'object' && raw?.id ? String(raw.id) : null;
                if (sig.type === 'share') { if (id) remoteScreenIdRef.current = id; setRemoteSharing(on); }
                else { if (id) remoteCamIdRef.current = id; setRemoteCam(on); }
                setTrackVersion(v => v + 1);
                break;
            }
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
    }, [createPeerConnection, publishCamera, endCall, send]);

    // Poll for incoming signals. Slow while idle, fast during a call.
    useEffect(() => {
        if (!user) return;
        let stopped = false;
        let timer: number;
        let busy = false;
        const tick = async () => {
            if (busy) return;
            busy = true;
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
            busy = false;
            clearTimeout(timer);
            if (!stopped) timer = window.setTimeout(tick, phaseRef.current === 'idle' ? 3000 : 500);
        };
        tick();
        // A new call signal wakes this up at once, so ringing starts without waiting for the timer
        const off = onLive(tick);
        return () => { stopped = true; clearTimeout(timer); off(); };
    }, [user, handleSignal]);

    // Tells the conference side that a one-to-one call is going on
    useEffect(() => { callBusy.oneToOne = phase !== 'idle'; }, [phase]);

    // Call timer
    useEffect(() => {
        if (phase !== 'active') return;
        const t = setInterval(() => setSeconds(s => s + 1), 1000);
        return () => clearInterval(t);
    }, [phase]);

    // Ringtone (chosen in settings): plays while an incoming call rings and while we are calling
    useEffect(() => {
        if (phase !== 'ringing' && phase !== 'calling') return;
        const incoming = phase === 'ringing';
        const prevTitle = document.title;
        const stopSound = startRinging(incoming);

        let toast: Notification | null = null;
        if (incoming) {
            document.title = '📞 Incoming call';
            const who = peerRef.current?.username || 'Someone';
            if (!document.hasFocus()) toast = notify(incomingVideo ? 'Incoming video call' : 'Incoming call', `${who} is ${incomingVideo ? 'video ' : ''}calling you`, { tag: 'velcord-call', requireInteraction: true });
        }

        return () => {
            stopSound();
            toast?.close();
            document.title = prevTitle;
        };
    }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

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

    const startCall = useCallback(async (friend: User, opts?: { video?: boolean }) => {
        if (phaseRef.current !== 'idle') return;
        if (callBusy.conference) { setNotice('Leave the group call first.'); return; }
        await getMic();
        if (opts?.video) { setStartedVideo(true); await getCamera(); }
        if (phaseRef.current !== 'idle') { camRef.current?.getTracks().forEach(t => t.stop()); camRef.current = null; return; }
        peerRef.current = friend;
        setPeer(friend);
        setPhaseBoth('calling');
        try {
            await api.callSignal(friend.id, 'invite', opts?.video ? { video: true } : undefined);
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
        if (incomingVideo) await getCamera();
        if (phaseRef.current !== 'ringing') {
            micRef.current?.getTracks().forEach(t => t.stop()); micRef.current = null;
            camRef.current?.getTracks().forEach(t => t.stop()); camRef.current = null;
            return;
        }
        setPhaseBoth('connecting');
        const pc1 = createPeerConnection(true);
        publishCamera(pc1);
        await send('accept');
    }

    function declineCall() {
        send('reject');
        cleanup();
    }

    // Mic follows muted/deafened; headphones follow deafened (like Discord)
    useEffect(() => {
        mutedRef.current = muted;
        deafenedRef.current = deafened;
        micRef.current?.getAudioTracks().forEach(t => { t.enabled = !(muted || deafened); });
        if (audioElRef.current) audioElRef.current.muted = deafened;
    }, [muted, deafened, phase]);

    function toggleMute() {
        if (deafened) { setDeafened(false); setMuted(false); return; } // unmuting while deafened undeafens
        setMuted(m => !m);
    }

    function toggleDeafen() {
        setDeafened(d => !d);
    }

    function stopCamera() {
        const sender = camSenderRef.current;
        const live = sender?.track;
        sender?.replaceTrack(null).catch(() => {}); // keep the sender for the next time
        live?.stop();
        camRef.current?.getTracks().forEach(t => t.stop());
        camRef.current = null;
        setLocalCam(false);
        send('cam', { on: false, id: camCarrierRef.current?.id });
    }
    stopCameraRef.current = stopCamera;

    async function toggleCamera() {
        const pc = pcRef.current;
        if (!pc) return;
        if (camRef.current) { stopCamera(); return; }
        if (await getCamera() && pcRef.current === pc) publishCamera(pc);
    }

    async function startScreenShare() {
        setAskShare(false);
        const pc = pcRef.current;
        if (!pc || startingShareRef.current || screenRef.current) return;
        startingShareRef.current = true;
        let stream: MediaStream | null = null;
        try {
            // The browser shows its own picker (screen / window / tab) and asks for permission here
            stream = await navigator.mediaDevices.getDisplayMedia({
                video: { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate: { ideal: 60, max: 60 } },
                audio: false,
            });
            const track = stream.getVideoTracks()[0];
            // 'motion' keeps the frame rate high instead of dropping to a slideshow to keep text sharp
            try { track.contentHint = 'motion'; } catch { /* unsupported */ }
            screenRef.current = stream;
            track.onended = () => stopScreenShare(); // the browser's own "Stop sharing" button

            if (screenSenderRef.current) {
                // Sharing again: reuse the same video sender. Adding a new track made the viewer see black.
                await screenSenderRef.current.replaceTrack(track);
                await send('share', { on: true, id: screenCarrierRef.current?.id });
            } else {
                const mine = stream;
                const carrier = new MediaStream(); // its id tells the viewer which stream is the screen
                screenCarrierRef.current = carrier;
                const tr = pc.addTransceiver(track, {
                    direction: 'sendonly',
                    streams: [carrier],
                    sendEncodings: [{ maxBitrate: 8_000_000, maxFramerate: 60, scaleResolutionDownBy: 1 }],
                });
                screenSenderRef.current = tr.sender;
                tuneScreenSender(pc, tr.sender);
                // Give the first negotiation a moment so the viewer is ready for frames
                setTimeout(() => { if (screenRef.current === mine) send('share', { on: true, id: carrier.id }); }, 700);
            }
            setSharing(true);
        } catch (e: any) {
            // Cancelled or failed: make sure nothing keeps capturing and the UI says we are not sharing
            stream?.getTracks().forEach(t => t.stop());
            if (screenRef.current === stream) screenRef.current = null;
            setSharing(false);
            if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') setNotice('Screen sharing was cancelled.');
            else setNotice(e?.message || 'Could not share the screen.');
        } finally {
            startingShareRef.current = false;
        }
    }

    // Raise the default (very low) bitrate for screen video and prefer smooth frames.
    // Encoding parameters only exist after negotiation, so retry until they appear.
    function tuneScreenSender(pc: RTCPeerConnection, sender: RTCRtpSender) {
        let tries = 0;
        const attempt = async () => {
            if (pcRef.current !== pc || screenSenderRef.current !== sender) return;
            try {
                const params = sender.getParameters();
                if (params.encodings && params.encodings.length > 0) {
                    params.encodings[0].maxBitrate = 8_000_000;
                    params.encodings[0].maxFramerate = 60;
                    params.encodings[0].scaleResolutionDownBy = 1;
                    (params as any).degradationPreference = 'maintain-framerate';
                    await sender.setParameters(params);
                    return;
                }
            } catch { /* retry */ }
            if (++tries < 20) setTimeout(attempt, 250);
        };
        attempt();
    }

    function stopScreenShare() {
        const sender = screenSenderRef.current;
        const live = sender?.track; // stop whatever is being sent, even if refs got out of sync
        sender?.replaceTrack(null).catch(() => {}); // keep the sender for the next share
        live?.stop();
        screenRef.current?.getTracks().forEach(t => t.stop());
        screenRef.current = null;
        setSharing(false);
        send('share', { on: false, id: screenCarrierRef.current?.id });
    }

    // Point the video elements at the right streams whenever something changes
    useEffect(() => {
        const streams = remoteVideoStreams.current;
        const assign = (el: HTMLVideoElement | null, stream: MediaStream | undefined) => {
            if (!el) return;
            const next = stream ?? null;
            if ((el.srcObject ?? null) !== next) { el.srcObject = next; if (next) el.play().catch(() => {}); }
        };
        const first = streams.values().next().value as MediaStream | undefined; // fallback for older tabs without ids
        assign(screenElRef.current, remoteScreenIdRef.current ? streams.get(remoteScreenIdRef.current) : (remoteSharing && !remoteCam ? first : undefined));
        assign(camElRef.current, remoteCamIdRef.current ? streams.get(remoteCamIdRef.current) : undefined);
        assign(localCamElRef.current, camRef.current ?? undefined);
    }, [trackVersion, remoteSharing, remoteCam, localCam, phase]);

    const videoMode = localCam || remoteCam;
    // The camera button belongs to video calls: started as one, answered as one, or once a camera was on
    const isVideoCall = startedVideo || incomingVideo || sawCam || videoMode;
    useEffect(() => { if (localCam || remoteCam) setSawCam(true); }, [localCam, remoteCam]);
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
    const ss = String(seconds % 60).padStart(2, '0');
    const inCall = phase === 'connecting' || phase === 'active';

    return (
        <CallContext.Provider value={{ phase, startCall, muted, deafened, toggleMute, toggleDeafen }}>
            {children}

            {notice && <div className="call-toast" onClick={() => setNotice(null)}>{notice}</div>}

            {/* Always mounted so the remote audio keeps playing */}
            <audio ref={audioElRef} autoPlay />
            <video ref={screenElRef} className={remoteSharing && inCall ? 'call-remote-video' : 'call-hidden'} autoPlay playsInline muted />

            {phase === 'ringing' && peer && (
                <div className="call-card call-incoming">
                    <Avatar name={peer.username} color={peer.avatarColor} src={peer.avatarUrl} size="lg" />
                    <div className="call-title">{peer.username}</div>
                    <div className="call-sub">{incomingVideo ? 'is video calling you…' : 'is calling you…'}</div>
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
                    <div className="call-sub">{localCam ? 'Video calling…' : 'Calling…'}</div>
                    <div className="call-buttons">
                        <button className="call-btn call-btn-end" onClick={() => endCall()}>Cancel</button>
                    </div>
                </div>
            )}

            {inCall && peer && (
                <div className={`call-card call-active ${remoteSharing ? 'call-with-video' : ''} ${videoMode ? 'call-video' : ''}`}>
                    <div className="call-status">
                        {phase === 'active' ? `${mm}:${ss}` : 'Connecting…'}
                        {remoteSharing && ' · Watching their screen'}
                        {sharing && ' · You are sharing your screen'}
                    </div>
                    {videoMode ? (
                        <div className="call-stage">
                            <div className={`call-stage-main ${remoteSpeaking ? 'speaking' : ''}`}>
                                <video ref={camElRef} className="call-stage-video" autoPlay playsInline muted style={{ display: remoteCam ? 'block' : 'none' }} />
                                {!remoteCam && (
                                    <div className="call-stage-placeholder">
                                        <Avatar name={peer.username} color={peer.avatarColor} src={peer.avatarUrl} size="xl" />
                                    </div>
                                )}
                                <span className="call-stage-name">{peer.username}</span>
                            </div>
                            {localCam && <video ref={localCamElRef} className="call-stage-pip" autoPlay playsInline muted />}
                        </div>
                    ) : (
                    <div className="call-participants">
                        <div className={`call-person ${remoteSpeaking ? 'speaking' : ''}`}>
                            <div className="call-avatar-ring">
                                <Avatar name={peer.username} color={peer.avatarColor} src={peer.avatarUrl} size="md" />
                            </div>
                            <span>{peer.username}</span>
                        </div>
                        <div className={`call-person ${localSpeaking && !muted && !deafened ? 'speaking' : ''}`}>
                            <div className="call-avatar-ring">
                                <Avatar name={user!.username} color={user!.avatarColor} src={user!.avatarUrl} size="md" />
                            </div>
                            <span>You{muted || deafened ? ' (muted)' : ''}</span>
                        </div>
                    </div>
                    )}
                    <div className="call-buttons">
                        <button
                            className={`call-icon-btn ${muted || deafened || !hasMic ? 'is-off' : ''}`}
                            onClick={toggleMute}
                            disabled={!hasMic}
                            title={!hasMic ? 'No microphone' : muted || deafened ? 'Unmute' : 'Mute'}
                            aria-label={muted || deafened || !hasMic ? 'Unmute microphone' : 'Mute microphone'}
                        >
                            {muted || deafened || !hasMic ? <MicOffIcon size={20} /> : <MicIcon size={20} />}
                        </button>
                        {isVideoCall && (
                            <button
                                className={`call-icon-btn ${localCam ? '' : 'is-off'}`}
                                onClick={toggleCamera}
                                disabled={phase !== 'active'}
                                title={localCam ? 'Turn the camera off' : 'Turn the camera on'}
                                aria-label={localCam ? 'Turn the camera off' : 'Turn the camera on'}
                            >
                                {localCam ? <VideoIcon size={20} /> : <VideoOffIcon size={20} />}
                            </button>
                        )}
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
