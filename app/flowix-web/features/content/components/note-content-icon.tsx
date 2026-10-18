import type { SVGProps } from 'react';

/** Default note glyph shared by ContentIcon and the legacy Memo icon export. */
export function NoteContentIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 18 18" fill="none" aria-hidden="true" {...props}>
      <g transform="matrix(0.6923077 0 0 0.6923077 0.6923077 0.6923077)">
        <line x1="7.6666" y1="11.36" x2="10.3333" y2="11.36" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
        <line x1="7.6666" y1="15.18" x2="16.3333" y2="15.18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
        <path d="M3.6667 19V5c0-1.4733 1.1933-2.6667 2.6667-2.6667h7.448c.3533 0 .6933.14.9427.3907l5.2187 5.2187c.2507.2507.3907.5893.3907.9427v10.1146c0 1.4733-1.1933 2.6667-2.6667 2.6667H6.3333c-1.4733 0-2.6666-1.1934-2.6666-2.6667Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
        <path d="M20.2133 8.3333h-4.5467c-.736 0-1.3333-.5973-1.3333-1.3333V2.4693" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      </g>
    </svg>
  );
}
