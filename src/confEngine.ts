// Conference (group) call engine. Everybody in the call has a direct connection to everybody else, so
// audio, camera and screen go straight from person to person. The server only keeps the list of who is in
// and passes the connection messages along (see the /api/conferences routes).
import { api } from './api';
import type { CallSignal, User } from './api';

const RTC_CONFIG: RTCConfiguration = {
    iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }],
};
const MISSING_ROUNDS = 3; // a person missing from the list this many times in a row has left

export interface ConfPeerView {
    id: number;
    user: User;
    connected: boolean;
    camOn: boolean;
    screenOn: boolean;
    speaking: boolean;
    muted: boolean;
}

export interface ConfView {
    groupId: number;
    /** the voice channel this call happens in */
    roomId: number;
    groupName: string;
    startedAt: number;
    peers: ConfPeerView[];
    localCam: boolean;
    localSharing: boolean;
    localSpeaking: boolean;
    hasMic: boolean;
    version: number; // changes whenever a stream arrives, so tiles pick it up
}

interface Peer {
    id: number;
    user: User;
    pc: RTCPeerConnection;
    polite: boolean;
    making: boolean;
    ignore: boolean;
    pendingIce: RTCIceCandidateInit[];
    audio: MediaStream;
    audioEl: HTMLAudioElement;
    video: Map<string, MediaStream>;
    camId: string | null;
    screenId: string | null;
    camOn: boolean;
    screenOn: boolean;
    muted: boolean;
    speaking: boolean;
    connected: boolean;
    camSender: RTCRtpSender | null;
    screenSender: RTCRtpSender | null;
    stopMeter: (() => void) | null;
    /** our microphone, camera and screen are already attached to this connection */
    localAdded: boolean;
    missing: number;
}

/** Calls onChange(true/false) when the audio in the stream is loud enough to count as speaking. */
export function watchSpeaking(stream: MediaStream, onChange: (speaking: boolean) => void): () => void {
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
        const now = Date.now();
        if (Math.sqrt(sum / buf.length) > 0.02) lastLoud = now;
        const next = now - lastLoud < 350;
        if (next !== speaking) { speaking = next; onChange(next); }
    }, 100);
    return () => { clearInterval(iv); ctx.close().catch(() => {}); onChange(false); };
}

export class ConfEngine {
    active = false;
    groupId = 0;
    roomId = 0;
    groupName = '';
    startedAt = 0;
    private me: User;
    private peers = new Map<number, Peer>();
    private mic: MediaStream | null = null;
    private cam: MediaStream | null = null;
    private screen: MediaStream | null = null;
    private camCarrier = new MediaStream(); // only its id matters: it tells viewers which stream is the camera
    private screenCarrier = new MediaStream();
    private muted = false;
    private deafened = false;
    private hasMic = true;
    private localSpeaking = false;
    private stopLocalMeter: (() => void) | null = null;
    private version = 0;

    onChange: () => void = () => {};
    onNotice: (message: string) => void = () => {};
    onEnded: () => void = () => {};

    constructor(me: User) { this.me = me; }

    // Set localStorage.velcord_debug = '1' to see the connection steps in the console
    private log(...a: unknown[]) { try { if (localStorage.getItem('velcord_debug')) console.log('[conf ' + this.me.username + ']', ...a); } catch { /* storage unavailable */ } }

    // ------------------------------------------------------------------ joining and leaving

    async start(roomId: number, groupId: number, groupName: string, opts: { video?: boolean; ring?: boolean } = {}) {
        this.roomId = roomId;
        this.groupId = groupId;
        this.groupName = groupName;
        await this.getMic();
        if (opts.video) await this.getCamera();
        try {
            const r = await api.confJoin(roomId, !!opts.video, !!opts.ring);
            this.active = true;
            this.startedAt = Date.now();
            for (const p of r.roster) if (p.id !== this.me.id) this.addPeer(p as User, true);
        } catch (e) {
            this.releaseMedia();
            throw e;
        }
        this.emit();
    }

    /** Registers again after the server forgot us (for example after the computer slept). */
    async rejoin() {
        try { await api.confJoin(this.roomId, false); if (this.screen) api.confShare(this.roomId, true).catch(() => {}); } catch { /* try again on the next round */ }
    }

    async leave(notifyServer = true) {
        if (!this.active) return;
        this.active = false;
        if (notifyServer) api.confLeave(this.roomId).catch(() => {}).finally(() => window.dispatchEvent(new Event('velcord:call-left')));
        for (const id of Array.from(this.peers.keys())) this.removePeer(id, false);
        this.releaseMedia();
        this.onEnded();
    }

    private releaseMedia() {
        this.stopLocalMeter?.(); this.stopLocalMeter = null;
        for (const s of [this.mic, this.cam, this.screen]) s?.getTracks().forEach(t => t.stop());
        this.mic = this.cam = this.screen = null;
    }

    // ------------------------------------------------------------------ local media

    private async getMic() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
            this.mic = stream;
            this.hasMic = true;
            stream.getAudioTracks().forEach(t => { t.enabled = !(this.muted || this.deafened); });
            this.stopLocalMeter = watchSpeaking(stream, v => { this.localSpeaking = v; this.emit(); });
        } catch (e: any) {
            this.mic = null;
            this.hasMic = false;
            this.onNotice(e?.name === 'NotAllowedError'
                ? 'Microphone permission was denied. You can still listen and watch.'
                : 'No microphone found. You can still listen and watch.');
        }
    }

    private async getCamera(): Promise<boolean> {
        try {
            this.cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24 } }, audio: false });
            return true;
        } catch (e: any) {
            this.cam = null;
            this.onNotice(e?.name === 'NotAllowedError'
                ? 'Camera permission was denied. Allow it in your browser or system settings and try again.'
                : e?.name === 'NotFoundError' ? 'No camera found.' : 'Could not access the camera.');
            return false;
        }
    }

    setAudio(muted: boolean, deafened: boolean) {
        const micChanged = this.muted !== muted || this.deafened !== deafened;
        this.muted = muted;
        this.deafened = deafened;
        this.mic?.getAudioTracks().forEach(t => { t.enabled = !(muted || deafened); });
        for (const p of this.peers.values()) p.audioEl.muted = deafened;
        if (micChanged && this.active) this.broadcast('conf-mute', { on: muted || deafened });
        this.emit();
    }

    async toggleCamera() {
        if (this.cam) { this.stopCamera(); return; }
        if (!(await this.getCamera())) return;
        const track = this.cam!.getVideoTracks()[0];
        try { track.contentHint = 'motion'; } catch { /* unsupported */ }
        track.onended = () => { if (this.cam) this.stopCamera(); };
        for (const p of this.peers.values()) this.publishCam(p);
        this.emit();
    }

    private stopCamera() {
        for (const p of this.peers.values()) p.camSender?.replaceTrack(null).catch(() => {});
        this.cam?.getTracks().forEach(t => t.stop());
        this.cam = null;
        this.broadcast('conf-cam', { on: false, id: this.camCarrier.id });
        this.emit();
    }

    async startShare() {
        if (this.screen) return;
        let stream: MediaStream | null = null;
        try {
            stream = await navigator.mediaDevices.getDisplayMedia({
                video: { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate: { ideal: 30, max: 30 } },
                audio: false,
            });
        } catch (e: any) {
            this.onNotice(e?.name === 'NotAllowedError' || e?.name === 'AbortError' ? 'Screen sharing was cancelled.' : (e?.message || 'Could not share the screen.'));
            return;
        }
        const track = stream.getVideoTracks()[0];
        try { track.contentHint = 'detail'; } catch { /* unsupported */ }
        track.onended = () => this.stopShare();
        this.screen = stream;
        api.confShare(this.roomId, true).catch(() => {});
        for (const p of this.peers.values()) this.publishScreen(p);
        this.emit();
    }

    stopShare() {
        if (!this.screen) return;
        for (const p of this.peers.values()) p.screenSender?.replaceTrack(null).catch(() => {});
        this.screen.getTracks().forEach(t => t.stop());
        this.screen = null;
        api.confShare(this.roomId, false).catch(() => {});
        this.broadcast('conf-share', { on: false, id: this.screenCarrier.id });
        this.emit();
    }

    private publishCam(p: Peer) {
        const track = this.cam?.getVideoTracks()[0];
        if (!track) return;
        if (p.camSender) {
            p.camSender.replaceTrack(track).then(() => this.signal(p.id, 'conf-cam', { on: true, id: this.camCarrier.id })).catch(() => {});
        } else {
            // 700 kbit/s per person: with five others that is still a light upload
            const tr = p.pc.addTransceiver(track, { direction: 'sendonly', streams: [this.camCarrier], sendEncodings: [{ maxBitrate: 700_000, maxFramerate: 24 }] });
            p.camSender = tr.sender;
            setTimeout(() => { if (this.cam && this.peers.get(p.id) === p) this.signal(p.id, 'conf-cam', { on: true, id: this.camCarrier.id }); }, 700);
        }
    }

    private publishScreen(p: Peer) {
        const track = this.screen?.getVideoTracks()[0];
        if (!track) return;
        if (p.screenSender) {
            p.screenSender.replaceTrack(track).then(() => this.signal(p.id, 'conf-share', { on: true, id: this.screenCarrier.id })).catch(() => {});
        } else {
            const tr = p.pc.addTransceiver(track, { direction: 'sendonly', streams: [this.screenCarrier], sendEncodings: [{ maxBitrate: 2_000_000, maxFramerate: 30 }] });
            p.screenSender = tr.sender;
            setTimeout(() => { if (this.screen && this.peers.get(p.id) === p) this.signal(p.id, 'conf-share', { on: true, id: this.screenCarrier.id }); }, 700);
        }
    }

    // ------------------------------------------------------------------ people

    private addPeer(user: User, initiator: boolean): Peer {
        const existing = this.peers.get(user.id);
        if (existing) return existing;
        const pc = new RTCPeerConnection(RTC_CONFIG);
        const audioEl = document.createElement('audio');
        audioEl.autoplay = true;
        audioEl.muted = this.deafened;
        audioEl.className = 'conf-audio';
        audioEl.style.display = 'none';
        document.body.appendChild(audioEl); // in the page, so the browser treats it like any playing media
        const peer: Peer = {
            id: user.id, user, pc, polite: this.me.id > user.id, making: false, ignore: false, pendingIce: [],
            audio: new MediaStream(), audioEl, video: new Map(), camId: null, screenId: null,
            camOn: false, screenOn: false, muted: false, speaking: false, connected: false,
            camSender: null, screenSender: null, stopMeter: null, localAdded: false, missing: 0,
        };
        this.peers.set(user.id, peer);

        pc.onicecandidate = e => { if (e.candidate) this.signal(peer.id, 'conf-ice', e.candidate.toJSON()); };
        pc.onnegotiationneeded = async () => {
            try {
                peer.making = true;
                await pc.setLocalDescription();
                this.signal(peer.id, 'conf-desc', pc.localDescription);
            } catch { /* the next change tries again */ } finally { peer.making = false; }
        };
        pc.ontrack = e => {
            if (e.track.kind === 'audio') {
                if (!peer.audio.getTracks().includes(e.track)) peer.audio.addTrack(e.track);
                if (peer.audioEl.srcObject !== peer.audio) { peer.audioEl.srcObject = peer.audio; peer.audioEl.play().catch(() => {}); }
                if (!peer.stopMeter) peer.stopMeter = watchSpeaking(new MediaStream([e.track]), v => { peer.speaking = v; this.emit(); });
            } else {
                const st = e.streams[0] ?? new MediaStream([e.track]);
                peer.video.set(st.id, st);
            }
            try { (e.receiver as any).jitterBufferTarget = 0; } catch { /* unsupported */ }
            this.version++;
            this.emit();
        };
        pc.onconnectionstatechange = () => {
            peer.connected = pc.connectionState === 'connected';
            this.log('connection to', peer.user.username, pc.connectionState);
            if (pc.connectionState === 'failed') { try { pc.restartIce(); } catch { /* ignore */ } }
            this.emit();
        };

        if (initiator) {
            if (this.mic) this.mic.getTracks().forEach(t => pc.addTrack(t, this.mic!));
            else pc.addTransceiver('audio', { direction: 'recvonly' });
            if (this.cam) this.publishCam(peer);
            if (this.screen) this.publishScreen(peer);
            peer.localAdded = true; // we started this connection, so everything of ours is already on it
        }
        // Tell the new person what we are doing right now
        setTimeout(() => {
            if (this.peers.get(peer.id) !== peer) return;
            if (this.muted || this.deafened) this.signal(peer.id, 'conf-mute', { on: true });
        }, 900);
        this.emit();
        return peer;
    }

    private removePeer(id: number, notify = true) {
        const p = this.peers.get(id);
        if (!p) return;
        this.peers.delete(id);
        p.stopMeter?.();
        try { p.pc.close(); } catch { /* already closed */ }
        p.audioEl.srcObject = null;
        p.audioEl.remove();
        if (notify) this.emit();
    }

    /** The server's list of who is in the call. Anyone who stays missing from it has left. */
    onRoster(roster: User[]) {
        if (!this.active) return;
        const ids = new Set(roster.map(r => r.id));
        for (const [id, p] of Array.from(this.peers)) {
            if (ids.has(id)) { p.missing = 0; continue; }
            if (++p.missing >= MISSING_ROUNDS) this.removePeer(id);
        }
        // Nobody else is left: that is the end of the call for the last person, but they stay until they hang up
        this.emit();
    }

    // ------------------------------------------------------------------ messages from the other side

    async onSignal(sig: CallSignal) {
        if (!this.active) return;
        const from = sig.from;
        const payload = sig.payload ? JSON.parse(sig.payload) : null;
        this.log('got', sig.type, '<-', from.username, sig.type === 'conf-desc' ? payload?.type : '');
        if (sig.type === 'conf-desc') {
            try { await this.onDescription(from, payload as RTCSessionDescriptionInit); }
            catch (e) { console.warn('[conf] could not apply the connection message from', from.username, e); }
            return;
        }
        const peer = this.peers.get(from.id);
        if (!peer) return;
        switch (sig.type) {
            case 'conf-ice': {
                if (!payload) return;
                if (!peer.pc.remoteDescription) { peer.pendingIce.push(payload); return; }
                try { await peer.pc.addIceCandidate(payload); } catch { /* ignore stale candidates */ }
                break;
            }
            case 'conf-cam': peer.camOn = !!payload?.on; if (payload?.id) peer.camId = String(payload.id); this.version++; this.emit(); break;
            case 'conf-share': peer.screenOn = !!payload?.on; if (payload?.id) peer.screenId = String(payload.id); this.version++; this.emit(); break;
            case 'conf-mute': peer.muted = !!payload?.on; this.emit(); break;
        }
    }

    private async onDescription(from: User, desc: RTCSessionDescriptionInit | null) {
        if (!desc) return;
        let peer = this.peers.get(from.id);
        if (!peer) {
            if (desc.type !== 'offer') return;
            peer = this.addPeer(from, false); // somebody who joined after us calls us
        }
        const pc = peer.pc;
        const collision = desc.type === 'offer' && (peer.making || pc.signalingState !== 'stable');
        peer.ignore = !peer.polite && collision;
        this.log('desc', desc.type, 'from', from.username, 'state', pc.signalingState, 'making', peer.making, 'polite', peer.polite, peer.ignore ? 'IGNORED' : '');
        if (peer.ignore) return;
        await pc.setRemoteDescription(desc);
        for (const c of peer.pendingIce.splice(0)) { try { await pc.addIceCandidate(c); } catch { /* ignore */ } }
        if (desc.type === 'offer') {
            const first = !peer.localAdded;
            peer.localAdded = true;
            if (first && this.mic) this.mic.getTracks().forEach(t => pc.addTrack(t, this.mic!)); // reuses the audio line from the offer
            await pc.setLocalDescription();
            this.signal(peer.id, 'conf-desc', pc.localDescription);
            if (first) {
                if (this.cam) this.publishCam(peer);
                if (this.screen) this.publishScreen(peer);
            }
        }
    }

    // ------------------------------------------------------------------ helpers for the screen

    streamFor(peerId: number, kind: 'cam' | 'screen'): MediaStream | null {
        const p = this.peers.get(peerId);
        if (!p) return null;
        const id = kind === 'cam' ? p.camId : p.screenId;
        return id ? (p.video.get(id) ?? null) : null;
    }
    localCamStream() { return this.cam; }

    private signal(to: number, type: string, payload?: unknown) {
        this.log('send', type, '->', this.peers.get(to)?.user.username ?? to, type === 'conf-desc' ? (payload as any)?.type : '');
        api.callSignal(to, type, payload, this.roomId).catch(() => {});
    }
    private broadcast(type: string, payload?: unknown) {
        for (const id of this.peers.keys()) this.signal(id, type, payload);
    }

    view(): ConfView {
        return {
            groupId: this.groupId,
            roomId: this.roomId,
            groupName: this.groupName,
            startedAt: this.startedAt,
            peers: Array.from(this.peers.values()).map(p => ({
                id: p.id, user: p.user, connected: p.connected, camOn: p.camOn, screenOn: p.screenOn, speaking: p.speaking, muted: p.muted,
            })),
            localCam: !!this.cam,
            localSharing: !!this.screen,
            localSpeaking: this.localSpeaking && !this.muted && !this.deafened,
            hasMic: this.hasMic,
            version: this.version,
        };
    }
    private emit() { if (this.active || this.peers.size) this.onChange(); }
}
