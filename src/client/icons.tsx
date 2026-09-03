import type { SVGProps } from 'react'

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'>

function IconBase(props: IconProps & { children: React.ReactNode }): React.JSX.Element {
  const { children, ...rest } = props
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  )
}

export function BuildingIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M4 21V5.8a1 1 0 0 1 .62-.92l8-3.35A1 1 0 0 1 14 2.45V21" />
      <path d="M14 8h5a1 1 0 0 1 1 1v12M8 8h2M8 12h2M8 16h2M17 12h.01M17 16h.01M2 21h20" />
    </IconBase>
  )
}

export function CloseIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </IconBase>
  )
}

export function RefreshIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M20 11a8.1 8.1 0 0 0-14.6-4L3 10" />
      <path d="M3 4v6h6M4 13a8.1 8.1 0 0 0 14.6 4L21 14" />
      <path d="M15 14h6v6" />
    </IconBase>
  )
}

export function ExternalIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" />
    </IconBase>
  )
}

export function ChevronIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="m9 6 6 6-6 6" />
    </IconBase>
  )
}

export function ShieldIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6z" />
      <path d="m9 12 2 2 4-5" />
    </IconBase>
  )
}

export function LoadIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M4 19a8 8 0 1 1 16 0" />
      <path d="m12 11 4-3M6.5 14h.01M17.5 14h.01M12 7v.01" />
    </IconBase>
  )
}

export function ChartIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </IconBase>
  )
}

export function PauseIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M9 5v14M15 5v14" />
    </IconBase>
  )
}

export function PlayIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="m8 5 11 7-11 7z" />
    </IconBase>
  )
}

export function ArchiveIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M4 7h16v13H4zM3 3h18v4H3zM9 11h6" />
    </IconBase>
  )
}

export function CheckIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="m5 12 4 4L19 6" />
    </IconBase>
  )
}

export function TicketIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <path d="M8 8h8" />
      <path d="M8 12h8" />
      <path d="M8 16h5" />
    </IconBase>
  )
}

export function TrashIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6" />
    </IconBase>
  )
}

export function InfoIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </IconBase>
  )
}

export function WarningIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M12 3 2.8 19a1 1 0 0 0 .87 1.5h16.66A1 1 0 0 0 21.2 19z" />
      <path d="M12 9v5M12 17h.01" />
    </IconBase>
  )
}

export function PackageIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M12 3 4 7v10l8 4 8-4V7z" />
      <path d="M4 7l8 4 8-4M12 11v10M8 5l8 4" />
    </IconBase>
  )
}

export function TasksIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M4 6h16M4 12h16M4 18h10" />
      <path d="m3 4 1 1 1.5-1.5M8 3v6" />
    </IconBase>
  )
}

export function WalletIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M15 11h4v4h-4a2 2 0 0 1 0-4zM7 7h2" />
    </IconBase>
  )
}

export function UsersIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20a6 6 0 0 1 12 0M16 4.6a3.5 3.5 0 0 1 0 6.8M17.5 14.6A6 6 0 0 1 21 20" />
    </IconBase>
  )
}
