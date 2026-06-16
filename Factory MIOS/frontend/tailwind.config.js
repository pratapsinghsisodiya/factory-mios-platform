/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: "#0ea5e9", dark: "#0369a1" },
        ink: "#0f172a",
      },
    },
  },
  plugins: [],
};
