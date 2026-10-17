interface SkeletonProps {
  rows?: number;
  className?: string;
}

export function SkeletonRows({ rows = 4, className = "" }: SkeletonProps) {
  return (
    <div aria-hidden="true" className={className}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="rule-y py-3">
          <div className="h-4 bg-rule/60" style={{ width: `${85 - (index % 3) * 15}%` }} />
        </div>
      ))}
    </div>
  );
}

export function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`rule-y py-3 ${className}`} />;
}
