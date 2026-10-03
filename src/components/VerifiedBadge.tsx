/** Blue tick shown next to the official Velcord account. */
export default function VerifiedBadge({ size = 15 }: { size?: number }) {
    return (
        <span className="verified-badge" title="Official Velcord account" aria-label="Verified">
            <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 1.8l2.5 1.9 3.1-.2 1.1 2.9 2.6 1.7-.8 3 .8 3-2.6 1.7-1.1 2.9-3.1-.2-2.5 1.9-2.5-1.9-3.1.2-1.1-2.9-2.6-1.7.8-3-.8-3 2.6-1.7 1.1-2.9 3.1.2L12 1.8z" fill="#3b9eff" />
                <path d="M8.2 12.3l2.6 2.6 5-5.4" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        </span>
    );
}
