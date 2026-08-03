import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { formatCurrency, formatDate } from "../../utils/formatters";

export default function RevenueChart({ data }) {
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#b9852f" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#b9852f" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#e2ddd0" vertical={false} />
          <XAxis
            dataKey="fecha"
            tickFormatter={(v) => formatDate(v).slice(0, 5)}
            tick={{ fontSize: 11, fill: "#7a8099" }}
            axisLine={{ stroke: "#e2ddd0" }}
            tickLine={false}
          />
          <YAxis
            tickFormatter={(v) => `${Math.round(v / 1000)}k`}
            tick={{ fontSize: 11, fill: "#7a8099" }}
            axisLine={false}
            tickLine={false}
            width={40}
          />
          <Tooltip
            formatter={(value) => [formatCurrency(value), "Ingresos"]}
            labelFormatter={(v) => formatDate(v)}
            contentStyle={{ borderRadius: 8, borderColor: "#e2ddd0", fontSize: 12 }}
          />
          <Area type="monotone" dataKey="total" stroke="#966a23" strokeWidth={2} fill="url(#revenueFill)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
