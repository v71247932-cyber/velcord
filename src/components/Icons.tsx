import type { ReactNode } from 'react';

interface IconProps { size?: number; className?: string }

function Svg({ size = 18, className, children }: IconProps & { children: ReactNode }) {
    return (
        <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {children}
        </svg>
    );
}

export const PhoneIcon = (p: IconProps) => (
    <Svg {...p}><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" /></Svg>
);
export const MessageIcon = (p: IconProps) => (
    <Svg {...p}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" /></Svg>
);
export const UsersIcon = (p: IconProps) => (
    <Svg {...p}><circle cx="9" cy="8" r="3.2" /><path d="M3 20a6 6 0 0 1 12 0" /><circle cx="17" cy="9" r="2.4" /><path d="M16.5 14.2A5 5 0 0 1 21 19" /></Svg>
);
export const UserPlusIcon = (p: IconProps) => (
    <Svg {...p}><circle cx="9" cy="8" r="3.4" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6" /></Svg>
);
export const ImageIcon = (p: IconProps) => (
    <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="1.6" /><path d="m4 18 5-5 4 4 3-3 4 4" /></Svg>
);
export const PlusIcon = (p: IconProps) => (
    <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>
);
export const CloseIcon = (p: IconProps) => (
    <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>
);
export const CheckIcon = (p: IconProps) => (
    <Svg {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Svg>
);
export const HashIcon = (p: IconProps) => (
    <Svg {...p}><path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16" /></Svg>
);
export const CrownIcon = (p: IconProps) => (
    <Svg {...p}><path d="m4 8 4 4 4-6 4 6 4-4-1.5 10h-13L4 8Z" /></Svg>
);
export const VideoIcon = (p: IconProps) => (
    <Svg {...p}><rect x="2.5" y="6" width="13" height="12" rx="3" /><path d="m15.5 10.5 6-3.5v10l-6-3.5" /></Svg>
);
export const MicIcon = (p: IconProps) => (
    <Svg {...p}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></Svg>
);
export const MicOffIcon = (p: IconProps) => (
    <Svg {...p}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18" /></Svg>
);
export const VideoOffIcon = (p: IconProps) => (
    <Svg {...p}><rect x="2.5" y="6" width="13" height="12" rx="3" /><path d="m15.5 10.5 6-3.5v10l-6-3.5M3 3l18 18" /></Svg>
);
export const SpeakerIcon = (p: IconProps) => (
    <Svg {...p}><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z" /><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /></Svg>
);
export const EditIcon = (p: IconProps) => (
    <Svg {...p}><path d="m4 20 1-4L16.5 4.5a2 2 0 0 1 3 3L8 19l-4 1Z" /><path d="m14.5 6.5 3 3" /></Svg>
);
export const TrashIcon = (p: IconProps) => (
    <Svg {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></Svg>
);
export const MonitorIcon = (p: IconProps) => (
    <Svg {...p}><rect x="2.5" y="4" width="19" height="12.5" rx="2" /><path d="M8 20.5h8M12 16.5v4" /></Svg>
);
