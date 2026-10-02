export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#0f6e6e" />
      <path d="M10 9c0 0-2 4 0 9s4 6 6 6 4-1 6-6 0-9 0-9c-2-1-4 1-6 1s-4-2-6-1z" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx="13" cy="15" r="1.3" fill="#9fe0d9" />
      <circle cx="18" cy="13" r="1" fill="#9fe0d9" />
      <circle cx="18.5" cy="17.5" r="1.4" fill="#9fe0d9" />
    </svg>
  );
}
