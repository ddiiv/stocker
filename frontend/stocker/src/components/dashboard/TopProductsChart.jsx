import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { formatCurrency } from "../../utils/formatters";

export default function TopProductsChart({ data }) {
  const chartData = [...data].reverse();
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
          <CartesianGrid stroke="#e2ddd0" horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 11, fill: "#7a8099" }} axisLine={false} tickLine={false} />
          <YAxis
            type="category"
            dataKey="titulo"
            width={140}
            tick={{ fontSize: 11, fill: "#232735" }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            formatter={(value, name) => [name === "unidades" ? value : formatCurrency(value), name === "unidades" ? "Unidades vendidas" : "Facturado"]}
            contentStyle={{ borderRadius: 8, borderColor: "#e2ddd0", fontSize: 12 }}
          />
          <Bar dataKey="unidades" fill="#b9852f" radius={[0, 4, 4, 0]} barSize={14} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
