import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import './conference.css';
import { api } from './api';
import type { CallSignal, User } from './api';
import { useAuth } from './AuthContext';
import { useCall } from './CallContext';
import { callBusy } from './callBusy';
import { ConfEngine } from './confEngine';
import type { ConfView, ConfPeerView } from './confEngine';
import { notify } from './notify';
import { startRinging } from './ringtones';
import { onLive } from './live';
import Avatar from './components/Avatar';
import { MicIcon, MicOffIcon, VideoIcon, VideoOffIcon, PhoneIcon } from './components/Icons';

const RING_TIMEOUT_MS = 45_000;
const INVITE_MAX_AGE_S = 45;

interface Incoming { roomId: number; groupId: number; groupName: string; channelName: string; from: User; video: boolean }

interface JoinOptions { groupId: number; groupName: string; channelName?: string; video?: boolean; ring?: boolean }

interface ConferenceValue {
    /** The group whose call I am in, or null */
    activeGroupId: number | null;
    /** The voice channel I am in, or null */
    activeRoomId: number | null;
    /** Walk into a voice channel (quiet: it does not ring anybody) */
    join: (roomId: number, opts: JoinOptions) => Promise<void>;
    /** The group's Call / Video buttons: pick the group's voice channel and ring the others when this starts a call */
    startGroupCall: (group: { id: number; name: string }, video?: boolean) => Promise<void>;
    leave: () => void;
    /** the shared screen fills the window (true) or is shrunk to a corner so the chat can be read (false) */
    expanded: boolean;
    setExpanded: (v: boolean) => void;
}

const Ctx = createContext<ConferenceValue>({ activeGroupId: null, activeRoomId: null, join: async () => {}, startGroupCall: async () => {}, leave: () => {}, expanded: true, setExpanded: () => {} });
export const useConference = () => useContext(Ctx);

/** Shows a MediaStream in a <video>; sound comes from separate audio elements, so videos stay muted. */
function TileVideo({ stream, mirrored }: { stream: MediaStream | null; mirrored?: boolean }) {
    const ref = useRef<HTMLVideoElement>(null);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        if ((el.srcObject ?? null) !== stream) { el.srcObject = stream; if (stream) el.play().catch(() => {}); }
    }, [stream]);
    return <video ref={ref} className={`conf-video ${mirrored ? 'mirrored' : ''}`} autoPlay playsInline muted />;
}

function Tile(props: {
    user: User; label: string; speaking: boolean; muted: boolean; stream: MediaStream | null; connecting?: boolean; mirrored?: boolean; note?: string; live?: boolean;
}) {
    const { user, label, speaking, muted, stream, connecting, mirrored, note, live } = props;
    return (
        <div className={`conf-tile ${speaking ? 'speaking' : ''}`}>
            {live && <span className="conf-live">LIVE</span>}
            {stream ? <TileVideo stream={stream} mirrored={mirrored} /> : (
                <div className="conf-placeholder">
                    <Avatar name={user.username} color={user.avatarColor} src={user.avatarUrl ?? undefined} size="xl" />
                    {note && <span className="conf-note">{note}</span>}
                </div>
            )}
            <div className="conf-label">
                {muted && <MicOffIcon size={13} />}
                <span>{label}</span>
                {connecting && <span className="conf-connecting">connecting…</span>}
            </div>
        </div>
    );
}

export function ConferenceProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    const { muted, deafened, toggleMute } = useCall();
    const [view, setView] = useState<ConfView | null>(null);
    const [incoming, setIncoming] = useState<Incoming | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [seconds, setSeconds] = useState(0);
    const [expanded, setExpanded] = useState(true);
    const engine = useRef<ConfEngine | null>(null);
    const lastId = useRef<number | null>(null);
    const queue = useRef<Promise<void>>(Promise.resolve());
    const incomingRef = useRef<Incoming | null>(null);
    incomingRef.current = incoming;

    const refresh = useCallback(() => { if (engine.current) setView(engine.current.view()); }, []);

    const leave = useCallback(() => {
        const e = engine.current;
        if (!e) return;
        e.leave();
    }, []);

    const join = useCallback(async (roomId: number, opts: JoinOptions) => {
        if (!user || engine.current?.active) return;
        if (callBusy.oneToOne) { setNotice('Hang up your call first.'); return; }
        setIncoming(null);
        setExpanded(true);
        const e = new ConfEngine(user);
        e.onChange = refresh;
        e.onNotice = setNotice;
        e.onEnded = () => { callBusy.conference = false; engine.current = null; setView(null); setSeconds(0); };
        engine.current = e;
        callBusy.conference = true;
        try {
            await e.start(roomId, opts.groupId, opts.channelName ? `${opts.groupName} · ${opts.channelName}` : opts.groupName, { video: opts.video, ring: opts.ring });
            e.setAudio(muted, deafened);
            refresh();
        } catch (err: any) {
            callBusy.conference = false;
            engine.current = null;
            setView(null);
            setNotice(err?.message || 'Could not join the call');
        }
    }, [user, refresh, muted, deafened]);

    const startGroupCall = useCallback(async (group: { id: number; name: string }, video = false) => {
        try {
            const v = await api.defaultVoice(group.id);
            await join(v.id, { groupId: group.id, groupName: group.name, channelName: v.name, video, ring: true });
        } catch (err: any) {
            setNotice(err?.message || 'Could not start the call');
        }
    }, [join]);

    // The sidebar mute / deafen buttons also control the mic in a conference
    useEffect(() => { engine.current?.setAudio(muted, deafened); }, [muted, deafened]);

    // Talking to the server: new calls arrive here, and during a call the list of who is in
    useEffect(() => {
        if (!user) return;
        let stopped = false;
        let timer: number;
        let busy = false;
        let silent = 0;
        const handle = (sig: CallSignal, serverNow: number) => {
            if (sig.type === 'conf-invite' && sig.conf) {
                if (serverNow - sig.createdAt > INVITE_MAX_AGE_S) return;
                if (engine.current?.active || callBusy.oneToOne || incomingRef.current) return;
                let p: any = {};
                try { p = JSON.parse(sig.payload || '{}'); } catch { /* keep defaults */ }
                setIncoming({ roomId: sig.conf, groupId: Number(p.groupId) || 0, groupName: p.groupName || 'Group', channelName: p.channelName || '', from: sig.from, video: !!p.video });
                return;
            }
            const e = engine.current;
            if (e?.active && sig.conf === e.roomId && sig.type.startsWith('conf-')) {
                queue.current = queue.current.then(() => e.onSignal(sig)).catch(() => {});
            }
        };
        const tick = async () => {
            if (busy) return;
            busy = true;
            const e = engine.current;
            const gid = e?.active ? e.roomId : undefined;
            try {
                if (lastId.current === null) {
                    const init = await api.callPoll(-1);
                    lastId.current = init.lastId ?? 0;
                } else {
                    const res = await api.callPoll(lastId.current, gid);
                    for (const sig of res.signals) {
                        lastId.current = Math.max(lastId.current, sig.id);
                        if (sig.type.startsWith('conf-')) handle(sig, res.now);
                    }
                    if (gid && e) {
                        if (res.roster) { silent = 0; e.onRoster(res.roster as User[]); }
                        else if (++silent >= 3) { silent = 0; e.rejoin(); }
                    }
                }
            } catch { /* offline: try again */ }
            busy = false;
            clearTimeout(timer);
            if (!stopped) timer = window.setTimeout(tick, engine.current?.active ? 500 : 3000);
        };
        tick();
        const off = onLive(tick);
        return () => { stopped = true; clearTimeout(timer); off(); };
    }, [user]);

    // Ringing for a call somebody started in one of my groups
    useEffect(() => {
        if (!incoming) return;
        const stopSound = startRinging(true);
        const toast = document.hasFocus() ? null : notify(`${incoming.groupName}`, `${incoming.from.username} started a ${incoming.video ? 'video ' : ''}call`, { tag: 'velcord-conf', requireInteraction: true });
        const t = window.setTimeout(() => setIncoming(null), RING_TIMEOUT_MS);
        return () => { stopSound(); toast?.close(); clearTimeout(t); };
    }, [incoming]);

    useEffect(() => {
        if (!view) return;
        const started = view.startedAt;
        const t = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
        return () => clearInterval(t);
    }, [view?.startedAt]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!notice) return;
        const t = setTimeout(() => setNotice(null), 5000);
        return () => clearTimeout(t);
    }, [notice]);

    // Closing the tab leaves the call
    useEffect(() => {
        const bye = () => {
            const e = engine.current;
            const token = localStorage.getItem('velcord_token');
            if (e?.active && token) {
                fetch(`${import.meta.env.VITE_API_URL || ''}/api/voice/${e.roomId}/leave`, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' }).catch(() => {});
            }
        };
        window.addEventListener('beforeunload', bye);
        return () => window.removeEventListener('beforeunload', bye);
    }, []);

    const e = engine.current;
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
    const ss = String(seconds % 60).padStart(2, '0');
    const sharer: ConfPeerView | undefined = view?.peers.find(p => p.screenOn);
    const tiles = view ? view.peers.length + 1 : 0;

    return (
        <Ctx.Provider value={{ activeGroupId: view ? view.groupId : null, activeRoomId: view ? view.roomId : null, join, startGroupCall, leave, expanded, setExpanded }}>
            {children}

            {notice && <div className="call-toast" onClick={() => setNotice(null)}>{notice}</div>}

            {incoming && !view && (
                <div className="call-card call-incoming conf-ring">
                    <Avatar name={incoming.from.username} color={incoming.from.avatarColor} src={incoming.from.avatarUrl ?? undefined} size="lg" />
                    <div className="call-title">{incoming.groupName}{incoming.channelName ? ` · ${incoming.channelName}` : ''}</div>
                    <div className="call-sub">{incoming.from.username} started a {incoming.video ? 'video ' : ''}group call</div>
                    <div className="call-buttons">
                        <button className="call-btn call-btn-accept" onClick={() => join(incoming.roomId, { groupId: incoming.groupId, groupName: incoming.groupName, channelName: incoming.channelName, video: incoming.video })}>Join</button>
                        <button className="call-btn call-btn-end" onClick={() => setIncoming(null)}>Not now</button>
                    </div>
                </div>
            )}

            {view && e && (
                <div className={`conf-window ${sharer && expanded ? 'has-share' : ''} ${sharer && !expanded ? 'mini' : ''}`}>
                    <div className="conf-head">
                        <span className="conf-title">{view.groupName}</span>
                        <span className="conf-meta">{tiles} in the call · {mm}:{ss}</span>
                        {sharer && <button type="button" className="conf-size" onClick={() => setExpanded(!expanded)} title={expanded ? 'Make it smaller to read the chat' : 'Show the shared screen big'}>{expanded ? 'Smaller' : 'Bigger'}</button>}
                    </div>

                    <div className="conf-stage">
                        {sharer && (
                            <div className="conf-share">
                                <TileVideo stream={e.streamFor(sharer.id, 'screen')} />
                                <div className="conf-label"><span>{sharer.user.username} is sharing their screen</span></div>
                            </div>
                        )}
                        <div className={`conf-grid n${Math.min(tiles, 6)}`}>
                            {user && (
                                <Tile
                                    user={user} label="You" speaking={view.localSpeaking} muted={muted || deafened || !view.hasMic}
                                    stream={view.localCam ? e.localCamStream() : null} mirrored
                                    note={view.localSharing ? 'You are sharing your screen' : undefined} live={view.localSharing}
                                />
                            )}
                            {view.peers.map(p => (
                                <Tile
                                    key={p.id} user={p.user} label={p.user.username} speaking={p.speaking} muted={p.muted}
                                    stream={p.camOn ? e.streamFor(p.id, 'cam') : null} connecting={!p.connected} live={p.screenOn}
                                />
                            ))}
                        </div>
                        {view.peers.length === 0 && <div className="conf-alone">Waiting for others to join…</div>}
                    </div>

                    <div className="conf-controls">
                        <button
                            className={`call-icon-btn ${muted || deafened || !view.hasMic ? 'is-off' : ''}`}
                            onClick={toggleMute} disabled={!view.hasMic}
                            title={!view.hasMic ? 'No microphone' : muted || deafened ? 'Unmute' : 'Mute'}
                            aria-label={muted || deafened ? 'Unmute microphone' : 'Mute microphone'}
                        >
                            {muted || deafened || !view.hasMic ? <MicOffIcon size={20} /> : <MicIcon size={20} />}
                        </button>
                        <button
                            className={`call-icon-btn ${view.localCam ? '' : 'is-off'}`}
                            onClick={() => e.toggleCamera()}
                            title={view.localCam ? 'Turn the camera off' : 'Turn the camera on'}
                            aria-label={view.localCam ? 'Turn the camera off' : 'Turn the camera on'}
                        >
                            {view.localCam ? <VideoIcon size={20} /> : <VideoOffIcon size={20} />}
                        </button>
                        {view.localSharing
                            ? <button className="call-btn call-btn-on" onClick={() => e.stopShare()}>Stop sharing</button>
                            : <button className="call-btn" onClick={() => e.startShare()}>Share screen</button>}
                        <button className="call-btn call-btn-end conf-leave" onClick={leave}><PhoneIcon size={16} /> Leave</button>
                    </div>
                </div>
            )}
        </Ctx.Provider>
    );
}
