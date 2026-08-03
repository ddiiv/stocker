export default function StatCard({ label, value, hint, accent = "ink", icon: Icon }) {
  const accentClasses = {
    ink: "bg-ink-950 text-paper-50",
    brass: "bg-brass-500 text-ink-950",
    teal: "bg-teal-500 text-paper-50",
    brick: "bg-brick-500 text-paper-50",
  }[accent];

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-600">{label}</p>
        {Icon && (
          <div className={`flex h-8 w-8 items-center justify-center rounded-md ${accentClasses}`}>
            <Icon size={15} />
          </div>
        )}
      </div>
      <p className="mt-3 font-display text-2xl font-semibold text-ink-950">{value}</p>
      {hint && <p className="mt-1 text-xs text-ink-600">{hint}</p>}
    </div>
  );
}
