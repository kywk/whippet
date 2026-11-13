import type { ReactNode } from 'react';

// 單一線寬（1.6）、20px 格線的自繪圖示；全站共用。
function Icon({ children }: { children: ReactNode }) {
  return <svg className="icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}

export const PlusIcon = () => <Icon><path d="M10 4v12M4 10h12" /></Icon>;
export const SearchIcon = () => <Icon><circle cx="9" cy="9" r="5" /><path d="m13 13 3.5 3.5" /></Icon>;
export const ChevronDownIcon = () => <Icon><path d="m5 8 5 5 5-5" /></Icon>;
export const ChevronRightIcon = () => <Icon><path d="m8 5 5 5-5 5" /></Icon>;
export const ArrowRightIcon = () => <Icon><path d="M4 10h12m-5-5 5 5-5 5" /></Icon>;
export const SendIcon = () => <Icon><path d="M10 16V4m-5 5 5-5 5 5" /></Icon>;
export const CheckIcon = () => <Icon><path d="m4.5 10.5 3.5 3.5 7.5-8" /></Icon>;
export const CloseIcon = () => <Icon><path d="m5 5 10 10M15 5 5 15" /></Icon>;
export const ScriptIcon = () => <Icon><path d="m7 6-4 4 4 4m6-8 4 4-4 4M11 4 9 16" /></Icon>;
export const ReportIcon = () => <Icon><path d="M5 3h7l3 3v11H5z" /><path d="M12 3v3h3M8 10h4M8 13h4" /></Icon>;
export const EyeIcon = () => <Icon><path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10Z" /><circle cx="10" cy="10" r="2.2" /></Icon>;
export const BookIcon = () => <Icon><path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H16v12H5.5A1.5 1.5 0 0 0 4 16.5z" /><path d="M4 16.5A1.5 1.5 0 0 0 5.5 18H16" /></Icon>;
export const TrashIcon = () => <Icon><path d="M4 6h12M8 6V4h4v2m-6 0 .6 10h6.8L14 6" /></Icon>;
export const RefreshIcon = () => <Icon><path d="M16 10a6 6 0 1 1-1.8-4.3M16 3.5v3h-3" /></Icon>;
export const ExternalIcon = () => <Icon><path d="M11 4h5v5m0-5-8 8M8 4H4v12h12v-4" /></Icon>;
export const PlayIcon = () => <Icon><path d="M6 4.5v11l9-5.5z" /></Icon>;
export const StopIcon = () => <Icon><rect x="5" y="5" width="10" height="10" rx="1.5" /></Icon>;
export const MicIcon = () => <Icon><rect x="7.5" y="2.5" width="5" height="9" rx="2.5" /><path d="M4.5 9a5.5 5.5 0 0 0 11 0M10 14.5V18" /></Icon>;
export const BellIcon = () => <Icon><path d="M5 14V9a5 5 0 0 1 10 0v5l1.5 1.5h-13zM8.5 17.5h3" /></Icon>;
export const GearIcon = () => <Icon><circle cx="10" cy="10" r="2.5" /><path d="M10 2.5v2m0 11v2M2.5 10h2m11 0h2M4.7 4.7l1.4 1.4m7.8 7.8 1.4 1.4m0-10.6-1.4 1.4M6.1 13.9l-1.4 1.4" /></Icon>;
export const AlertIcon = () => <Icon><path d="M10 3 2.5 16.5h15z" /><path d="M10 8v4m0 2.5v.01" /></Icon>;
export const InfoIcon = () => <Icon><circle cx="10" cy="10" r="7" /><path d="M10 9v4.5m0-7v.01" /></Icon>;
export const LockIcon = () => <Icon><rect x="4.5" y="9" width="11" height="8" rx="1.5" /><path d="M7 9V6.5a3 3 0 0 1 6 0V9" /></Icon>;
export const PanelIcon = () => <Icon><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M12.5 4v12" /></Icon>;
export const SidebarIcon = () => <Icon><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M7.5 4v12" /></Icon>;
export const ExpandIcon = () => <Icon><path d="M12.5 3.5h4v4M16.5 3.5l-4.8 4.8M7.5 16.5h-4v-4M3.5 16.5l4.8-4.8" /></Icon>;
export const CollapseIcon = () => <Icon><path d="M16.5 8h-4.5V3.5M12 8l4.5-4.5M3.5 12H8v4.5M8 12l-4.5 4.5" /></Icon>;
export const MenuIcon = () => <Icon><path d="M3.5 6h13M3.5 10h13M3.5 14h13" /></Icon>;

/** Whippet 標記：三張複寫聯疊成的 W。 */
export function BrandMark({ className = 'brand-mark' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
    <rect x="3" y="7" width="20" height="20" rx="4" fill="#8fb4f0" />
    <rect x="6" y="5" width="20" height="20" rx="4" fill="#f0a6b8" />
    <rect x="9" y="3" width="20" height="20" rx="4" fill="#f4d35e" />
    <path d="m13 9 2.4 9 2.6-6.5 2.6 6.5 2.4-9" fill="none" stroke="#101c52" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}
