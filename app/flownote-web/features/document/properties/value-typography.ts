import { createContext, useContext, type CSSProperties } from 'react';

/** Carries cell typography through portaled property editors. */
export const PropertyValueTypographyContext = createContext<CSSProperties | undefined>(undefined);

export function propertyValueTypography(baseFontSize: string): CSSProperties {
  return {
    '--property-value-base-font-size': baseFontSize,
    '--property-value-font-size': `calc(${baseFontSize} * var(--document-tag-font-scale, 0.875))`,
  } as CSSProperties;
}

export function usePropertyValueTypography() {
  return useContext(PropertyValueTypographyContext);
}
