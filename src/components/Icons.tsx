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
