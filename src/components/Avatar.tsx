interface AvatarProps {
    name: string;
    color: string;
    src?: string;
    size?: 'sm' | 'md' | 'lg';
}

export default function Avatar({ name, color, src, size = 'md' }: AvatarProps) {
    const letter = name.charAt(0).toUpperCase();
    return (
        <div
            className={`avatar avatar-${size}`}
            style={{ background: color, overflow: 'hidden' }}
            title={name}
        >
            {src ? (
                <img src={src} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
                letter
            )}
        </div>
    );
}
