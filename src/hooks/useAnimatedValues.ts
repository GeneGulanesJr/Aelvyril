import { useEffect, useState } from "react";

/**
 * Animated counter hook — smoothly interpolates from current to target values
 * using an ease-out cubic easing over the given duration.
 */
export function useAnimatedValues<T extends Record<string, number>>(
  targets: T,
  duration = 600,
): T {
  const [values, setValues] = useState<T>(() => {
    return Object.fromEntries(Object.keys(targets).map((k) => [k, 0])) as T;
  });

  useEffect(() => {
    const start: Record<string, number> = { ...values };
    const startTime = Date.now();

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const ease = 1 - Math.pow(1 - progress, 3);

      setValues(() => {
        return Object.fromEntries(
          Object.keys(targets).map((k) => [
            k,
            Math.round((start[k] ?? 0) + ((targets[k] ?? 0) - (start[k] ?? 0)) * ease),
          ]),
        ) as T;
      });

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };

    requestAnimationFrame(animate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(targets)]);

  return values;
}
