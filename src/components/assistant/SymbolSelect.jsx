/**
 * Searchable symbol dropdown (react-select, styled like the Greek Analysis one): type to filter, click to pick.
 * Its menu is rendered into document.body above the popup. When the symbol list could not be loaded it is a plain
 * text box, so a symbol can still be typed.
 */

import Select from 'react-select'
import { fieldClass } from './pickerParts'

const classNames = {
  control: () => 'bg-surface-container-low border border-terminal-border rounded-lg text-sm px-xs min-h-9 text-on-surface',
  valueContainer: () => 'px-xs',
  placeholder: () => 'text-on-surface-variant',
  input: () => 'text-on-surface',
  singleValue: () => 'text-on-surface',
  menu: () => 'bg-surface-container-low border border-terminal-border rounded-lg mt-xs overflow-hidden',
  menuList: () => 'py-xs',
  option: ({ isFocused, isSelected }) => `px-md py-sm text-sm cursor-pointer ${isSelected ? 'bg-primary-container text-on-primary-container' : isFocused ? 'bg-surface-container-highest text-on-surface' : 'text-on-surface'}`,
  noOptionsMessage: () => 'text-on-surface-variant text-sm px-md py-sm',
  indicatorSeparator: () => 'bg-terminal-border',
  dropdownIndicator: () => 'text-on-surface-variant px-xs',
  clearIndicator: () => 'text-on-surface-variant px-xs',
}

// react-select's own z-index (1) beats a Tailwind class, and the popup is at z-[60]: set it inline.
const styles = { menuPortal: (base) => ({ ...base, zIndex: 9999 }) }

/** symbols: string[] ('' / [] = not loaded -> text box); value: the chosen symbol or ''; onChange(symbol). */
export default function SymbolSelect({ symbols, value, onChange, inputId, ariaLabel = 'Option chain symbol' }) {
  if (!symbols?.length) {
    return <input id={inputId} value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} placeholder="e.g. NIFTY" className={fieldClass} aria-label={ariaLabel} />
  }
  return (
    <Select
      inputId={inputId}
      aria-label={ariaLabel}
      unstyled
      isClearable
      options={symbols.map((s) => ({ value: s, label: s }))}
      value={value ? { value, label: value } : null}
      onChange={(picked) => onChange(picked?.value ?? '')}
      placeholder="Select or type a symbol"
      classNames={classNames}
      styles={styles}
      menuPortalTarget={document.body}
    />
  )
}
