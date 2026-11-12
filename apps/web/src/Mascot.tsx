export type Mood = "idle" | "working" | "needs";

/** The assistant, for now a placeholder: a soft orb drawn in code (nothing to download). It breathes when idle; a light runs
    round the halo while a task works; the orb and halo take the "waiting for you" colour and pulse when something needs an
    answer. Swap this file for real art whenever there is some. */
export function Mascot({ mood }: { mood: Mood }) {
  return (
    <svg class="mc" data-mood={mood} viewBox="0 0 240 280" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="mc-orb" cx="38%" cy="32%" r="75%">
          <stop offset="0" style="stop-color: var(--orb-a)" />
          <stop offset="1" style="stop-color: var(--orb-b)" />
        </radialGradient>
      </defs>
      <circle class="mc-ring" cx="120" cy="140" r="96" />
      <circle class="mc-ring mc-ring-a" cx="120" cy="140" r="116" />
      <circle class="mc-halo" cx="120" cy="140" r="116" />
      <ellipse class="mc-shadow" cx="120" cy="238" rx="52" ry="8" />
      <g class="mc-bob">
        <circle class="mc-orb" cx="120" cy="140" r="68" />
      </g>
    </svg>
  );
}
