import { useEffect, useState } from "react";

/**
 * Animated counter hook — smoothly interpolates from current to target values
 * using an ease-out cubic easing over the given duration.
 */
export function useAnimatedValues(
  targets: Record<string, number>,
  duration = 600,
) {
  const [values, setValues] = useState<Record<string, number>>(
    () =>
      Object.fromEntries(Object.keys(targets).map((k) => [k, 0])),
  );

  useEffect(() => {
    const start = { ...values };
    const startTime = Date.now();

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const ease = 1 - Math.pow(1 - progress, 3);

      setValues(
        Object.fromEntries(
          Object.keys(targets).map((k) => [
            k,
            Math.round(start[k] + (targets[k] - start[k]) * ease),
          ]),
        ),
      );

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };

    requestAnimationFrame(animate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(targets)]);

  return values;
}
