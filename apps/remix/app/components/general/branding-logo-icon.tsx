import type { SVGAttributes } from 'react';

export type LogoProps = SVGAttributes<SVGSVGElement>;

export const BrandingLogoIcon = ({ ...props }: LogoProps) => {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Solid Ten Sign" {...props}>
      <rect x="1" y="3" width="28" height="28" rx="8" className="fill-[#0b1941] dark:fill-white" /><path d="M8.5 12.5l3-2v12" fill="none" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="stroke-white dark:stroke-[#0b1941]" /><rect x="15.5" y="10.5" width="7.5" height="12" rx="3.75" fill="none" strokeWidth="2.4" className="stroke-white dark:stroke-[#0b1941]" /><circle cx="27" cy="5" r="4.2" fill="#005a9c" strokeWidth="2" className="stroke-white dark:stroke-[#060f2b]" />
    </svg>
  );
};
