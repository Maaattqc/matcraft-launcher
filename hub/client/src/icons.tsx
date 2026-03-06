import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const I = (props: P & { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
    strokeLinecap="round" strokeLinejoin="round" width={18} height={18} {...props}>
    {props.children}
  </svg>
);

export const IconPanel = (p: P) => <I {...p}><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></I>;
export const IconFolder = (p: P) => <I {...p}><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></I>;
export const IconGlobe = (p: P) => <I {...p}><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></I>;
export const IconShield = (p: P) => <I {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></I>;
export const IconCloud = (p: P) => <I {...p}><path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/></I>;
export const IconPlay = (p: P) => <I {...p}><polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none"/></I>;
export const IconStop = (p: P) => <I {...p}><rect x="6" y="6" width="12" height="12" rx="1"/></I>;
export const IconRefresh = (p: P) => <I {...p}><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></I>;
export const IconOpen = (p: P) => <I {...p}><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></I>;
export const IconClock = (p: P) => <I {...p} width={12} height={12}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></I>;
export const IconMemory = (p: P) => <I {...p} width={12} height={12}><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/></I>;
export const IconSun = (p: P) => <I {...p} width={16} height={16}><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></I>;
export const IconMoon = (p: P) => <I {...p} width={16} height={16}><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></I>;

export const SERVICE_ICONS: Record<string, (p: P) => React.ReactElement> = {
  panel: IconPanel,
  sftp: IconFolder,
  website: IconGlobe,
  nginx: IconShield,
  cloudflared: IconCloud,
};
