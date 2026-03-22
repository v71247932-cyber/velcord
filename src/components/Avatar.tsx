interface AvatarProps {
    name: string;
    color: string;
    size?: 'sm' | 'md' | 'lg';
}

export default function Avatar({ name, color, size = 'md' }: AvatarProps) {
    const letter = name.charAt(0).toUpperCase();
    return (
        <div
            className={`avatar avatar-${size}`}
            style={{ background: color }}
            title={name}
        >
            {letter}
        </div>
    );
}
