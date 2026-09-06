const STYLE_ID = 'dsh-company/client.css'

export const COMPANY_STYLES = String.raw`
/* ============================================================================
 * dsh-company v2 design system
 * A calm, modern "AI software company" console: token-driven, theme-aware,
 * soft cards, pill badges, comfortable typography, generous whitespace.
 * ==========================================================================*/

.dsh-company-button,
.dsh-company-overlay {
  /* palette */
  --dc-accent: var(--dsw-alias-interactive-accent, #3964fe);
  --dc-accent-strong: color-mix(in srgb, var(--dc-accent) 88%, #000 12%);
  --dc-accent-soft: color-mix(in srgb, var(--dc-accent) 10%, transparent);
  --dc-accent-softer: color-mix(in srgb, var(--dc-accent) 6%, transparent);
  --dc-bg: var(--dsw-alias-bg-base, #f4f6fa);
  --dc-surface: var(--dsw-alias-bg-module-platform, #ffffff);
  --dc-surface-2: color-mix(in srgb, var(--dc-surface) 96%, var(--dc-text) 4%);
  --dc-surface-raised: var(--dsw-specific-menu, #ffffff);
  --dc-fill: var(--dsw-alias-fill-l2, rgb(15 23 42 / 5%));
  --dc-fill-strong: var(--dsw-alias-fill-l3, rgb(15 23 42 / 9%));
  --dc-text: var(--dsw-alias-label-primary, #14171c);
  --dc-text-2: var(--dsw-alias-label-secondary, #4b5563);
  --dc-text-3: var(--dsw-alias-label-tertiary, #7b8494);
  --dc-border: var(--dsw-alias-border-l2, rgb(15 23 42 / 10%));
  --dc-border-strong: var(--dsw-alias-border-l3, rgb(15 23 42 / 18%));
  --dc-danger: var(--dsw-alias-danger, #d6404d);
  --dc-danger-soft: color-mix(in srgb, var(--dc-danger) 11%, transparent);
  --dc-warning: #b26a00;
  --dc-warning-soft: color-mix(in srgb, var(--dc-warning) 12%, transparent);
  --dc-success: #148a58;
  --dc-success-soft: color-mix(in srgb, var(--dc-success) 12%, transparent);
  --dc-active-soft: color-mix(in srgb, var(--dc-accent) 11%, transparent);
  --dc-neutral-soft: var(--dc-fill);
  /* shape & elevation */
  --dc-shadow-sm: 0 1px 2px rgb(15 23 42 / 5%);
  --dc-shadow: 0 1px 2px rgb(15 23 42 / 4%), 0 4px 16px rgb(15 23 42 / 6%);
  color: var(--dc-text);
  font-family: var(--dsw-font-family, 'Inter', 'PingFang SC', 'Microsoft YaHei', system-ui, -apple-system, 'Segoe UI', sans-serif);
}

/* ---------------------------------------------------------------------------
 * Header entry button
 * ------------------------------------------------------------------------- */

.dsh-company-button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 30px;
  max-width: min(320px, 38vw);
  padding: 4px 10px 4px 5px;
  border: 1px solid var(--dc-border);
  border-radius: 999px;
  background: var(--dc-surface);
  color: var(--dc-text);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
}
.dsh-company-button:hover {
  border-color: var(--dc-border-strong);
  box-shadow: var(--dc-shadow-sm);
}
.dsh-company-button:active { transform: translateY(1px); }

.dsh-company-button__mark {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: linear-gradient(135deg, var(--dc-accent), color-mix(in srgb, var(--dc-accent) 70%, #7c5cff));
  color: #fff;
}
.dsh-company-button__mark svg { width: 12px; height: 12px; }

.dsh-company-button__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-company-button__phase {
  color: var(--dc-text-3);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 140px;
}

.dsh-company-button__count {
  min-width: 17px;
  height: 17px;
  padding: 0 5px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: var(--dc-danger);
  color: #fff;
  font-size: 10.5px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.dsh-company-button__stale {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--dc-warning);
  flex: 0 0 auto;
}

/* ---------------------------------------------------------------------------
 * Overlay + drawer shell
 * ------------------------------------------------------------------------- */

.dsh-company-overlay {
  pointer-events: auto;
  position: absolute;
  inset: 0;
  z-index: 0;
  display: flex;
  justify-content: flex-end;
  background: rgb(10 14 22 / 42%);
  backdrop-filter: blur(2px);
  animation: dc-fade-in 160ms ease;
}

.dsh-company-drawer {
  box-sizing: border-box;
  width: min(980px, calc(100% - 48px));
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--dc-bg);
  border-left: 1px solid var(--dc-border);
  box-shadow: var(--dsw-shadow-lv4, -12px 0 40px rgb(0 0 0 / 22%));
  animation: dc-slide-in 200ms cubic-bezier(0.22, 0.8, 0.32, 1);
}

.dsh-company-drawer__header {
  position: relative;
  flex: 0 0 auto;
  padding: 16px 22px 0;
  background:
    radial-gradient(640px 180px at 12% -60%, var(--dc-accent-soft), transparent 70%),
    var(--dc-surface);
  border-bottom: 1px solid var(--dc-border);
}

.dsh-company-drawer__identity { min-width: 0; padding-right: 88px; }

.dsh-company-drawer__eyebrow {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 5px;
  color: var(--dc-accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}
.dsh-company-drawer__eyebrow svg { width: 13px; height: 13px; }

.dsh-company-drawer__title-row {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.dsh-company-drawer__title {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--dc-text);
  font-size: 19px;
  font-weight: 750;
  letter-spacing: -0.01em;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-company-drawer__meta {
  margin-top: 7px;
  padding-bottom: 0;
  display: flex;
  align-items: center;
  gap: 6px 14px;
  flex-wrap: wrap;
  color: var(--dc-text-3);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.dsh-company-drawer__meta span { display: inline-flex; align-items: center; gap: 5px; }

.dsh-company-drawer__header-actions {
  position: absolute;
  top: 16px;
  right: 20px;
  display: flex;
  gap: 6px;
}

.dsh-company-icon-button {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  border: 1px solid var(--dc-border);
  border-radius: 10px;
  color: var(--dc-text-2);
  background: var(--dc-surface);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.dsh-company-icon-button svg { width: 16px; height: 16px; }
.dsh-company-icon-button:hover:not(:disabled) {
  color: var(--dc-text);
  border-color: var(--dc-border-strong);
  background: var(--dc-fill);
}
.dsh-company-icon-button:disabled,
.dsh-company-action:disabled,
.dsh-company-approval__button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.dsh-company-spin { animation: dc-spin 900ms linear infinite; }

/* Tabs ---------------------------------------------------------------- */

.dsh-company-tabs {
  display: flex;
  gap: 4px;
  margin-top: 12px;
  padding: 4px;
  border: 1px solid var(--dc-border);
  border-bottom: 0;
  border-radius: 13px 13px 0 0;
  background: var(--dc-fill);
  overflow-x: auto;
  scrollbar-width: none;
}
.dsh-company-tabs::-webkit-scrollbar { display: none; }

.dsh-company-tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 1 0 auto;
  justify-content: center;
  min-height: 34px;
  padding: 0 14px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--dc-text-2);
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, box-shadow 120ms ease;
}
.dsh-company-tab svg { width: 15px; height: 15px; flex: 0 0 auto; }
.dsh-company-tab:hover { color: var(--dc-text); background: color-mix(in srgb, var(--dc-surface) 70%, transparent); }
.dsh-company-tab[aria-selected='true'] {
  background: var(--dc-surface);
  color: var(--dc-accent);
  box-shadow: var(--dc-shadow-sm);
}

.dsh-company-tab__count {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: var(--dc-danger);
  color: #fff;
  font-size: 10.5px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

/* Banners -------------------------------------------------------------- */

.dsh-company-banner-stack {
  flex: 0 0 auto;
  display: grid;
  gap: 8px;
  padding: 12px 22px 0;
  background: var(--dc-bg);
}

.dsh-company-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 13px;
  border: 1px solid var(--dc-border);
  border-radius: 10px;
  background: var(--dc-surface-2);
  color: var(--dc-text-2);
  font-size: 12.5px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.dsh-company-banner svg { width: 15px; height: 15px; flex: 0 0 auto; margin-top: 1px; }
.dsh-company-banner[data-tone='error'] {
  border-color: color-mix(in srgb, var(--dc-danger) 30%, transparent);
  background: var(--dc-danger-soft);
  color: color-mix(in srgb, var(--dc-danger) 82%, var(--dc-text));
}
.dsh-company-banner[data-tone='info'] {
  border-color: color-mix(in srgb, var(--dc-accent) 25%, transparent);
  background: var(--dc-accent-softer);
}

/* Command bar ----------------------------------------------------------- */

.dsh-company-actionbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 11px 22px;
  background: var(--dc-surface);
  border-bottom: 1px solid var(--dc-border);
}
.dsh-company-actionbar__group { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }

.dsh-company-action,
.dsh-company-approval__button,
.dsh-company-filter {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 34px;
  padding: 0 15px;
  border: 1px solid var(--dc-border);
  border-radius: 9px;
  background: var(--dc-surface);
  color: var(--dc-text);
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease, box-shadow 120ms ease;
}
.dsh-company-action svg, .dsh-company-approval__button svg { width: 14px; height: 14px; }
.dsh-company-action:hover:not(:disabled),
.dsh-company-approval__button:hover:not(:disabled),
.dsh-company-filter:hover {
  background: var(--dc-fill);
  border-color: var(--dc-border-strong);
}
.dsh-company-action:active:not(:disabled) { transform: translateY(1px); }

.dsh-company-action[data-variant='primary'],
.dsh-company-approval__button[data-decision='approved'] {
  background: var(--dc-accent);
  border-color: var(--dc-accent);
  color: #fff;
  box-shadow: 0 1px 3px color-mix(in srgb, var(--dc-accent) 35%, transparent);
}
.dsh-company-action[data-variant='primary']:hover:not(:disabled),
.dsh-company-approval__button[data-decision='approved']:hover:not(:disabled) {
  background: var(--dc-accent-strong);
  border-color: var(--dc-accent-strong);
}

.dsh-company-action[data-variant='danger'],
.dsh-company-approval__button[data-decision='rejected'] {
  background: var(--dc-danger-soft);
  border-color: color-mix(in srgb, var(--dc-danger) 30%, transparent);
  color: var(--dc-danger);
}
.dsh-company-action[data-variant='danger']:hover:not(:disabled),
.dsh-company-approval__button[data-decision='rejected']:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dc-danger) 18%, transparent);
}

/* Body ------------------------------------------------------------------ */

.dsh-company-drawer__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 18px 22px 28px;
  background: var(--dc-bg);
}

/* Views ------------------------------------------------------------------ */

.dsh-company-view { min-width: 0; }

.dsh-company-view__heading {
  margin: 2px 0 0;
  font-size: 17px;
  font-weight: 750;
  letter-spacing: -0.01em;
}
.dsh-company-view__subheading {
  margin: 3px 0 0;
  color: var(--dc-text-3);
  font-size: 12.5px;
  line-height: 1.5;
}

.dsh-company-section { margin-top: 16px; min-width: 0; }
.dsh-company-section:first-child { margin-top: 0; }

.dsh-company-section__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.dsh-company-section__title {
  margin: 0;
  color: var(--dc-text);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.01em;
}
.dsh-company-section__head .dsh-company-section__title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin: 0;
}
.dsh-company-section__head .dsh-company-section__title svg { width: 15px; height: 15px; color: var(--dc-accent); }

.dsh-company-former > summary { cursor: pointer; list-style: none; margin-bottom: 0; border-radius: 4px; }
.dsh-company-former > summary::-webkit-details-marker { display: none; }
.dsh-company-former > summary:focus-visible { outline: 2px solid var(--dc-accent); outline-offset: 4px; }
.dsh-company-former[open] > summary { margin-bottom: 10px; }
.dsh-company-former[open] > summary .dsh-company-chevron { transform: rotate(90deg); }

.dsh-company-section__count {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--dc-fill);
  color: var(--dc-text-2);
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

/* Cards ------------------------------------------------------------------ */

.dsh-company-card {
  box-sizing: border-box;
  min-width: 0;
  padding: 16px;
  background: var(--dc-surface);
  border: 1px solid var(--dc-border);
  border-radius: 14px;
  box-shadow: var(--dc-shadow-sm);
}

.dsh-company-card__title-row {
  min-width: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.dsh-company-card__title-row > div:first-child { min-width: 0; flex: 1 1 auto; }
.dsh-company-card__title {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--dc-text);
  font-size: 14px;
  font-weight: 700;
  line-height: 1.4;
}
.dsh-company-card__copy {
  margin: 5px 0 0;
  color: var(--dc-text-2);
  font-size: 12.5px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

/* Status badges ---------------------------------------------------------- */

.dsh-company-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  min-height: 22px;
  padding: 0 9px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: var(--dc-neutral-soft);
  color: var(--dc-text-2);
  font-size: 11.5px;
  font-weight: 650;
  line-height: 1;
  white-space: nowrap;
}
.dsh-company-status::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: currentColor;
  flex: 0 0 auto;
}
.dsh-company-status[data-tone='success'] { background: var(--dc-success-soft); color: var(--dc-success); }
.dsh-company-status[data-tone='warning'] { background: var(--dc-warning-soft); color: var(--dc-warning); }
.dsh-company-status[data-tone='danger'] { background: var(--dc-danger-soft); color: var(--dc-danger); }
.dsh-company-status[data-tone='active'] { background: var(--dc-active-soft); color: var(--dc-accent); }
.dsh-company-status[data-tone='neutral'] { background: var(--dc-neutral-soft); color: var(--dc-text-3); }

/* Chips ------------------------------------------------------------------ */

.dsh-company-chip-list { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }

.dsh-company-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  min-height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid var(--dc-border);
  background: var(--dc-surface);
  color: var(--dc-text-2);
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  white-space: nowrap;
  overflow-wrap: anywhere;
}
.dsh-company-chip[data-tone='warning'] { background: var(--dc-warning-soft); border-color: color-mix(in srgb, var(--dc-warning) 25%, transparent); color: var(--dc-warning); }
.dsh-company-chip[data-tone='danger'] { background: var(--dc-danger-soft); border-color: color-mix(in srgb, var(--dc-danger) 25%, transparent); color: var(--dc-danger); }
.dsh-company-chip[data-tone='success'] { background: var(--dc-success-soft); border-color: color-mix(in srgb, var(--dc-success) 25%, transparent); color: var(--dc-success); }
.dsh-company-chip[data-tone='active'] { background: var(--dc-active-soft); border-color: color-mix(in srgb, var(--dc-accent) 25%, transparent); color: var(--dc-accent); }

/* Stats ------------------------------------------------------------------- */

.dsh-company-stats,
.dsh-company-summary-grid {
  margin-top: 12px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}

.dsh-company-stat {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 13px 15px;
  border: 1px solid var(--dc-border);
  border-radius: 12px;
  background: var(--dc-surface);
  box-shadow: var(--dc-shadow-sm);
}
.dsh-company-stat__head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dsh-company-stat__icon {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  border-radius: 6px;
  background: var(--dc-accent-soft);
  color: var(--dc-accent);
}
.dsh-company-stat__icon svg { width: 12px; height: 12px; }
.dsh-company-stat__label {
  color: var(--dc-text-3);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-company-stat__value {
  display: block;
  color: var(--dc-text);
  font-size: 20px;
  font-weight: 750;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Progress ---------------------------------------------------------------- */

.dsh-company-progress {
  width: 100%;
  height: 9px;
  appearance: none;
  overflow: hidden;
  border: 0;
  border-radius: 999px;
  background: var(--dc-fill-strong);
}
.dsh-company-progress::-webkit-progress-bar { background: var(--dc-fill-strong); border-radius: 999px; }
.dsh-company-progress::-webkit-progress-value {
  background: linear-gradient(90deg, var(--dc-accent), color-mix(in srgb, var(--dc-accent) 60%, #7c5cff));
  border-radius: 999px;
  transition: width 240ms ease;
}
.dsh-company-progress::-moz-progress-bar {
  background: linear-gradient(90deg, var(--dc-accent), color-mix(in srgb, var(--dc-accent) 60%, #7c5cff));
  border-radius: 999px;
}
.dsh-company-progress[data-tone='warning']::-webkit-progress-value { background: var(--dc-warning); }
.dsh-company-progress[data-tone='warning']::-moz-progress-bar { background: var(--dc-warning); }
.dsh-company-progress[data-tone='danger']::-webkit-progress-value { background: var(--dc-danger); }
.dsh-company-progress[data-tone='danger']::-moz-progress-bar { background: var(--dc-danger); }
.dsh-company-progress[data-tone='success']::-webkit-progress-value { background: var(--dc-success); }
.dsh-company-progress[data-tone='success']::-moz-progress-bar { background: var(--dc-success); }

.dsh-company-progress-row { margin-top: 14px; }
.dsh-company-progress-row__labels {
  margin-bottom: 7px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  color: var(--dc-text-2);
  font-size: 12px;
}
.dsh-company-progress-row__labels span:last-child {
  color: var(--dc-text-3);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

/* Lists -------------------------------------------------------------------- */

.dsh-company-compact-list,
.dsh-company-message-list,
.dsh-company-warning-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}
.dsh-company-compact-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--dc-border);
  border-radius: 10px;
  background: var(--dc-surface-2);
  font-size: 12.5px;
  min-width: 0;
}
.dsh-company-compact-list li > div { display: grid; gap: 2px; min-width: 0; }
.dsh-company-compact-list li strong { font-weight: 650; overflow-wrap: anywhere; }
.dsh-company-compact-list li span { color: var(--dc-text-3); font-size: 11.5px; }

.dsh-company-message-list li {
  padding: 10px 12px;
  border: 1px solid var(--dc-border);
  border-radius: 10px;
  background: var(--dc-surface);
}
.dsh-company-message-list__meta {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: var(--dc-text-3);
  font-size: 11px;
  margin-bottom: 4px;
}
.dsh-company-message-list li p { margin: 0; font-size: 12.5px; line-height: 1.6; overflow-wrap: anywhere; }

.dsh-company-warning-list li {
  display: flex;
  gap: 9px;
  padding: 8px 0;
  color: var(--dc-text-2);
  font-size: 12px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.dsh-company-warning-list li::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--dc-warning);
  flex: 0 0 auto;
  margin-top: 7px;
}
.dsh-company-warning-list li + li { border-top: 1px dashed var(--dc-border); }

/* Empty state --------------------------------------------------------------- */

.dsh-company-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 26px 16px;
  border: 1px dashed var(--dc-border-strong);
  border-radius: 12px;
  color: var(--dc-text-3);
  font-size: 12.5px;
  line-height: 1.5;
  text-align: center;
}
.dsh-company-empty svg { width: 22px; height: 22px; color: var(--dc-text-3); opacity: 0.7; }

/* Overview ------------------------------------------------------------------- */

.dsh-company-overview {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 16px;
  align-items: start;
}
.dsh-company-overview__main,
.dsh-company-overview__aside {
  min-width: 0;
  display: grid;
  align-content: start;
  gap: 12px;
}
.dsh-company-overview__main > .dsh-company-section,
.dsh-company-overview__aside > .dsh-company-section { margin-top: 0; }

.dsh-company-governance-grid { display: grid; gap: 12px; }

.dsh-company-governance-card { position: relative; padding: 0; overflow: hidden; }
.dsh-company-governance-card[data-kind='slogan'] {
  background: linear-gradient(135deg, var(--dc-accent-soft), var(--dc-surface) 72%);
}

.dsh-company-governance-card__toggle {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 12px 14px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 120ms ease;
}
.dsh-company-governance-card__toggle:hover { background: color-mix(in srgb, var(--dc-surface) 55%, transparent); }
.dsh-company-governance-card__body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
}
.dsh-company-governance-card__body blockquote {
  margin: 0;
  color: var(--dc-text);
  font-size: clamp(15px, 1.7vw, 19px);
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.dsh-company-governance-card__detail {
  padding: 4px 14px 12px;
  border-top: 1px dashed var(--dc-border);
}
.dsh-company-governance-card__detail .dsh-company-section__title { display: block; margin: 10px 0 5px; }
.dsh-company-governance-copy {
  margin: 0;
  color: var(--dc-text-2);
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* Charter outline ---------------------------------------------------------------- */

/* Same row language as the blocked-work list: one row per clause, sub-clauses
 * and clause body indent on the org-tree guideline. Rows are React-controlled
 * disclosure buttons, so chevrons reuse the shared aria-expanded rotation. */

.dsh-company-charter-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 8px;
  min-width: 0;
}
.dsh-company-charter-item { min-width: 0; list-style: none; }

.dsh-company-charter-item__row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 9px 12px;
  border: 1px solid var(--dc-border);
  border-radius: 10px;
  background: var(--dc-surface-2);
  color: var(--dc-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease;
}
.dsh-company-charter-item__row:hover { border-color: var(--dc-border-strong); background: var(--dc-fill); }
.dsh-company-charter-item__row--leaf { cursor: default; }
.dsh-company-charter-item__row--leaf:hover { border-color: var(--dc-border); background: var(--dc-surface-2); }

.dsh-company-charter-item__title {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--dc-text);
  font-size: 12.5px;
  font-weight: 650;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.dsh-company-charter-item__count {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  min-height: 18px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--dc-fill);
  color: var(--dc-text-3);
  font-size: 10.5px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.dsh-company-charter-item__body {
  margin: 6px 0 0 9px;
  padding-left: 13px;
  border-left: 1px solid var(--dc-border);
  display: grid;
  gap: 8px;
  min-width: 0;
}
.dsh-company-charter-item__text {
  margin: 0;
  padding: 2px 0 2px 12px;
  color: var(--dc-text-2);
  font-size: 12.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.dsh-company-charter-actions {
  margin-top: 12px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.dsh-company-section__head-meta { display: inline-flex; align-items: center; gap: 8px; flex: 0 0 auto; min-width: 0; }

/* Forms ------------------------------------------------------------------------- */

.dsh-company-formation { display: grid; gap: 14px; }

.dsh-company-fieldset {
  min-width: 0;
  margin: 0;
  padding: 14px 16px 16px;
  border: 1px solid var(--dc-border);
  border-radius: 12px;
  background: var(--dc-surface-2);
}
.dsh-company-fieldset legend {
  padding: 0 8px;
  color: var(--dc-text);
  font-size: 12.5px;
  font-weight: 700;
}

.dsh-company-formation-grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 12px;
}
.dsh-company-field { display: grid; grid-column: span 6; gap: 5px; min-width: 0; align-content: start; }
.dsh-company-field[data-span='4'] { grid-column: span 4; }
.dsh-company-field[data-span='8'] { grid-column: span 8; }
.dsh-company-field[data-span='12'] { grid-column: 1 / -1; }
.dsh-company-field > span:first-child,
.dsh-company-price-field > span:first-child,
.dsh-company-auth-form label > span:first-child {
  font-size: 11.5px;
  font-weight: 650;
  color: var(--dc-text-2);
}

.dsh-company-field input,
.dsh-company-field textarea,
.dsh-company-field select,
.dsh-company-price-field input,
.dsh-company-auth-form input,
.dsh-company-auth-form select,
.dsh-company-auth-form textarea {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 8px 11px;
  border: 1px solid var(--dc-border-strong);
  border-radius: 9px;
  background: var(--dc-surface);
  color: var(--dc-text);
  font: inherit;
  font-size: 13px;
  line-height: 1.45;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.dsh-company-field input::placeholder,
.dsh-company-field textarea::placeholder,
.dsh-company-auth-form input::placeholder,
.dsh-company-auth-form textarea::placeholder { color: var(--dc-text-3); }
.dsh-company-field input:focus,
.dsh-company-field textarea:focus,
.dsh-company-field select:focus,
.dsh-company-price-field input:focus,
.dsh-company-auth-form input:focus,
.dsh-company-auth-form select:focus,
.dsh-company-auth-form textarea:focus {
  outline: none;
  border-color: var(--dc-accent);
  box-shadow: 0 0 0 3px var(--dc-accent-soft);
}
.dsh-company-field input[aria-invalid='true'],
.dsh-company-price-field input[aria-invalid='true'] { border-color: var(--dc-danger); }
.dsh-company-field textarea,
.dsh-company-auth-form textarea { resize: vertical; min-height: 64px; }

.dsh-company-field__hint,
.dsh-company-formation__hint {
  color: var(--dc-text-3);
  font-size: 11px;
  line-height: 1.5;
}

.dsh-company-formation__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

/* Price accordion ------------------------------------------------------------------ */

.dsh-company-price-list { margin-top: 10px; display: grid; gap: 8px; }

.dsh-company-price {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--dc-border);
  border-radius: 10px;
  background: var(--dc-surface);
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.dsh-company-price:hover { border-color: var(--dc-border-strong); }
.dsh-company-price[data-invalid='true'] {
  border-color: color-mix(in srgb, var(--dc-danger) 45%, transparent);
  box-shadow: 0 0 0 3px var(--dc-danger-soft);
}

/* Enable switch: a real checkbox (role="switch") under a styled track. */
.dsh-company-switch {
  position: relative;
  display: inline-block;
  flex: 0 0 auto;
  width: 36px;
  height: 20px;
}
.dsh-company-switch input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.dsh-company-switch input:disabled { cursor: not-allowed; }
.dsh-company-switch__track {
  position: absolute;
  inset: 0;
  pointer-events: none;
  box-sizing: border-box;
  border-radius: 999px;
  border: 1px solid var(--dc-border-strong);
  background: var(--dc-fill-strong);
  transition: background 140ms ease, border-color 140ms ease;
}
.dsh-company-switch__track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 999px;
  background: #fff;
  box-shadow: var(--dc-shadow-sm);
  transition: transform 140ms ease;
}
.dsh-company-switch input:checked + .dsh-company-switch__track {
  background: var(--dc-accent);
  border-color: var(--dc-accent);
}
.dsh-company-switch input:checked + .dsh-company-switch__track::after { transform: translateX(16px); }
.dsh-company-switch input:focus-visible + .dsh-company-switch__track {
  outline: 2px solid var(--dc-accent);
  outline-offset: 2px;
}
.dsh-company-switch input:disabled + .dsh-company-switch__track { opacity: 0.5; }

.dsh-company-price__head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  box-sizing: border-box;
  padding: 10px 12px;
}
.dsh-company-price__head .dsh-company-price__identity { flex: 1 1 auto; }

.dsh-company-org-node__toggle,
.dsh-company-audit-event__toggle {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 0;
  background: transparent;
  color: var(--dc-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dsh-company-org-node__toggle:hover,
.dsh-company-audit-event__toggle:hover { background: var(--dc-fill); }

.dsh-company-chevron {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  color: var(--dc-text-3);
  transition: transform 160ms ease;
}
[aria-expanded='true'] > .dsh-company-chevron,
button[aria-expanded='true'] .dsh-company-chevron { transform: rotate(90deg); }

.dsh-company-price__identity { min-width: 0; flex: 1 1 auto; display: grid; gap: 2px; }
.dsh-company-price__route {
  min-width: 0;
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-size: 12px;
  font-weight: 650;
  color: var(--dc-text);
  overflow-wrap: anywhere;
}
.dsh-company-price__summary {
  min-width: 0;
  color: var(--dc-text-3);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.dsh-company-price__badges { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; justify-content: flex-end; }

.dsh-company-price__body[hidden],
.dsh-company-governance-card__detail[hidden],
.dsh-company-audit-event__body[hidden] { display: none; }

.dsh-company-price__body {
  padding: 12px;
  display: grid;
  gap: 10px;
  border-top: 1px solid var(--dc-border);
  background: var(--dc-surface-2);
}

.dsh-company-price__fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}
.dsh-company-price-field { min-width: 0; display: grid; gap: 5px; }

/* Detail cards ---------------------------------------------------------------- */

.dsh-company-detail-stack {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 10px;
}

.dsh-company-detail-card {
  min-width: 0;
  display: grid;
  align-content: start;
  gap: 5px;
  padding: 10px 12px;
  border: 1px solid var(--dc-border);
  border-radius: 10px;
  background: var(--dc-surface-2);
}
.dsh-company-detail-card__label {
  margin: 0;
  color: var(--dc-text-3);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.dsh-company-detail-card__body {
  margin: 0;
  color: var(--dc-text);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* Work ---------------------------------------------------------------------- */

.dsh-company-filters {
  margin-top: 12px;
  display: inline-flex;
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--dc-border);
  border-radius: 11px;
  background: var(--dc-fill);
  width: max-content;
  max-width: 100%;
  overflow-x: auto;
}
.dsh-company-filter {
  min-height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dc-text-2);
  font-size: 12px;
}
.dsh-company-filter[aria-pressed='true'] {
  background: var(--dc-surface);
  color: var(--dc-accent);
  font-weight: 700;
  box-shadow: var(--dc-shadow-sm);
}

.dsh-company-work-list { margin-top: 12px; display: grid; gap: 12px; }

.dsh-company-work {
  position: relative;
  padding-left: 22px;
  transition: box-shadow 120ms ease, border-color 120ms ease;
}
/* Status bar as an inset rounded pill: a flush edge strip would be clipped
 * diagonally by the card's 14px radius at both ends and read as broken. */
.dsh-company-work::before {
  content: '';
  position: absolute;
  left: 8px;
  top: 12px;
  bottom: 12px;
  width: 4px;
  border-radius: 999px;
  background: var(--dc-accent);
}
.dsh-company-work[data-terminal='true']::before { background: var(--dc-success); }
.dsh-company-work[data-blocked='true']::before { background: var(--dc-warning); }
.dsh-company-work:hover { border-color: var(--dc-border-strong); }

.dsh-company-work__meta {
  margin-top: 5px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px 12px;
  color: var(--dc-text-3);
  font-size: 11.5px;
}
.dsh-company-work__meta span { display: inline-flex; align-items: center; gap: 5px; }
.dsh-company-work__meta span:first-child { font-family: var(--dsw-font-mono, ui-monospace, monospace); }

.dsh-company-dependencies {
  margin-top: 10px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.dsh-company-dependencies > strong { color: var(--dc-text-3); font-size: 11px; font-weight: 700; }

.dsh-company-dependency {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  min-height: 22px;
  padding: 0 9px;
  border-radius: 999px;
  border: 1px solid var(--dc-border);
  background: var(--dc-surface-2);
  color: var(--dc-text-2);
  font-size: 11.5px;
  overflow-wrap: anywhere;
}
.dsh-company-dependency__state {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--dc-warning);
  flex: 0 0 auto;
}
.dsh-company-dependency__state[data-complete='true'] { background: var(--dc-success); }

.dsh-company-details { margin-top: 12px; border-top: 1px dashed var(--dc-border); padding-top: 10px; }
.dsh-company-details summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 650;
  color: var(--dc-accent);
  cursor: pointer;
  list-style: none;
}
.dsh-company-details summary::-webkit-details-marker { display: none; }
.dsh-company-details summary::after { content: '▾'; font-size: 10px; transition: transform 140ms ease; }
.dsh-company-details[open] summary::after { transform: rotate(180deg); }
.dsh-company-details summary:hover { background: var(--dc-accent-soft); }

.dsh-company-details__body {
  display: grid;
  gap: 12px;
  margin-top: 10px;
  padding: 12px;
  border: 1px solid var(--dc-border);
  border-radius: 10px;
  background: var(--dc-surface-2);
}
.dsh-company-details__body section { display: grid; gap: 4px; min-width: 0; }
.dsh-company-details__body h4 {
  margin: 0 0 2px;
  color: var(--dc-text-3);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.dsh-company-details__body p,
.dsh-company-details__body ul {
  margin: 0;
  color: var(--dc-text);
  font-size: 12.5px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.dsh-company-details__body ul { padding-left: 18px; }

.dsh-company-criteria {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.dsh-company-criteria li {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 22px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--dc-border);
  background: var(--dc-surface-2);
  color: var(--dc-text-2);
  font-size: 11.5px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.dsh-company-criteria li::before { content: '✓'; color: var(--dc-success); font-weight: 800; font-size: 11px; }

.dsh-company-findings { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.dsh-company-finding {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--dc-border);
  border-left: 3px solid var(--dc-warning);
  border-radius: 8px;
  background: var(--dc-surface);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.dsh-company-finding[data-severity='blocker'],
.dsh-company-finding[data-severity='high'] { border-left-color: var(--dc-danger); }
.dsh-company-finding strong { text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.05em; color: var(--dc-text-3); }
.dsh-company-finding div { color: var(--dc-text-2); }

/* Budget / audit ------------------------------------------------------------------ */

.dsh-company-budget-callout {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 11px 14px;
  border: 1px solid color-mix(in srgb, var(--dc-accent) 22%, transparent);
  border-radius: 10px;
  background: var(--dc-accent-softer);
  color: var(--dc-text-2);
  font-size: 12.5px;
  line-height: 1.55;
}
.dsh-company-budget-callout svg { width: 16px; height: 16px; color: var(--dc-accent); flex: 0 0 auto; margin-top: 1px; }

.dsh-company-audit-grid {
  margin-top: 12px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}

.dsh-company-money-stat {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 13px 15px;
  border: 1px solid var(--dc-border);
  border-radius: 12px;
  background: var(--dc-surface);
  box-shadow: var(--dc-shadow-sm);
}
.dsh-company-money-stat__value {
  display: block;
  overflow-wrap: anywhere;
  color: var(--dc-text);
  font-size: 17px;
  font-weight: 750;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}
.dsh-company-money-stat__label,
.dsh-company-money-stat__secondary {
  display: block;
  margin-top: 2px;
  color: var(--dc-text-2);
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1.4;
}
.dsh-company-money-stat__secondary { color: var(--dc-text-3); font-weight: 500; font-variant-numeric: tabular-nums; }

.dsh-company-budget-bar {
  display: flex;
  gap: 2px;
  height: 12px;
  border-radius: 999px;
  background: var(--dc-fill-strong);
  overflow: hidden;
}
.dsh-company-budget-bar__spent {
  background: linear-gradient(90deg, var(--dc-accent), color-mix(in srgb, var(--dc-accent) 60%, #7c5cff));
  transition: width 240ms ease;
}
.dsh-company-budget-bar__reserved {
  background: repeating-linear-gradient(-45deg, var(--dc-warning), var(--dc-warning) 4px, color-mix(in srgb, var(--dc-warning) 65%, #fff) 4px, color-mix(in srgb, var(--dc-warning) 65%, #fff) 8px);
}

.dsh-company-product-budget-list {
  margin-top: 10px;
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}
.dsh-company-product-budget-list > div,
.dsh-company-product-budget-list > label {
  display: grid;
  gap: 5px;
  padding: 10px 12px;
  border: 1px solid var(--dc-border);
  border-radius: 10px;
  background: var(--dc-surface);
}
.dsh-company-product-budget-list > label > span { color: var(--dc-text-3); font-size: 11px; font-weight: 650; }
.dsh-company-product-budget-list input {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 10px;
  border: 1px solid var(--dc-border-strong);
  border-radius: 8px;
  background: var(--dc-surface-2);
  color: var(--dc-text);
  font: inherit;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.dsh-company-product-budget-list input:focus { outline: none; border-color: var(--dc-accent); box-shadow: 0 0 0 3px var(--dc-accent-soft); }
.dsh-company-product-budget-list strong { font-size: 13px; font-variant-numeric: tabular-nums; }

.dsh-company-cost-bar {
  display: flex;
  height: 12px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--dc-fill-strong);
  margin: 12px 0;
}
.dsh-company-cost-segment { min-width: 2px; transition: width 240ms ease; }

.dsh-company-cost-legend { margin-top: 12px; display: grid; gap: 6px; }
.dsh-company-cost-legend__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--dc-border);
  border-radius: 10px;
  background: var(--dc-surface-2);
  font-size: 12px;
  min-width: 0;
}
.dsh-company-cost-legend__swatch { width: 10px; height: 10px; border-radius: 3px; flex: 0 0 auto; }
.dsh-company-cost-legend__route {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-company-cost-legend__row > span:last-child { flex: 0 0 auto; color: var(--dc-text-2); font-variant-numeric: tabular-nums; }

.dsh-company-audit-window {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--dc-border);
  border-radius: 10px;
  background: var(--dc-surface-2);
  color: var(--dc-text-2);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  margin-bottom: 10px;
}
.dsh-company-audit-window strong { color: var(--dc-warning); font-weight: 700; }

.dsh-company-audit-events { display: grid; gap: 8px; }

.dsh-company-audit-event {
  overflow: hidden;
  background: var(--dc-surface);
  border: 1px solid var(--dc-border);
  border-radius: 10px;
  transition: border-color 120ms ease;
}
.dsh-company-audit-event:hover { border-color: var(--dc-border-strong); }

.dsh-company-audit-event__identity { min-width: 0; flex: 1 1 auto; display: grid; gap: 2px; }
.dsh-company-audit-event__title {
  min-width: 0;
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-size: 12px;
  font-weight: 650;
  overflow-wrap: anywhere;
}
.dsh-company-audit-event__meta {
  color: var(--dc-text-3);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-company-audit-event__body {
  padding: 12px;
  display: grid;
  gap: 10px;
  border-top: 1px solid var(--dc-border);
  background: var(--dc-surface-2);
}

/* Approvals ------------------------------------------------------------------------ */

.dsh-company-approval-groups { margin-top: 16px; display: grid; gap: 18px; }
.dsh-company-approvals { display: grid; gap: 12px; }

.dsh-company-approval { transition: box-shadow 120ms ease, border-color 120ms ease; }
.dsh-company-approval[data-pending='true'] {
  border-color: color-mix(in srgb, var(--dc-warning) 32%, transparent);
  box-shadow: 0 0 0 3px var(--dc-warning-soft), var(--dc-shadow-sm);
}

.dsh-company-approval__meta {
  margin-top: 5px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px 12px;
  color: var(--dc-text-3);
  font-size: 11.5px;
}
.dsh-company-approval__meta span { display: inline-flex; align-items: center; gap: 5px; }

.dsh-company-risk {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--dc-success-soft);
  color: var(--dc-success);
  font-size: 11px;
  font-weight: 700;
}
.dsh-company-risk[data-risk='medium'] { background: var(--dc-warning-soft); color: var(--dc-warning); }
.dsh-company-risk[data-risk='high'] { background: var(--dc-danger-soft); color: var(--dc-danger); }

.dsh-company-approval__content {
  margin-top: 10px;
  padding: 10px 12px;
  border-left: 3px solid var(--dc-accent);
  border-radius: 6px;
  background: var(--dc-accent-softer);
}
.dsh-company-approval__content p {
  margin: 0;
  color: var(--dc-text);
  font-size: 12.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dsh-company-approval__fold-label {
  margin: 0 0 4px;
  color: var(--dc-text-3);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.dsh-company-approval__fold {
  margin-top: 8px;
  border: 1px solid var(--dc-border);
  border-radius: 9px;
  overflow: hidden;
}
.dsh-company-approval__fold > summary {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 11px;
  cursor: pointer;
  list-style: none;
  color: var(--dc-text-2);
  font-size: 12px;
  font-weight: 650;
  user-select: none;
  transition: background 120ms ease;
}
.dsh-company-approval__fold > summary::-webkit-details-marker { display: none; }
.dsh-company-approval__fold > summary:hover { background: var(--dc-fill); color: var(--dc-text); }
.dsh-company-approval__fold[open] > summary { border-bottom: 1px dashed var(--dc-border); }
.dsh-company-approval__detailinfo { padding: 9px 11px; }

.dsh-company-approval__payload {
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid var(--dc-border);
  border-radius: 9px;
  background: var(--dc-surface-2);
  color: var(--dc-text-2);
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.dsh-company-approval__actions {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed var(--dc-border);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.dsh-company-approval__button { min-height: 32px; padding: 0 14px; }

/* Confirmation dialog ------------------------------------------------------------------ */

.dsh-company-confirm-layer {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: grid;
  place-items: center;
  padding: 24px;
  overflow: auto;
  overscroll-behavior: contain;
  background: rgb(10 14 22 / 40%);
  backdrop-filter: blur(2px);
  animation: dc-fade-in 140ms ease;
}

.dsh-company-confirm {
  width: min(440px, 100%);
  max-height: calc(100% - 2px);
  box-sizing: border-box;
  padding: 20px;
  overflow: auto;
  color: var(--dc-text);
  background: var(--dc-surface-raised);
  border: 1px solid var(--dc-border);
  border-radius: 16px;
  box-shadow: var(--dsw-shadow-lv4, 0 18px 54px rgb(0 0 0 / 28%));
  animation: dc-rise-in 160ms ease;
}

.dsh-company-confirm__title { margin: 0 0 8px; font-size: 15px; font-weight: 750; }
.dsh-company-confirm__body {
  margin: 0;
  color: var(--dc-text-2);
  font-size: 12.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dsh-company-confirm__warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 12px 0 0;
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, var(--dc-warning) 30%, transparent);
  border-radius: 9px;
  background: var(--dc-warning-soft);
  color: color-mix(in srgb, var(--dc-warning) 85%, var(--dc-text));
  font-size: 12px;
  line-height: 1.55;
}
.dsh-company-confirm__warning svg { width: 14px; height: 14px; flex: 0 0 auto; margin-top: 1px; }

.dsh-company-confirm__actions {
  margin-top: 18px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* Loading / empty -------------------------------------------------------------------------- */

.dsh-company-loading,
.dsh-company-no-company {
  min-height: 260px;
  display: grid;
  place-items: center;
  padding: 28px;
  color: var(--dc-text-3);
  text-align: center;
  font-size: 12.5px;
}
.dsh-company-loading__inner { display: flex; align-items: center; gap: 10px; }
.dsh-company-loading__mark {
  width: 16px;
  height: 16px;
  border: 2px solid var(--dc-fill-strong);
  border-top-color: var(--dc-accent);
  border-radius: 999px;
  animation: dc-spin 800ms linear infinite;
}

/* Organization ------------------------------------------------------------------------------- */

.dsh-company-org-tree { margin: 10px 0 0; padding: 0; list-style: none; display: grid; gap: 8px; }
.dsh-company-org-tree [role='group'] {
  margin: 6px 0 0 9px;
  padding: 0 0 0 13px;
  list-style: none;
  border-left: 1px solid var(--dc-border);
  display: grid;
  gap: 8px;
}

/* Direct members flow under their unit like file-tree entries, indented on
 * the same guideline as child units. */
.dsh-company-org-node__people-list {
  margin: 6px 0 0 9px;
  padding: 0 0 0 13px;
  border-left: 1px solid var(--dc-border);
  display: grid;
  gap: 8px;
}

.dsh-company-org-node { min-width: 0; }
/* Row and its detail panel form one connected card, so the detail always
 * reads as anchored to its own unit instead of the subtree below it. */
.dsh-company-org-node__shell {
  min-width: 0;
  overflow: hidden;
  background: var(--dc-surface);
  border: 1px solid var(--dc-border);
  border-radius: 12px;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.dsh-company-org-node__shell:hover { border-color: var(--dc-border-strong); }

.dsh-company-org-node__row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 8px 2px 2px;
  min-width: 0;
}

.dsh-company-org-node__toggle {
  flex: 1 1 auto;
  min-width: 0;
  padding: 10px 12px;
  border-radius: 10px;
}
.dsh-company-org-node__identity { min-width: 0; flex: 1 1 auto; display: grid; gap: 2px; }
.dsh-company-org-node__identity--leaf { padding: 11px 12px; }
.dsh-company-org-node__name { min-width: 0; color: var(--dc-text); font-size: 13.5px; font-weight: 700; overflow-wrap: anywhere; }
.dsh-company-org-node__meta { color: var(--dc-text-3); font-size: 11.5px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }

.dsh-company-org-node__summary {
  /* Fixed right side: the load badge never shrinks below content, so badge
   * icon/text cannot be squeezed into stacked overflow at narrow widths. */
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
}

.dsh-company-org-node__info,
.dsh-company-employee-row__info {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: var(--dc-text-3);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.dsh-company-org-node__info svg,
.dsh-company-employee-row__info svg { width: 15px; height: 15px; }
.dsh-company-org-node__info:hover,
.dsh-company-employee-row__info:hover {
  background: var(--dc-fill);
  color: var(--dc-accent);
  border-color: var(--dc-border);
}
.dsh-company-org-node__info[aria-expanded='true'],
.dsh-company-employee-row__info[aria-expanded='true'] {
  background: var(--dc-accent-soft);
  color: var(--dc-accent);
  border-color: color-mix(in srgb, var(--dc-accent) 25%, transparent);
}

.dsh-company-load-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  min-height: 22px;
  padding: 0 9px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 650;
  white-space: nowrap;
  background: var(--dc-neutral-soft);
  color: var(--dc-text-2);
}
.dsh-company-load-badge svg { width: 13px; height: 13px; }
.dsh-company-load-badge[data-tone='success'] { background: var(--dc-success-soft); color: var(--dc-success); }
.dsh-company-load-badge[data-tone='warning'] { background: var(--dc-warning-soft); color: var(--dc-warning); }
.dsh-company-load-badge[data-tone='danger'] { background: var(--dc-danger-soft); color: var(--dc-danger); }
.dsh-company-load-badge[data-tone='active'] { background: var(--dc-active-soft); color: var(--dc-accent); }

.dsh-company-org-node__detail {
  padding: 12px 14px 14px;
  display: grid;
  gap: 12px;
  border-top: 1px dashed var(--dc-border);
  background: var(--dc-surface-2);
}

.dsh-company-money-lines {
  display: grid;
  gap: 2px;
  margin-bottom: 8px;
}
.dsh-company-money-lines span { font-variant-numeric: tabular-nums; }

.dsh-company-load-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
  gap: 8px;
}
.dsh-company-load-metric {
  min-width: 0;
  padding: 9px 11px;
  background: var(--dc-surface);
  border: 1px solid var(--dc-border);
  border-radius: 10px;
}
.dsh-company-load-metric strong,
.dsh-company-load-metric span { display: block; }
.dsh-company-load-metric strong { font-size: 15px; font-variant-numeric: tabular-nums; }
.dsh-company-load-metric span { margin-top: 2px; color: var(--dc-text-3); font-size: 10.5px; }

.dsh-company-employee-list { display: grid; gap: 8px; }

.dsh-company-employee-row {
  min-width: 0;
  overflow: hidden;
  background: var(--dc-surface);
  border: 1px solid var(--dc-border);
  border-radius: 11px;
  transition: border-color 120ms ease;
}
.dsh-company-employee-row:hover { border-color: var(--dc-border-strong); }
.dsh-company-employee-row[data-open='true'] { border-color: var(--dc-border-strong); }

.dsh-company-employee-row__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 8px 9px 12px;
  min-width: 0;
}
.dsh-company-employee-row__identity {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1 1 auto;
  min-width: 0;
}
.dsh-company-employee-row__fields { display: grid; gap: 1px; min-width: 0; }
.dsh-company-employee-row__name { min-width: 0; color: var(--dc-text); font-size: 13px; font-weight: 700; overflow-wrap: anywhere; }
.dsh-company-employee-row__role { min-width: 0; color: var(--dc-text-2); font-size: 11.5px; overflow-wrap: anywhere; }
.dsh-company-employee-row__department { display: block; color: var(--dc-text-3); font-size: 11px; }

.dsh-company-avatar {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: linear-gradient(135deg, var(--dc-accent), color-mix(in srgb, var(--dc-accent) 60%, #7c5cff));
  color: #fff;
  font-size: 11px;
  font-weight: 750;
}

.dsh-company-employee-row__meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}
.dsh-company-employee-row__route {
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--dc-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 180px;
}
.dsh-company-employee-row__budget {
  font-size: 12.5px;
  font-weight: 650;
  color: var(--dc-text-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.dsh-company-employee-row__body {
  padding: 12px 14px 14px;
  display: grid;
  gap: 12px;
  border-top: 1px solid var(--dc-border);
  background: var(--dc-surface-2);
}

.dsh-company-route {
  color: var(--dc-text-3);
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-size: 11px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.dsh-company-route-chart { display: grid; gap: 7px; }
.dsh-company-route-chart__bar { height: 9px; display: flex; gap: 1px; overflow: hidden; border-radius: 999px; background: var(--dc-fill); }
.dsh-company-route-chart__bar > span { min-width: 2px; }
.dsh-company-route-chart__legend { display: grid; gap: 4px; }
.dsh-company-route-chart__legend > span { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--dc-text-2); overflow-wrap: anywhere; }
.dsh-company-route-chart__legend i { width: 8px; height: 8px; border-radius: 3px; flex: 0 0 auto; }

.dsh-company-department-analytics { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px; }

.dsh-company-inline-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }

/* Temporary authorization --------------------------------------------------------------------- */

.dsh-company-auth {
  display: grid;
  gap: 10px;
  padding: 13px 14px;
  color: var(--dc-text-2);
  background: color-mix(in srgb, var(--dc-accent) 4%, var(--dc-surface));
  border: 1px solid color-mix(in srgb, var(--dc-accent) 22%, var(--dc-border));
  border-radius: 12px;
  font-size: 12px;
  line-height: 1.5;
}
.dsh-company-auth__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.dsh-company-auth__title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--dc-text);
  font-size: 12.5px;
  font-weight: 700;
}
.dsh-company-auth__title svg { width: 15px; height: 15px; color: var(--dc-accent); }

.dsh-company-auth-history { display: grid; gap: 8px; }
.dsh-company-auth-history > article {
  padding: 11px 12px;
  border: 1px solid var(--dc-border);
  border-radius: 10px;
  background: var(--dc-surface-2);
  display: grid;
  gap: 8px;
}

.dsh-company-auth__boundary {
  margin: 0;
  padding: 8px 10px;
  color: var(--dc-text-2);
  background: var(--dc-fill);
  border-radius: 8px;
  line-height: 1.55;
  display: flex;
  align-items: flex-start;
  gap: 7px;
}
.dsh-company-auth__boundary strong { color: var(--dc-text); }
.dsh-company-auth__boundary svg { width: 14px; height: 14px; flex: 0 0 auto; color: var(--dc-warning); margin-top: 2px; }

.dsh-company-auth-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 150px;
  gap: 10px;
  padding: 12px;
  border: 1px dashed var(--dc-border-strong);
  border-radius: 10px;
}
.dsh-company-auth-form label { min-width: 0; display: grid; gap: 5px; }
.dsh-company-auth-form label:first-child { grid-column: 1 / -1; }

/* Products ------------------------------------------------------------------------------------- */

.dsh-company-products { margin-top: 14px; display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }

.dsh-company-product__root {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-top: 10px;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid var(--dc-border);
  background: var(--dc-surface-2);
  color: var(--dc-text-2);
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-size: 11.5px;
  overflow-wrap: anywhere;
  max-width: 100%;
}
.dsh-company-product__root strong { color: var(--dc-text-3); font-family: inherit; }

.dsh-company-product__footer {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed var(--dc-border);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 14px;
  color: var(--dc-text-3);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.dsh-company-product__footer span:first-child { font-family: var(--dsw-font-mono, ui-monospace, monospace); }

/* Tickets --------------------------------------------------------------------------------------- */

.dsh-company-ticket-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; min-width: 0; }
.dsh-company-ticket {
  min-width: 0;
  display: grid;
  gap: 6px;
  padding: 11px 12px;
  border: 1px solid var(--dc-border);
  border-radius: 10px;
  background: var(--dc-surface-2);
}
.dsh-company-ticket__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}
.dsh-company-ticket__title {
  min-width: 0;
  color: var(--dc-text);
  font-size: 12.5px;
  font-weight: 650;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.dsh-company-ticket__badges { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; flex-wrap: wrap; justify-content: flex-end; }
.dsh-company-ticket__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 12px;
  color: var(--dc-text-3);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.dsh-company-ticket__reply {
  margin: 4px 0 0;
  padding: 8px 10px;
  border-left: 3px solid var(--dc-success);
  border-radius: 6px;
  background: var(--dc-surface);
  color: var(--dc-text-2);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* Ledger rows ---------------------------------------------------------------------------------- */

.dsh-company-ledger { display: grid; gap: 6px; }
.dsh-company-ledger__row {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(120px, 1.1fr) minmax(140px, 2fr) auto;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--dc-border);
  border-radius: 9px;
  background: var(--dc-surface);
  font-size: 12px;
}
.dsh-company-ledger__row:hover { border-color: var(--dc-border-strong); }
.dsh-company-ledger__kind { font-family: var(--dsw-font-mono, ui-monospace, monospace); font-weight: 650; color: var(--dc-text); overflow-wrap: anywhere; }
.dsh-company-ledger__reason { min-width: 0; color: var(--dc-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-company-ledger__time { color: var(--dc-text-3); font-size: 11px; white-space: nowrap; font-variant-numeric: tabular-nums; }

/* Focus ----------------------------------------------------------------------------------------- */

.dsh-company-button:focus-visible,
.dsh-company-icon-button:focus-visible,
.dsh-company-tab:focus-visible,
.dsh-company-action:focus-visible,
.dsh-company-filter:focus-visible,
.dsh-company-approval__button:focus-visible,
.dsh-company-org-node__toggle:focus-visible,
.dsh-company-org-node__info:focus-visible,
.dsh-company-employee-row__info:focus-visible,
.dsh-company-audit-event__toggle:focus-visible,
.dsh-company-governance-card__toggle:focus-visible,
.dsh-company-charter-item__row:focus-visible,
.dsh-company-field input:focus-visible,
.dsh-company-field textarea:focus-visible,
.dsh-company-price-field input:focus-visible,
.dsh-company-auth-form input:focus-visible,
.dsh-company-auth-form select:focus-visible,
.dsh-company-auth-form textarea:focus-visible,
.dsh-company-details summary:focus-visible {
  outline: 2px solid var(--dc-accent);
  outline-offset: 2px;
}

/* Motion --------------------------------------------------------------------------------------- */

@keyframes dc-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes dc-slide-in {
  from { transform: translateX(28px); opacity: 0.4; }
  to { transform: translateX(0); opacity: 1; }
}
@keyframes dc-rise-in {
  from { transform: translateY(8px) scale(0.985); opacity: 0; }
  to { transform: translateY(0) scale(1); opacity: 1; }
}
@keyframes dc-spin {
  to { transform: rotate(360deg); }
}

/* Responsive ------------------------------------------------------------------------------------ */

@media (max-width: 920px) {
  .dsh-company-overview { grid-template-columns: minmax(0, 1fr); }
  .dsh-company-field { grid-column: span 12; }
  .dsh-company-field[data-span='4'],
  .dsh-company-field[data-span='8'] { grid-column: span 6; }
  .dsh-company-ledger__row { grid-template-columns: 1fr auto; }
  .dsh-company-ledger__reason { grid-column: 1 / -1; grid-row: 2; white-space: normal; }
}

@media (max-width: 680px) {
  .dsh-company-overlay { align-items: flex-end; }
  .dsh-company-drawer {
    width: 100%;
    height: min(96%, 960px);
    border-top: 1px solid var(--dc-border);
    border-left: 0;
    border-radius: 16px 16px 0 0;
  }
  .dsh-company-drawer__header { padding: 14px 16px 0; }
  .dsh-company-drawer__header-actions { top: 12px; right: 14px; }
  .dsh-company-drawer__identity { padding-right: 80px; }
  .dsh-company-drawer__title { font-size: 18px; }
  .dsh-company-tabs { margin-right: -8px; }
  .dsh-company-banner-stack { padding: 10px 14px 0; }
  .dsh-company-actionbar { padding: 10px 14px; }
  .dsh-company-drawer__body { padding: 14px 14px 22px; }
  .dsh-company-tab { padding: 0 10px; font-size: 12px; }
  .dsh-company-tab svg { display: none; }
  .dsh-company-formation-grid { grid-template-columns: 1fr; }
  .dsh-company-field[data-span='4'],
  .dsh-company-field[data-span='8'] { grid-column: span 12; }
  .dsh-company-overview__main,
  .dsh-company-overview__aside { gap: 10px; }
  .dsh-company-employee-row__route { display: none; }
  .dsh-company-confirm-layer { padding: 14px; }
  .dsh-company-button__phase { display: none; }
  .dsh-company-price__fields,
  .dsh-company-auth-form { grid-template-columns: 1fr; }
  .dsh-company-auth-form label,
  .dsh-company-auth-form label:first-child { grid-column: 1; }
  .dsh-company-load-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dsh-company-org-tree [role='group'],
  .dsh-company-org-node__people-list,
  .dsh-company-charter-item__body { padding-left: 10px; margin-left: 6px; }
}

@media (max-width: 430px) {
  .dsh-company-audit-grid,
  .dsh-company-load-metrics,
  .dsh-company-stats,
  .dsh-company-summary-grid { grid-template-columns: 1fr; }
  .dsh-company-price__badges,
  .dsh-company-employee-row__budget { display: none; }
  .dsh-company-department-analytics { grid-template-columns: 1fr; }
  .dsh-company-load-badge { max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
  .dsh-company-actionbar__group { width: 100%; }
  .dsh-company-actionbar__group .dsh-company-action { flex: 1; }
  .dsh-company-products { grid-template-columns: minmax(0, 1fr); }
}

@media (prefers-reduced-motion: reduce) {
  .dsh-company-overlay,
  .dsh-company-drawer,
  .dsh-company-confirm-layer,
  .dsh-company-confirm,
  .dsh-company-spin,
  .dsh-company-loading__mark,
  .dsh-company-chevron,
  .dsh-company-progress::-webkit-progress-value,
  .dsh-company-progress::-moz-progress-bar,
  .dsh-company-budget-bar__spent,
  .dsh-company-cost-segment {
    animation: none;
    transition: none;
  }
}
`

/** Install the plugin stylesheet under the Cordis fiber's lifecycle. */
export function installCompanyStyles(): () => void {
  const owner = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  let tag = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${STYLE_ID}"]`)
  if (tag === null) {
    tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-company'
    tag.dataset.pluginCss = STYLE_ID
    document.head.append(tag)
  }
  tag.dataset.companyStyleOwner = owner
  tag.textContent = COMPANY_STYLES
  return () => {
    if (tag?.dataset.companyStyleOwner === owner) tag.remove()
  }
}
