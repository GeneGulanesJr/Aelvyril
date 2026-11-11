// Small drawn icons, one stroke weight. Decorative: the button text carries the name.
const base = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.75, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": true, class: "icon" } as const;

/** Settings: three sliders, like heddles on a loom. */
export const IconSettings = () => (
  <svg {...base}>
    <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
    <path d="M15 4v4M9 10v4M17 16v4" />
  </svg>
);

export const IconBack = () => (
  <svg {...base}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </svg>
);

export const IconLeave = () => (
  <svg {...base}>
    <path d="M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 8l-4 4 4 4M6 12h10" />
  </svg>
);

export const IconClose = () => (
  <svg {...base} width={16} height={16}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const IconArrow = () => (
  <svg {...base} width={16} height={16}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

/** The drag handle: two rows of running stitches. */
export const IconGrip = () => (
  <svg {...base} width={16} height={16} stroke-width={2.4}>
    <path d="M9 6h.5M14.5 6h.5M9 12h.5M14.5 12h.5M9 18h.5M14.5 18h.5" />
  </svg>
);

/** Move earlier / later. Points left and right; turned upright when the cards stack in one column. */
export const IconEarlier = () => (
  <svg {...base} width={16} height={16} class="icon icon-move">
    <path d="M15 6l-6 6 6 6" />
  </svg>
);

export const IconLater = () => (
  <svg {...base} width={16} height={16} class="icon icon-move">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

/** Fold / unfold a card. */
export const IconFold = () => (
  <svg {...base} width={16} height={16} class="icon icon-fold">
    <path d="M6 9l6 6 6-6" />
  </svg>
);
