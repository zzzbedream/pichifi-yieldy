import ui from './ui.module.css';

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'allocation', label: 'Allocation' },
  { id: 'decisions', label: 'Agent decisions' },
  { id: 'position', label: 'Deposit & redeem' },
  { id: 'market', label: 'Market' },
  { id: 'pichi', label: '$PICHI' },
  { id: 'contracts', label: 'Contracts & proofs' },
] as const;

/** In-page navigation across the app's capabilities. */
export function SectionNav() {
  return (
    <nav className={ui.sectionNav} aria-label="App sections">
      {SECTIONS.map((s) => (
        <a key={s.id} href={`#${s.id}`}>
          {s.label}
        </a>
      ))}
    </nav>
  );
}
