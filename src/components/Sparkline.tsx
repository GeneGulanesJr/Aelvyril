interface SparklineProps {
  data?: number[];
  color?: string;
  width?: number;
  height?: number;
}

export function Sparkline({
  data = [30, 45, 35, 50, 40, 60, 55, 70, 65, 80, 75, 90],
  color = "var(--accent-gold)",
  width = 80,
  height = 28,
}: SparklineProps) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;

  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x},${y}`;
  });

  const areaPoints = `0,${height} ${points.join(" ")} ${width},${height}`;

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} className="sparkline">
      <polygon points={areaPoints} fill={color} opacity={0.08} />
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
