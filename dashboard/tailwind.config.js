/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f0f7ff", 100: "#e0effe", 200: "#b9dffd", 300: "#7cc5fc",
          400: "#36a8f8", 500: "#0c8ce9", 600: "#006ec7", 700: "#0058a2",
          800: "#054b85", 900: "#0a3f6e",
        },
        surface: {
          50: "#f8fafc", 100: "#f1f5f9", 200: "#e2e8f0", 300: "#cbd5e1",
          400: "#94a3b8", 500: "#64748b", 600: "#475569", 700: "#334155",
          800: "#1e293b", 900: "#0f172a", 950: "#020617",
        },
      },
    },
  },
  plugins: [],
};
