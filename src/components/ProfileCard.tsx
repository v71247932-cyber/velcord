import Avatar from './Avatar';
import type { FriendUser } from '../api';

interface Props {
    friend: FriendUser;
    onCall?: () => void;
    callDisabled?: boolean;
}

/** Profile card shown on the right side of a direct message chat. */
export default function ProfileCard({ friend, onCall, callDisabled }: Props) {
    const online = !!friend.online;
    return (
        <aside className="right-panel profile-aside">
            <div className="profile-card">
                <div className="profile-card-banner" style={{ background: `linear-gradient(135deg, ${friend.avatarColor}, #1e1f22)` }} />
                <div className="profile-card-avatar">
                    <Avatar name={friend.username} color={friend.avatarColor} src={friend.avatarUrl} size="xl" zoomable status={online ? 'online' : 'offline'} />
                </div>
                <div className="profile-card-body">
                    <div className="profile-card-name">{friend.username}</div>
                    <div className={`profile-card-status ${online ? 'is-online' : ''}`}>
                        <span className={`status-dot-inline status-${online ? 'online' : 'offline'}`} />
                        {online ? 'Online' : 'Offline'}
                    </div>
                    {onCall && (
                        <button className="profile-card-call" onClick={onCall} disabled={callDisabled}>
                            📞 Call
                        </button>
                    )}
                </div>
            </div>
        </aside>
    );
}
