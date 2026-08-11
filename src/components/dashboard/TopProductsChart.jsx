import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Rectangle } from "recharts";

export default function TopProductsChart({ data }) {
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#e2ddd0" vertical={false} />
          <XAxis
            dataKey="titulo"
            tick={{ fontSize: 10, fill: "#7a8099" }}
            axisLine={{ stroke: "#e2ddd0" }}
            tickLine={false}
            interval={0}
            angle={-35}
            textAnchor="end"
            height={60}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "#7a8099" }}
            axisLine={false}
            tickLine={false}
            width={35}
          />
          <Tooltip
            formatter={(value) => [value, "Unidades"]}
            contentStyle={{ borderRadius: 8, borderColor: "#e2ddd0", fontSize: 12 }}
          />
          <Bar
            dataKey="unidades"
            fill="#b9852f"
            isAnimationActive={false}
            activeBar={<Rectangle fill="#966a23" />}
            inactiveBar={<Rectangle fill="#b9852f" />}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
